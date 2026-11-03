import { createDb, schema } from "@findme/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedMaterials } from "../src/seed/materials.js";
import { authedApp as createApp } from "./helper.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);
const app = createApp({ accessToken: "t", db });
const headers = { "content-type": "application/json" };

beforeEach(async () => {
  await db.delete(schema.asyncTasks);
  await db.delete(schema.lightExtracts);
  await db.delete(schema.rawRecords);
  await db.delete(schema.staticMaterials);
});
afterAll(async () => {
  await sql.end();
});

describe("M-B0 学习素材 + 阅读反馈", () => {
  it("种子按 title 补缺(幂等);GET 返回 3 栏目 24 篇 + 触发器字段", async () => {
    expect(await seedMaterials(db)).toBe(24);
    expect(await seedMaterials(db)).toBe(0);
    const { items } = await (await app.request("/api/materials")).json();
    expect(items.length).toBe(24);
    expect(new Set(items.map((m: { type: string }) => m.type))).toEqual(
      new Set(["concept", "figure", "book"]),
    );
    expect(items.every((m: { reflect?: string }) => !!m.reflect)).toBe(true);
    expect(
      items.every(
        (m: {
          domain?: string;
          lens?: string;
          confidence?: string;
          hook?: string;
          boundary?: string;
          reflect_prompts?: string[];
          entry_prompt?: string;
          linked_questionnaires?: string[];
        }) =>
          !!m.domain &&
          !!m.lens &&
          !!m.confidence &&
          !!m.hook &&
          !!m.boundary &&
          Array.isArray(m.reflect_prompts) &&
          m.reflect_prompts.length > 0 &&
          !!m.entry_prompt &&
          Array.isArray(m.linked_questionnaires),
      ),
    ).toBe(true);
    // 导读类文章带原文出处(URL 已清理跟踪参数)
    const sourced = items.filter((m: { source_url?: string | null }) => m.source_url);
    expect(sourced.length).toBeGreaterThanOrEqual(3);
    expect(sourced.every((m: { source_url: string }) => !m.source_url.includes("utm_"))).toBe(true);
  });

  it("种子 upsert:改正文后重启即生效", async () => {
    await seedMaterials(db);
    await db
      .update(schema.staticMaterials)
      .set({ body: "旧正文" })
      .where(eq(schema.staticMaterials.title, "汉明:你和你的研究"));
    await seedMaterials(db); // 再跑应把正文改回种子版本
    const [m] = await db
      .select()
      .from(schema.staticMaterials)
      .where(eq(schema.staticMaterials.title, "汉明:你和你的研究"));
    expect(m?.body).not.toBe("旧正文");
  });

  it("反馈→raw_record 带素材标题关联 + 入队 extract", async () => {
    await seedMaterials(db);
    const { items } = await (await app.request("/api/materials")).json();
    const res = await app.request(`/api/materials/${items[0].id}/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reaction: "resonate", note: "想到了上周的一次对话" }),
    });
    expect(res.status).toBe(201);
    const [rec] = await db.select().from(schema.rawRecords);
    expect(rec?.sourceType).toBe("material_feedback");
    const text = (rec?.content as { text: string }).text;
    expect(text).toContain(items[0].title); // 反馈语料携带「读了什么」
    expect(text).toContain("有共鸣");
    const sourceMeta = rec?.sourceMeta as {
      material_title?: string;
      domain?: string;
      lens?: string;
      confidence?: string;
      entry_prompt?: string;
      source_id?: string;
      license_status?: string;
      evidence_refs?: string[];
    };
    expect(sourceMeta.material_title).toBe(items[0].title);
    expect(sourceMeta.domain).toBe(items[0].domain);
    expect(sourceMeta.lens).toBe(items[0].lens);
    expect(sourceMeta.confidence).toBe(items[0].confidence);
    expect(sourceMeta.entry_prompt).toBe(items[0].entry_prompt);
    expect((await db.select().from(schema.asyncTasks)).length).toBe(1);
  });

  it("corpus seed provenance 会出现在素材 API 与反馈语料 sourceMeta", async () => {
    await seedMaterials(db, [
      {
        type: "concept",
        title: "语料卡:控制与判断",
        body: "测试正文",
        domain: "我如何理解情绪",
        lens: "斯多葛主义",
        confidence: "philosophy_lens",
        hook: "什么在我控制内?",
        boundary: "哲学视角,不是诊断。",
        reflect: "这件事里什么在我控制内?",
        reflectPrompts: ["这件事里什么在我控制内?"],
        entryPrompt: "这让我想到……",
        sourceId: "stoicism_epictetus_gutenberg",
        sourceUrl: "https://www.gutenberg.org/ebooks/45109",
        licenseStatus: "public_domain",
        usableScope: "full_text_local_allowed",
        evidenceRefs: ["ch001#ck001"],
        reviewStatus: "content_ready",
      },
    ]);
    const { items } = await (await app.request("/api/materials")).json();
    expect(items[0]).toMatchObject({
      source_id: "stoicism_epictetus_gutenberg",
      license_status: "public_domain",
      review_status: "content_ready",
    });
    expect(items[0].evidence_refs).toEqual(["ch001#ck001"]);

    const res = await app.request(`/api/materials/${items[0].id}/feedback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reaction: "more", note: "我想继续看这个角度" }),
    });
    expect(res.status).toBe(201);
    const [rec] = await db.select().from(schema.rawRecords);
    const sourceMeta = rec?.sourceMeta as {
      source_id?: string;
      license_status?: string;
      evidence_refs?: string[];
      review_status?: string;
    };
    expect(sourceMeta).toMatchObject({
      source_id: "stoicism_epictetus_gutenberg",
      license_status: "public_domain",
      evidence_refs: ["ch001#ck001"],
      review_status: "content_ready",
    });
  });

  it("素材不存在→404", async () => {
    const res = await app.request("/api/materials/00000000-0000-0000-0000-000000000000/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ reaction: "neutral" }),
    });
    expect(res.status).toBe(404);
  });
});
