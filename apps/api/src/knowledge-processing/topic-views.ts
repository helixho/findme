import type { KnowledgeProcessingRecord } from "@findme/core";
import { and, desc, eq } from "drizzle-orm";
import type { PersonalContext } from "../core/exploration-service.js";
import { currentView } from "./current-view.js";
import { sanitizeHistoricalRecord } from "./history-view.js";
import type { KnowledgeDb } from "./repository.js";
import { knowledgeTable, latest, recordFromRow } from "./repository.js";

export async function listKnowledgeTopics(db: KnowledgeDb, ctx: PersonalContext) {
  const rows = await db
    .select({ payload: knowledgeTable.payload })
    .from(knowledgeTable)
    .where(
      and(eq(knowledgeTable.tenantId, ctx.tenantId), eq(knowledgeTable.subjectId, ctx.subjectId)),
    )
    .orderBy(desc(knowledgeTable.version));
  const current = new Map<string, KnowledgeProcessingRecord>();
  for (const row of rows) {
    const record = recordFromRow(row);
    if (!current.has(record.topic_key)) current.set(record.topic_key, record);
  }
  return Promise.all(
    [...current.values()]
      .sort((a, b) => a.topic_key.localeCompare(b.topic_key))
      .map((record) => currentView(db, ctx, record)),
  );
}

export async function getKnowledgeTopic(db: KnowledgeDb, ctx: PersonalContext, topicKey: string) {
  const record = await latest(db, ctx, topicKey);
  return record ? currentView(db, ctx, record) : undefined;
}

export async function getKnowledgeTopicVersions(
  db: KnowledgeDb,
  ctx: PersonalContext,
  topicKey: string,
) {
  const rows = await db
    .select({ payload: knowledgeTable.payload })
    .from(knowledgeTable)
    .where(
      and(
        eq(knowledgeTable.tenantId, ctx.tenantId),
        eq(knowledgeTable.subjectId, ctx.subjectId),
        eq(knowledgeTable.topicKey, topicKey),
      ),
    )
    .orderBy(desc(knowledgeTable.version));
  const records = rows.map(recordFromRow);
  const newest = records[0];
  if (newest) records[0] = await currentView(db, ctx, newest);
  return Promise.all(
    records.map(async (record, index) => ({
      ...(index === 0 ? record : await sanitizeHistoricalRecord(db, ctx, record)),
      is_current: index === 0,
    })),
  );
}
