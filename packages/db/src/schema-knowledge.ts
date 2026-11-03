import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { subjects } from "./schema-core";

const ownerPolicy = (name: string, tenantId: AnyPgColumn, subjectId: AnyPgColumn) => {
  const allowed = sql`${tenantId}::text = current_setting('app.tenant_id', true) and ${subjectId}::text = current_setting('app.subject_id', true)`;
  return pgPolicy(name, { for: "all", to: "public", using: allowed, withCheck: allowed });
};
export const knowledgeProcessingRecords = pgTable(
  "knowledge_processing_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    topicKey: text("topic_key").notNull(),
    version: integer("version").notNull(),
    recordType: text("record_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    subject: foreignKey({
      name: "knowledge_processing_subject_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    uniqueTopicVersion: uniqueIndex("knowledge_processing_topic_version_unique").on(
      t.tenantId,
      t.subjectId,
      t.topicKey,
      t.version,
    ),
    byTopic: index("knowledge_processing_topic_idx").on(
      t.tenantId,
      t.subjectId,
      t.topicKey,
      t.createdAt,
    ),
    versionCheck: check("knowledge_processing_version_check", sql`${t.version} > 0`),
    typeCheck: check(
      "knowledge_processing_type_check",
      sql`${t.recordType} in ('topic_result','feedback')`,
    ),
    scopePolicy: ownerPolicy("knowledge_processing_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
