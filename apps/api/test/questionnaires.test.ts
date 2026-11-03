import { createDb, schema } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedQuestionnaires } from "../src/seed/questionnaires.js";
import { authedApp as createApp } from "./helper.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);
const app = createApp({ accessToken: "t", db });
const headers = { "content-type": "application/json" };

beforeEach(async () => {
  await db.delete(schema.asyncTasks);
  await db.delete(schema.lightExtracts);
  await db.delete(schema.rawRecords);
  await db.delete(schema.questionItems);
  await db.delete(schema.questionnaires);
});
afterAll(async () => {
  await sql.end();
});

describe("M-A2 题库 + 作答", () => {
  it("种子 idempotent;GET 返回题组与题目", async () => {
    const n1 = await seedQuestionnaires(db);
    expect(n1).toBeGreaterThan(0);
    const n2 = await seedQuestionnaires(db);
    expect(n2).toBe(0); // 已存在跳过

    const res = await app.request("/api/questionnaires");
    expect(res.status).toBe(200);
    const { questionnaires } = await res.json();
    expect(questionnaires.length).toBeGreaterThan(0);
    expect(questionnaires[0].items.length).toBeGreaterThan(0);
    expect(questionnaires[0].items[0]).toHaveProperty("prompt");
    expect(questionnaires.map((q: { name: string }) => q.name)).toEqual(
      expect.arrayContaining([
        "情绪比事件更大时",
        "我正在替谁扛课题",
        "我如何靠近和退开",
        "我在哪些事上反复回避",
        "我对自己的旧规则",
      ]),
    );
    const theory = questionnaires.find((q: { name: string }) => q.name === "情绪比事件更大时");
    expect(theory).toMatchObject({
      source: "想法如何制造情绪:认知的 ABC",
      domain: "我如何理解情绪",
      lens: "CBT",
    });
    expect(theory.intro).toContain("事件");
  });

  it("作答→存 questionnaire_response + 来源上下文 + 入队 extract", async () => {
    await seedQuestionnaires(db);
    const { questionnaires } = await (await app.request("/api/questionnaires")).json();
    const qn = questionnaires.find((q: { name: string }) => q.name === "情绪比事件更大时");
    expect(qn).toBeTruthy();

    const res = await app.request("/api/questionnaires/respond", {
      method: "POST",
      headers,
      body: JSON.stringify({
        questionnaire_id: qn.id,
        summary: "回看一个片刻:重新听一次;常停在心里:工作",
        answers: [{ prompt: "如果今天可以重来一个片刻", answer: "重新听一次" }],
      }),
    });
    expect(res.status).toBe(201);
    const recs = await db.select().from(schema.rawRecords);
    expect(recs.length).toBe(1);
    expect(recs[0]?.sourceType).toBe("questionnaire_response");
    const content = recs[0]?.content as { text?: string; questionnaire_name?: string };
    expect(content.text).toContain("题组《情绪比事件更大时》");
    expect(content.text).toContain("视角:CBT");
    expect(content.questionnaire_name).toBe("情绪比事件更大时");
    const sourceMeta = recs[0]?.sourceMeta as {
      questionnaire_name?: string;
      material_title?: string;
      domain?: string;
      lens?: string;
      source_id?: string;
      evidence_refs?: string[];
    };
    expect(sourceMeta).toMatchObject({
      questionnaire_name: "情绪比事件更大时",
      material_title: "想法如何制造情绪:认知的 ABC",
      domain: "我如何理解情绪",
      lens: "CBT",
    });
    const tasks = await db.select().from(schema.asyncTasks);
    expect(tasks.length).toBe(1);
  });

  it("重复 seed 会更新已有题组的题目与 corpus provenance", async () => {
    const first = [
      {
        name: "语料题组",
        type: "theory",
        source: "语料卡",
        domain: "我如何做选择",
        lens: "斯多葛主义",
        intro: "旧 intro",
        sourceId: "stoicism_epictetus_gutenberg",
        sourceUrl: "https://www.gutenberg.org/ebooks/45109",
        licenseStatus: "public_domain" as const,
        usableScope: "full_text_local_allowed",
        evidenceRefs: ["ch001#ck001"],
        reviewStatus: "content_ready" as const,
        items: [{ prompt: "旧问题?", format: "free_text" as const, options: [] }],
      },
    ];
    const second = [
      {
        ...first[0],
        intro: "新 intro",
        items: [
          { itemKey: "q1", prompt: "新问题 1?", format: "free_text" as const, options: [] },
          {
            itemKey: "q2",
            prompt: "新问题 2?",
            format: "single_choice" as const,
            options: ["A", "B"],
          },
        ],
      },
    ];

    expect(await seedQuestionnaires(db, first)).toBe(1);
    expect(await seedQuestionnaires(db, second)).toBe(0);
    const { questionnaires } = await (await app.request("/api/questionnaires")).json();
    const qn = questionnaires.find((q: { name: string }) => q.name === "语料题组");
    expect(qn).toMatchObject({
      intro: "新 intro",
      source_id: "stoicism_epictetus_gutenberg",
      license_status: "public_domain",
      evidence_refs: ["ch001#ck001"],
    });
    expect(qn.items.map((i: { prompt: string }) => i.prompt)).toEqual(["新问题 1?", "新问题 2?"]);
  });
});
