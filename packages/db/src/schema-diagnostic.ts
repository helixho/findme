import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
// Extensionless schema import supports the pinned drizzle-kit CJS loader (Bundler resolution).
import { evidenceSpans, sourceAssessments, sourceItems, subjects } from "./schema-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const scope = () => ({
  tenantId: uuid("tenant_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
});
const ownerPolicy = (name: string, tenantId: AnyPgColumn, subjectId: AnyPgColumn) => {
  const matches = sql`${tenantId}::text = current_setting('app.tenant_id', true)
    and ${subjectId}::text = current_setting('app.subject_id', true)`;
  return pgPolicy(name, { for: "all", to: "public", using: matches, withCheck: matches });
};

export const diagnosticRuns = pgTable(
  "diagnostic_runs",
  {
    id: id(),
    ...scope(),
    domain: text("domain").notNull(),
    question: text("question").notNull(),
    status: text("status").default("awaiting_input").notNull(),
    version: integer("version").default(1).notNull(),
    headVersion: integer("head_version").default(0).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopePolicy: ownerPolicy("diag_run_scope", t.tenantId, t.subjectId),
    owner: foreignKey({
      name: "diag_run_owner_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    scopedId: uniqueIndex("diagnostic_runs_scope_id").on(t.tenantId, t.subjectId, t.id),
    once: uniqueIndex("diagnostic_runs_idempotency").on(t.tenantId, t.subjectId, t.idempotencyKey),
    byOwner: index("diagnostic_runs_owner_updated").on(t.tenantId, t.subjectId, t.updatedAt),
    versions: check("diagnostic_runs_versions", sql`${t.version} > 0 and ${t.headVersion} >= 0`),
    states: check(
      "diagnostic_runs_states",
      sql`${t.status} in ('awaiting_input','pending','review_pending','ready','needs_review','archived')`,
    ),
  }),
).enableRLS();

export const diagnosticReportRevisions = pgTable(
  "diagnostic_report_revisions",
  {
    id: id(),
    ...scope(),
    runId: uuid("run_id").notNull(),
    version: integer("version").notNull(),
    basisVersion: integer("basis_version").notNull(),
    jobId: uuid("job_id"),
    status: text("status").default("candidate").notNull(),
    format: text("format").default("understanding-report@1").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    contentHash: text("content_hash").notNull(),
    inputHash: text("input_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    scopePolicy: ownerPolicy("diag_rev_scope", t.tenantId, t.subjectId),
    job: uniqueIndex("diagnostic_reports_job_once").on(t.jobId),
    run: foreignKey({
      name: "diag_rev_run_fk",
      columns: [t.tenantId, t.subjectId, t.runId],
      foreignColumns: [diagnosticRuns.tenantId, diagnosticRuns.subjectId, diagnosticRuns.id],
    }),
    scopedId: uniqueIndex("diagnostic_reports_scope_id").on(t.tenantId, t.subjectId, t.id),
    version: uniqueIndex("diagnostic_reports_run_version").on(
      t.tenantId,
      t.subjectId,
      t.runId,
      t.version,
    ),
    states: check(
      "diagnostic_reports_states",
      sql`${t.status} in ('candidate','accepted','rejected','needs_review','withdrawn')`,
    ),
    versions: check("diagnostic_reports_versions", sql`${t.version} > 0 and ${t.basisVersion} > 0`),
  }),
).enableRLS();

export const diagnosticReportSources = pgTable(
  "diagnostic_report_sources",
  {
    id: id(),
    ...scope(),
    reportRevisionId: uuid("report_revision_id").notNull(),
    evidenceId: text("evidence_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    spanId: uuid("span_id").notNull(),
    assessmentVersion: integer("assessment_version").notNull(),
    sourceHash: text("source_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    scopePolicy: ownerPolicy("diag_ref_scope", t.tenantId, t.subjectId),
    report: foreignKey({
      name: "diag_ref_report_fk",
      columns: [t.tenantId, t.subjectId, t.reportRevisionId],
      foreignColumns: [
        diagnosticReportRevisions.tenantId,
        diagnosticReportRevisions.subjectId,
        diagnosticReportRevisions.id,
      ],
    }),
    source: foreignKey({
      name: "diag_ref_source_fk",
      columns: [t.tenantId, t.subjectId, t.sourceId],
      foreignColumns: [sourceItems.tenantId, sourceItems.subjectId, sourceItems.id],
    }),
    span: foreignKey({
      name: "diag_ref_span_fk",
      columns: [t.sourceId, t.spanId],
      foreignColumns: [evidenceSpans.sourceItemId, evidenceSpans.id],
    }),
    assessment: foreignKey({
      name: "diag_ref_assessment_fk",
      columns: [t.sourceId, t.assessmentVersion],
      foreignColumns: [sourceAssessments.sourceItemId, sourceAssessments.version],
    }),
    once: uniqueIndex("diagnostic_report_evidence_unique").on(t.reportRevisionId, t.evidenceId),
    bySource: index("diagnostic_report_source_dependencies").on(
      t.tenantId,
      t.subjectId,
      t.sourceId,
    ),
  }),
).enableRLS();

export const diagnosticResponses = pgTable(
  "diagnostic_responses",
  {
    id: id(),
    ...scope(),
    runId: uuid("run_id").notNull(),
    reportRevisionId: uuid("report_revision_id"),
    sourceId: uuid("source_id"),
    kind: text("kind").notNull(),
    note: text("note").notNull(),
    basisVersion: integer("basis_version").notNull(),
    resultVersion: integer("result_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    processingStatus: text("processing_status").default("recorded").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    scopePolicy: ownerPolicy("diag_response_scope", t.tenantId, t.subjectId),
    run: foreignKey({
      name: "diag_response_run_fk",
      columns: [t.tenantId, t.subjectId, t.runId],
      foreignColumns: [diagnosticRuns.tenantId, diagnosticRuns.subjectId, diagnosticRuns.id],
    }),
    report: foreignKey({
      name: "diag_response_report_fk",
      columns: [t.tenantId, t.subjectId, t.reportRevisionId],
      foreignColumns: [
        diagnosticReportRevisions.tenantId,
        diagnosticReportRevisions.subjectId,
        diagnosticReportRevisions.id,
      ],
    }),
    source: foreignKey({
      name: "diag_response_source_fk",
      columns: [t.tenantId, t.subjectId, t.sourceId],
      foreignColumns: [sourceItems.tenantId, sourceItems.subjectId, sourceItems.id],
    }),
    once: uniqueIndex("diagnostic_responses_idempotency").on(
      t.tenantId,
      t.subjectId,
      t.idempotencyKey,
    ),
    byRun: index("diagnostic_responses_run_time").on(t.runId, t.createdAt),
    states: check(
      "diagnostic_responses_states",
      sql`${t.processingStatus} in ('recorded','qualified','rejected','processed')`,
    ),
  }),
).enableRLS();

export const sourceBlobs = pgTable(
  "source_blobs",
  {
    id: id(),
    ...scope(),
    /** Every original file belongs to one source record; the file itself is its attachment. */
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    objectKey: text("object_key").notNull(),
    contentSha256: text("content_sha256").notNull(),
    byteLength: integer("byte_length").notNull(),
    mediaType: text("media_type").notNull(),
    status: text("status").default("declared").notNull(),
    createdAt: createdAt(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => ({
    scopePolicy: ownerPolicy("source_blob_scope", t.tenantId, t.subjectId),
    owner: foreignKey({
      name: "source_blob_owner_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    objectKey: uniqueIndex("source_blobs_object_key").on(t.objectKey),
    byOwner: index("source_blobs_owner").on(t.tenantId, t.subjectId),
    size: check("source_blobs_size", sql`${t.byteLength} >= 0 and ${t.byteLength} <= 52428800`),
    states: check(
      "source_blobs_states",
      sql`${t.status} in ('declared','uploading','available','excluded','delete_pending','deleted')`,
    ),
  }),
).enableRLS();
