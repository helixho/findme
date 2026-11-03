import { type Db, schema } from "@findme/db";
import { desc } from "drizzle-orm";
import { Hono } from "hono";

// M-O2 回顾(事实层):从 light_extracts 的主题/标签算"常想到"频率。无 LLM。
export function reviewRoutes(db: Db) {
  const r = new Hono();

  r.get("/themes", async (c) => {
    const exts = await db
      .select({ topics: schema.lightExtracts.topics, tags: schema.lightExtracts.userTags })
      .from(schema.lightExtracts)
      .orderBy(desc(schema.lightExtracts.extractedAt))
      .limit(500);
    const counts = new Map<string, number>();
    for (const e of exts) {
      for (const t of [...(e.topics ?? []), ...(e.tags ?? [])]) {
        const k = t.trim();
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const themes = [...counts.entries()]
      .map(([theme, count]) => ({ theme, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    return c.json({ themes, recordCount: exts.length });
  });

  return r;
}
