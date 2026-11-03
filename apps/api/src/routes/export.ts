import { type Db, schema } from "@findme/db";
import { desc } from "drizzle-orm";
import { Hono } from "hono";

// M-S2 数据导出:全部记录 + 抽取 + 洞察,一个 JSON 带走。"随时带走,全部归你"。
export function exportRoutes(db: Db) {
  const r = new Hono();

  r.get("/", async (c) => {
    const [records, extracts, insights] = await Promise.all([
      db.select().from(schema.rawRecords).orderBy(desc(schema.rawRecords.createdAt)),
      db.select().from(schema.lightExtracts).orderBy(desc(schema.lightExtracts.extractedAt)),
      db.select().from(schema.insights).orderBy(desc(schema.insights.generatedAt)),
    ]);
    c.header("content-disposition", 'attachment; filename="findme-export.json"');
    return c.json({
      exported_at: new Date().toISOString(),
      counts: { records: records.length, extracts: extracts.length, insights: insights.length },
      records,
      light_extracts: extracts,
      insights,
    });
  });

  return r;
}
