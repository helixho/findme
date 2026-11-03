import { createDb, schema } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authedApp as createApp } from "./helper.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);
const app = createApp({ accessToken: "t", db });

beforeEach(async () => {
  await db.delete(schema.insights);
  await db.delete(schema.lightExtracts);
  await db.delete(schema.rawRecords);
});
afterAll(async () => {
  await sql.end();
});

describe("GET /api/export(M-S2)", () => {
  it("导出记录+抽取+洞察 JSON,带下载头", async () => {
    await db
      .insert(schema.rawRecords)
      .values({ sourceType: "quick_note", content: { text: "导出测试" } });
    const res = await app.request("/api/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("findme-export.json");
    const body = await res.json();
    expect(body.counts.records).toBe(1);
    expect(body.records[0].content.text).toBe("导出测试");
    expect(body).toHaveProperty("light_extracts");
    expect(body).toHaveProperty("insights");
  });
});
