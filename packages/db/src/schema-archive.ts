import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { subjects, tenants } from "./schema-core.js";

// Opaque archival bytes, not personal claims. JSON export uses PostgreSQL bytea hex.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const processedBatches = pgTable(
  "av_processed_batches",
  {
    tenantId: uuid("tenant_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    namespace: text("namespace").notNull(),
    batchHash: text("batch_hash").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    status: text("status").default("staging").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: "av_processed_batches_pkey",
      columns: [t.tenantId, t.subjectId, t.namespace, t.batchHash],
    }),
    foreignKey({
      name: "av_processed_batches_tenant_fk",
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }),
    foreignKey({
      name: "av_processed_batches_subject_fk",
      columns: [t.subjectId],
      foreignColumns: [subjects.id],
    }),
    check("av_processed_batches_batch_hash_check", sql`${t.batchHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "av_processed_batches_manifest_check",
      sql`${t.manifest}->>'format'='findme-av-processed-archive@2'`,
    ),
    check("av_processed_batches_status_check", sql`${t.status} IN ('staging','complete')`),
  ],
);
export const processedChunks = pgTable(
  "av_processed_chunks",
  {
    tenantId: uuid("tenant_id").notNull(),
    subjectId: uuid("subject_id").notNull(),
    namespace: text("namespace").notNull(),
    batchHash: text("batch_hash").notNull(),
    artifactHash: text("artifact_hash").notNull(),
    part: integer("part").notNull(),
    partHash: text("part_hash").notNull(),
    payload: bytea("payload").notNull(),
  },
  (t) => [
    primaryKey({
      name: "av_processed_chunks_pkey",
      columns: [t.tenantId, t.subjectId, t.namespace, t.batchHash, t.artifactHash, t.part],
    }),
    foreignKey({
      name: "av_processed_chunks_batch_fk",
      columns: [t.tenantId, t.subjectId, t.namespace, t.batchHash],
      foreignColumns: [
        processedBatches.tenantId,
        processedBatches.subjectId,
        processedBatches.namespace,
        processedBatches.batchHash,
      ],
    }),
    check("av_processed_chunks_artifact_hash_check", sql`${t.artifactHash} ~ '^[a-f0-9]{64}$'`),
    check("av_processed_chunks_part_check", sql`${t.part}>=0`),
    check("av_processed_chunks_part_hash_check", sql`${t.partHash} ~ '^[a-f0-9]{64}$'`),
    check("av_processed_chunks_payload_check", sql`octet_length(${t.payload})<=196608`),
    check("av_processed_chunks_check", sql`encode(sha256(${t.payload}),'hex')=${t.partHash}`),
  ],
);
