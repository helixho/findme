import { createDb, schema } from "@findme/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isReferencedByInsight } from "../src/data/delete-guard.js";

const url = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:dev@localhost:5434/findme_test";
const { db, sql } = createDb(url);

beforeEach(async () => {
  await db.delete(schema.insights);
});
afterAll(async () => {
  await sql.end();
});

describe("legacy insight reference guard / real PostgreSQL integration", () => {
  it("被 Insight 引用的 L1 id 返回 true", async () => {
    const rid = "11111111-1111-1111-1111-111111111111";
    await db.insert(schema.insights).values({
      insightType: "frequency",
      content: "x",
      evidenceRefs: { l1_record_ids: [rid] },
    });
    expect(await isReferencedByInsight(db, rid)).toBe(true);
  });
  it("未被引用返回 false", async () => {
    expect(await isReferencedByInsight(db, "22222222-2222-2222-2222-222222222222")).toBe(false);
  });
});
