import {
  type KnowledgeProcessingRecord,
  KnowledgeProcessingRecord as KnowledgeProcessingRecordSchema,
} from "@findme/core";
import { type Db, knowledgeSchema } from "@findme/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";

export type KnowledgeDb = Pick<Db, "select" | "insert" | "execute">;

export const knowledgeTable = knowledgeSchema.knowledgeProcessingRecords;

export function recordFromRow(row: { payload: unknown }): KnowledgeProcessingRecord {
  return KnowledgeProcessingRecordSchema.parse(row.payload);
}

export async function latest(db: KnowledgeDb, ctx: PersonalContext, topicKey: string) {
  const [row] = await db
    .select({ payload: knowledgeTable.payload })
    .from(knowledgeTable)
    .where(
      and(
        eq(knowledgeTable.tenantId, ctx.tenantId),
        eq(knowledgeTable.subjectId, ctx.subjectId),
        eq(knowledgeTable.topicKey, topicKey),
      ),
    )
    .orderBy(desc(knowledgeTable.version))
    .limit(1);
  return row ? recordFromRow(row) : undefined;
}

export async function append(
  db: KnowledgeDb,
  ctx: PersonalContext,
  record: KnowledgeProcessingRecord,
) {
  await db.insert(knowledgeTable).values({
    tenantId: ctx.tenantId,
    subjectId: ctx.subjectId,
    topicKey: record.topic_key,
    version: record.version,
    recordType: record.record_type,
    payload: record,
  });
  return record;
}

export async function lockProfileKnowledge(db: KnowledgeDb, ctx: PersonalContext) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
      ctx.tenantId,
      ctx.subjectId,
      "knowledge-feedback",
    ])}, 0))`,
  );
}
