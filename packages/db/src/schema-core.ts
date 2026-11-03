import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const tenants = pgTable("tenants", {
  id: id(),
  status: text("status").default("active").notNull(),
  createdAt: createdAt(),
  ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
});
export const subjects = pgTable(
  "subjects",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectType: text("subject_type").default("self").notNull(),
    displayName: text("display_name"),
    createdAt: createdAt(),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    scopedId: uniqueIndex("subjects_tenant_id_unique").on(t.tenantId, t.id),
    oneSelfPerTenant: uniqueIndex("subjects_one_self_per_tenant")
      .on(t.tenantId)
      .where(sql`${t.subjectType} = 'self'`),
    byTenant: index("subjects_tenant_idx").on(t.tenantId),
  }),
);
export const sourceItems = pgTable(
  "source_items",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    sourceKind: text("source_kind").notNull(),
    authorKind: text("author_kind").notNull(),
    content: text("content").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    capturedAt: createdAt(),
    externalRef: text("external_ref"),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>().default({}),
    usageStatus: text("usage_status").default("active").notNull(),
  },
  (t) => ({
    scopedId: uniqueIndex("source_items_scope_id_unique").on(t.tenantId, t.subjectId, t.id),
    byTenantTime: index("source_items_tenant_time_idx").on(t.tenantId, t.capturedAt),
    externalUnique: uniqueIndex("source_items_external_unique")
      .on(t.tenantId, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
  }),
);
export const sourceLinks = pgTable(
  "source_links",
  {
    id: id(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    targetSourceItemId: uuid("target_source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    relation: text("relation").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqueLink: uniqueIndex("source_links_unique").on(
      t.sourceItemId,
      t.targetSourceItemId,
      t.relation,
    ),
    byTarget: index("source_links_target_idx").on(t.targetSourceItemId, t.createdAt),
  }),
);

export const sourceAssessments = pgTable(
  "source_assessments",
  {
    id: id(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    version: integer("version").notNull(),
    attributionStatus: text("attribution_status").notNull(),
    contextCompleteness: text("context_completeness").notNull(),
    temporalPrecision: text("temporal_precision").notNull(),
    eligibility: text("eligibility").notNull(),
    rationale: text("rationale").notNull(),
    isCurrent: boolean("is_current").default(true).notNull(),
    supersedesId: uuid("supersedes_id"),
    createdAt: createdAt(),
  },
  (t) => ({
    versionUnique: uniqueIndex("source_assessments_version_unique").on(t.sourceItemId, t.version),
    oneCurrent: uniqueIndex("source_assessments_one_current")
      .on(t.sourceItemId)
      .where(sql`${t.isCurrent} = true`),
  }),
);
export const evidenceSpans = pgTable(
  "evidence_spans",
  {
    id: id(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id),
    quote: text("quote").notNull(),
    locator: jsonb("locator").$type<Record<string, unknown>>().default({}),
    authorKind: text("author_kind").notNull(),
    aboutSubject: boolean("about_subject").default(true).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    sourceIdUnique: uniqueIndex("evidence_spans_source_id_unique").on(t.sourceItemId, t.id),
    bySource: index("evidence_spans_source_idx").on(t.sourceItemId),
  }),
);

export const experiences = pgTable(
  "experiences",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    summary: text("summary").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    status: text("status").default("current").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    bySubjectTime: index("experiences_subject_time_idx").on(t.subjectId, t.createdAt),
  }),
);
export const experienceEvidence = pgTable(
  "experience_evidence",
  {
    id: id(),
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experiences.id),
    evidenceSpanId: uuid("evidence_span_id")
      .notNull()
      .references(() => evidenceSpans.id),
    relation: text("relation").default("describes").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqueLink: uniqueIndex("experience_evidence_unique").on(
      t.experienceId,
      t.evidenceSpanId,
      t.relation,
    ),
  }),
);

export const explorations = pgTable(
  "explorations",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    experienceId: uuid("experience_id")
      .notNull()
      .references(() => experiences.id),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    startedAt: createdAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    bySubject: index("explorations_subject_idx").on(t.subjectId, t.startedAt),
  }),
);
export const explorationQuestions = pgTable(
  "exploration_questions",
  {
    id: id(),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id),
    sequence: integer("sequence").notNull(),
    question: text("question").notNull(),
    intent: text("intent").notNull(),
    quickOptions: jsonb("quick_options").$type<string[]>().default([]),
    status: text("status").default("open").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    modelMeta: jsonb("model_meta").$type<Record<string, unknown>>().default({}),
    createdAt: createdAt(),
  },
  (t) => ({
    sequenceUnique: uniqueIndex("exploration_questions_sequence_unique").on(
      t.explorationId,
      t.sequence,
    ),
    oneOpen: uniqueIndex("exploration_questions_one_open")
      .on(t.explorationId)
      .where(sql`${t.status} = 'open'`),
  }),
);

export const explorationTurns = pgTable(
  "exploration_turns",
  {
    id: id(),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id),
    questionId: uuid("question_id").references(() => explorationQuestions.id),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id),
    role: text("role").notNull(),
    turnKind: text("turn_kind").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    byExploration: index("exploration_turns_exploration_idx").on(t.explorationId, t.createdAt),
  }),
);
export const explorationSteps = pgTable(
  "exploration_steps",
  {
    id: id(),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id),
    sequence: integer("sequence").notNull(),
    basisVersion: integer("basis_version").notNull(),
    inputTurnId: uuid("input_turn_id").references(() => explorationTurns.id),
    currentReading: text("current_reading").notNull(),
    keyUncertainty: text("key_uncertainty"),
    decision: text("decision").notNull(),
    intent: text("intent").notNull(),
    stopReason: text("stop_reason"),
    questionId: uuid("question_id").references(() => explorationQuestions.id),
    modelMeta: jsonb("model_meta").$type<Record<string, unknown>>().default({}),
    createdAt: createdAt(),
  },
  (t) => ({
    sequenceUnique: uniqueIndex("exploration_steps_sequence_unique").on(
      t.explorationId,
      t.sequence,
    ),
    byExploration: index("exploration_steps_exploration_idx").on(t.explorationId, t.createdAt),
  }),
);

export const claims = pgTable(
  "claims",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    claimKey: text("claim_key").notNull(),
    claimKind: text("claim_kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    claimKeyUnique: uniqueIndex("claims_subject_key_unique").on(t.subjectId, t.claimKey),
    bySubjectKind: index("claims_subject_kind_idx").on(t.subjectId, t.claimKind),
  }),
);

export const claimRevisions = pgTable(
  "claim_revisions",
  {
    id: id(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id),
    version: integer("version").notNull(),
    mode: text("mode").notNull(),
    text: text("text").notNull(),
    scope: text("scope").notNull(),
    status: text("status").default("current").notNull(),
    evidenceStatus: text("evidence_status").default("valid").notNull(),
    confidenceLevel: text("confidence_level").notNull(),
    confidenceBasis: text("confidence_basis").notNull(),
    revisionReason: text("revision_reason"),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    createdAt: createdAt(),
  },
  (t) => ({
    versionUnique: uniqueIndex("claim_revisions_version_unique").on(t.claimId, t.version),
    oneCurrent: uniqueIndex("claim_revisions_one_current")
      .on(t.claimId)
      .where(sql`${t.status} = 'current'`),
  }),
);
export const claimEvidence = pgTable(
  "claim_evidence",
  {
    id: id(),
    claimRevisionId: uuid("claim_revision_id")
      .notNull()
      .references(() => claimRevisions.id),
    evidenceSpanId: uuid("evidence_span_id")
      .notNull()
      .references(() => evidenceSpans.id),
    relation: text("relation").notNull(),
    directness: text("directness").notNull(),
    contribution: text("contribution").notNull(),
    independenceGroup: text("independence_group").notNull(),
    scopeMatch: text("scope_match").notNull(),
    rationale: text("rationale").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    uniqueUse: uniqueIndex("claim_evidence_unique").on(
      t.claimRevisionId,
      t.evidenceSpanId,
      t.relation,
    ),
    byRevision: index("claim_evidence_revision_idx").on(t.claimRevisionId),
  }),
);

export const knowledgeGaps = pgTable(
  "knowledge_gaps",
  {
    id: id(),
    explorationId: uuid("exploration_id")
      .notNull()
      .references(() => explorations.id),
    gapKey: text("gap_key").notNull(),
    question: text("question").notNull(),
    whyItMatters: text("why_it_matters").notNull(),
    status: text("status").default("open").notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    keyUnique: uniqueIndex("knowledge_gaps_key_unique").on(t.explorationId, t.gapKey),
  }),
);
export const feedbackEvents = pgTable(
  "feedback_events",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    explorationId: uuid("exploration_id").references(() => explorations.id),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    feedbackType: text("feedback_type").notNull(),
    note: text("note").notNull(),
    sourceItemId: uuid("source_item_id").references(() => sourceItems.id),
    createdAt: createdAt(),
  },
  (t) => ({
    byTarget: index("feedback_events_target_idx").on(t.targetType, t.targetId),
  }),
);

export const identityBindings = pgTable(
  "identity_bindings",
  {
    id: id(),
    provider: text("provider").notNull(),
    principalId: text("principal_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    createdAt: createdAt(),
  },
  (t) => ({
    principalUnique: uniqueIndex("identity_bindings_principal_unique").on(
      t.provider,
      t.principalId,
    ),
    byTenant: index("identity_bindings_tenant_idx").on(t.tenantId),
  }),
);

export const coreOperations = pgTable(
  "core_operations",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    explorationId: uuid("exploration_id").references(() => explorations.id),
    idempotencyKey: text("idempotency_key").notNull(),
    operationType: text("operation_type").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").default("processing").notNull(),
    basisVersion: integer("basis_version"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex("core_operations_tenant_idempotency_unique").on(
      t.tenantId,
      t.idempotencyKey,
    ),
    byExploration: index("core_operations_exploration_idx").on(t.explorationId, t.createdAt),
    byStatusLease: index("core_operations_status_lease_idx").on(t.status, t.leaseExpiresAt),
  }),
);
