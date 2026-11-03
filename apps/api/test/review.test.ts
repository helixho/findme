import { createDb, schema } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authedApp as createApp } from "./helper.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);
const app = createApp({ accessToken: "t", db });

async function seedExtract(topics: string[], tags: string[]) {
  const [rec] = await db
    .insert(schema.rawRecords)
    .values({ sourceType: "quick_note", content: { text: "x" } })
    .returning();
  if (!rec) throw new Error("seed 失败");
  await db.insert(schema.lightExtracts).values({
    sourceRecordId: rec.id,
    topics,
    emotionHints: [],
    mentionedObjects: [],
    userTags: tags,
    evidenceSnippets: ["片段"],
    confidence: 0.8,
    extractionVersion: "extract_agent@v1",
  });
}

beforeEach(async () => {
  await db.delete(schema.lightExtracts);
  await db.delete(schema.rawRecords);
});
afterAll(async () => {
  await sql.end();
});

describe("GET /api/review/themes(M-O2 主题频率)", () => {
  it("按频率聚合主题/标签", async () => {
    await seedExtract(["工作", "边界"], ["审计"]);
    await seedExtract(["工作", "睡眠"], []);
    await seedExtract(["工作"], ["审计"]);
    const res = await app.request("/api/review/themes");
    expect(res.status).toBe(200);
    const { themes, recordCount } = await res.json();
    expect(recordCount).toBe(3);
    expect(themes[0]).toEqual({ theme: "工作", count: 3 });
    const map: Record<string, number> = Object.fromEntries(
      themes.map((t: { theme: string; count: number }) => [t.theme, t.count]),
    );
    expect(map.审计).toBe(2);
  });
  it("空库→空主题", async () => {
    const res = await app.request("/api/review/themes");
    const { themes, recordCount } = await res.json();
    expect(recordCount).toBe(0);
    expect(themes.length).toBe(0);
  });
});
