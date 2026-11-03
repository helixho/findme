import type { Db } from "@findme/db";
import { sql as dsql } from "drizzle-orm";

// B2:整列 JSONB 包含查询,命中整列 GIN 索引 idx_insights_evidence_gin
//（用 evidence_refs @> {...} 而非 evidence_refs->'l1_record_ids' @> ...,后者无法走该列索引)
export async function isReferencedByInsight(db: Db, recordId: string): Promise<boolean> {
  const rows = await db.execute(dsql`
    SELECT 1 FROM insights
    WHERE evidence_refs @> ${JSON.stringify({ l1_record_ids: [recordId] })}::jsonb
    LIMIT 1;
  `);
  // postgres-js 驱动:execute 直接返回行数组(兼容 node-postgres 的 {rows} 形状)
  const list = Array.isArray(rows)
    ? (rows as unknown[])
    : ((rows as unknown as { rows?: unknown[] }).rows ?? []);
  return list.length > 0;
}
