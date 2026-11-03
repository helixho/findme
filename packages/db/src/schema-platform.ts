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
import { sourceItems, subjects } from "./schema-core";
import { diagnosticRuns } from "./schema-diagnostic";
const id = () => uuid("id").primaryKey().defaultRandom();
const time = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const scope = () => ({
  tenantId: uuid("tenant_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
});
const policy = (name: string, tenant: AnyPgColumn, subject: AnyPgColumn) => {
  const allowed = sql`${tenant}::text = current_setting('app.tenant_id', true) and ${subject}::text = current_setting('app.subject_id', true)`;
  return pgPolicy(name, { for: "all", to: "public", using: allowed, withCheck: allowed });
};
export const profileMemberships = pgTable(
  "profile_memberships",
  {
    id: id(),
    provider: text("provider").notNull(),
    principalId: text("principal_id").notNull(),
    ...scope(),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    creationKey: text("creation_key").notNull(),
    createdAt: time(),
  },
  (t) => ({
    once: uniqueIndex("profile_memberships_identity").on(
      t.provider,
      t.principalId,
      t.tenantId,
      t.subjectId,
    ),
    creation: uniqueIndex("profile_memberships_creation").on(
      t.provider,
      t.principalId,
      t.creationKey,
    ),
    owner: foreignKey({
      name: "profile_membership_subject",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    state: check("profile_membership_state", sql`${t.status} in ('active','archived','deleted')`),
  }),
);
export const cloudJobs = pgTable(
  "cloud_diagnostic_jobs",
  {
    id: id(),
    ...scope(),
    runId: uuid("run_id").notNull(),
    basisVersion: integer("basis_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    model: text("model").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    status: text("status").default("queued").notNull(),
    stage: text("stage").default("qualification").notNull(),
    callCap: integer("call_cap").notNull(),
    callsUsed: integer("calls_used").default(0).notNull(),
    execution: uuid("execution"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    reportId: uuid("report_id"),
    error: text("error"),
    createdAt: time(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopedId: uniqueIndex("cloud_jobs_scope_id").on(t.tenantId, t.subjectId, t.id),
    once: uniqueIndex("cloud_jobs_fingerprint").on(t.tenantId, t.subjectId, t.fingerprint),
    queue: index("cloud_jobs_queue").on(t.status, t.updatedAt),
    run: foreignKey({
      name: "cloud_jobs_run",
      columns: [t.tenantId, t.subjectId, t.runId],
      foreignColumns: [diagnosticRuns.tenantId, diagnosticRuns.subjectId, diagnosticRuns.id],
    }),
    budget: check(
      "cloud_jobs_budget",
      sql`${t.callCap} >= 0 and ${t.callsUsed} >= 0 and ${t.callsUsed} <= ${t.callCap}`,
    ),
    scoped: policy("cloud_jobs_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
export const cloudAttempts = pgTable(
  "cloud_diagnostic_attempts",
  {
    id: id(),
    ...scope(),
    jobId: uuid("job_id").notNull(),
    phase: text("phase").notNull(),
    execution: uuid("execution").notNull(),
    status: text("status").default("reserved").notNull(),
    inputHash: text("input_hash").notNull(),
    raw: text("raw"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    model: text("model"),
    estimate: jsonb("estimate").$type<Record<string, unknown>>(),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: time(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    job: foreignKey({
      name: "cloud_attempt_job",
      columns: [t.tenantId, t.subjectId, t.jobId],
      foreignColumns: [cloudJobs.tenantId, cloudJobs.subjectId, cloudJobs.id],
    }),
    phase: index("cloud_attempt_phase").on(t.jobId, t.phase, t.createdAt),
    scoped: policy("cloud_attempt_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
export const cloudBudgets = pgTable(
  "cloud_inference_budgets",
  {
    ...scope(),
    callsUsed: integer("calls_used").default(0).notNull(),
    createdAt: time(),
  },
  (t) => ({
    owner: uniqueIndex("cloud_budget_owner").on(t.tenantId, t.subjectId),
    subject: foreignKey({
      name: "cloud_budget_subject",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    scoped: policy("cloud_budget_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
export const sourceQualifications = pgTable(
  "source_qualifications",
  {
    id: id(),
    ...scope(),
    sourceId: uuid("source_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    assessmentVersion: integer("assessment_version").notNull(),
    rulesHash: text("rules_hash").notNull(),
    jobId: uuid("job_id").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>[]>().notNull(),
    createdAt: time(),
  },
  (t) => ({
    source: foreignKey({
      name: "source_qualification_source",
      columns: [t.tenantId, t.subjectId, t.sourceId],
      foreignColumns: [sourceItems.tenantId, sourceItems.subjectId, sourceItems.id],
    }),
    once: uniqueIndex("source_qualification_version").on(
      t.sourceId,
      t.sourceHash,
      t.assessmentVersion,
      t.jobId,
    ),
    scoped: policy("source_qualification_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
export const importBatches = pgTable(
  "core_import_batches",
  {
    id: id(),
    ...scope(),
    inputHash: text("input_hash").notNull(),
    status: text("status").default("preview").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: time(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (t) => ({
    once: uniqueIndex("core_import_batch_input").on(t.tenantId, t.subjectId, t.inputHash),
    owner: foreignKey({
      name: "core_import_owner",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    scoped: policy("core_import_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
export const lifecycleActions = pgTable(
  "core_lifecycle_actions",
  {
    id: id(),
    ...scope(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    sourceId: uuid("source_id"),
    kind: text("kind").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: time(),
  },
  (t) => ({
    once: uniqueIndex("core_lifecycle_once").on(t.tenantId, t.subjectId, t.idempotencyKey),
    scoped: policy("core_lifecycle_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
export const frameworkStates = pgTable(
  "cloud_framework_states",
  {
    ...scope(),
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    version: integer("version").default(0).notNull(),
    contentHash: text("content_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    owner: uniqueIndex("cloud_framework_owner").on(t.tenantId, t.subjectId),
    subject: foreignKey({
      name: "cloud_framework_subject",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    scoped: policy("cloud_framework_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
