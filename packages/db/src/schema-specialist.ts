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
import { subjects } from "./schema-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const scope = () => ({
  tenantId: uuid("tenant_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
});
const ownerPolicy = (name: string, tenantId: AnyPgColumn, subjectId: AnyPgColumn) => {
  const allowed = sql`${tenantId}::text = current_setting('app.tenant_id', true)
    and ${subjectId}::text = current_setting('app.subject_id', true)`;
  return pgPolicy(name, { for: "all", to: "public", using: allowed, withCheck: allowed });
};

export const specialistSessions = pgTable(
  "specialist_sessions",
  {
    id: id(),
    ...scope(),
    pathway: text("pathway").notNull(),
    voluntary: text("voluntary").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("open").notNull(),
    version: integer("version").default(1).notNull(),
    goal: text("goal"),
    setting: text("setting"),
    difficulty: text("difficulty"),
    difficultyCategories: jsonb("difficulty_categories").$type<string[]>().default([]).notNull(),
    scopeFlags: jsonb("scope_flags").$type<string[]>().default([]).notNull(),
    environment: text("environment"),
    environmentCategories: jsonb("environment_categories").$type<string[]>().default([]).notNull(),
    existingSupports: text("existing_supports"),
    burden: text("burden"),
    selfReportedDiagnosis: text("self_reported_diagnosis"),
    skippedSteps: jsonb("skipped_steps").$type<string[]>().default([]).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    owner: foreignKey({
      name: "specialist_session_owner_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    scopedId: uniqueIndex("specialist_sessions_scope_id").on(t.tenantId, t.subjectId, t.id),
    once: uniqueIndex("specialist_sessions_idempotency").on(
      t.tenantId,
      t.subjectId,
      t.idempotencyKey,
    ),
    byOwner: index("specialist_sessions_owner_updated").on(t.tenantId, t.subjectId, t.updatedAt),
    pathwayCheck: check(
      "specialist_sessions_pathway_check",
      sql`${t.pathway} in ('general','adhd')`,
    ),
    voluntaryCheck: check("specialist_sessions_voluntary_check", sql`${t.voluntary} = 'yes'`),
    statusCheck: check(
      "specialist_sessions_status_check",
      sql`${t.status} in ('open','paused','completed')`,
    ),
    diagnosisCheck: check(
      "specialist_sessions_diagnosis_check",
      sql`${t.selfReportedDiagnosis} is null or ${t.selfReportedDiagnosis} in ('diagnosed','concern','none','prefer_not_to_say')`,
    ),
    scopePolicy: ownerPolicy("specialist_session_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();

export const specialistProposals = pgTable(
  "specialist_proposals",
  {
    id: id(),
    ...scope(),
    sessionId: uuid("session_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").default("proposed").notNull(),
    version: integer("version").default(1).notNull(),
    adjustmentKind: text("adjustment_kind").notNull(),
    actionText: text("action_text").notNull(),
    burden: text("burden").notNull(),
    cost: text("cost").notNull(),
    unknowns: text("unknowns").notNull(),
    personalBasis: jsonb("personal_basis").$type<Record<string, unknown>>().notNull(),
    applicability: jsonb("applicability").$type<Record<string, unknown>>().notNull(),
    contentBasis: jsonb("content_basis").$type<Record<string, unknown>>().notNull(),
    evidenceMode: text("evidence_mode").default("content_supported").notNull(),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => ({
    owner: foreignKey({
      name: "specialist_proposal_owner_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    session: foreignKey({
      name: "specialist_proposal_session_fk",
      columns: [t.tenantId, t.subjectId, t.sessionId],
      foreignColumns: [
        specialistSessions.tenantId,
        specialistSessions.subjectId,
        specialistSessions.id,
      ],
    }),
    scopedId: uniqueIndex("specialist_proposals_scope_id").on(t.tenantId, t.subjectId, t.id),
    once: uniqueIndex("specialist_proposals_idempotency").on(
      t.tenantId,
      t.subjectId,
      t.idempotencyKey,
    ),
    bySession: index("specialist_proposals_session_created").on(
      t.tenantId,
      t.subjectId,
      t.sessionId,
      t.createdAt,
    ),
    statusCheck: check(
      "specialist_proposals_status_check",
      sql`${t.status} in ('proposed','accepted','rejected','paused')`,
    ),
    modeCheck: check(
      "specialist_proposals_evidence_mode_check",
      sql`${t.evidenceMode} in ('content_supported','exploratory')`,
    ),
    kindCheck: check(
      "specialist_proposals_kind_check",
      sql`${t.adjustmentKind} in ('environment','task_structure','written_instruction','distraction_reduction','movement_break')`,
    ),
    scopePolicy: ownerPolicy("specialist_proposal_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();

export const specialistTrials = pgTable(
  "specialist_trials",
  {
    id: id(),
    ...scope(),
    proposalId: uuid("proposal_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    status: text("status").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    acceptedAction: text("accepted_action").notNull(),
    acceptedProposalVersion: integer("accepted_proposal_version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
    latestExecution: text("latest_execution"),
    latestOutcome: text("latest_outcome"),
    latestBurden: text("latest_burden"),
    latestObservation: text("latest_observation"),
    continueTrial: text("continue_trial"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewHistory: jsonb("review_history").$type<Record<string, unknown>[]>().default([]).notNull(),
  },
  (t) => ({
    owner: foreignKey({
      name: "specialist_trial_owner_fk",
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    proposal: foreignKey({
      name: "specialist_trial_proposal_fk",
      columns: [t.tenantId, t.subjectId, t.proposalId],
      foreignColumns: [
        specialistProposals.tenantId,
        specialistProposals.subjectId,
        specialistProposals.id,
      ],
    }),
    session: foreignKey({
      name: "specialist_trial_session_fk",
      columns: [t.tenantId, t.subjectId, t.sessionId],
      foreignColumns: [
        specialistSessions.tenantId,
        specialistSessions.subjectId,
        specialistSessions.id,
      ],
    }),
    once: uniqueIndex("specialist_trials_proposal_unique").on(
      t.tenantId,
      t.subjectId,
      t.proposalId,
    ),
    bySession: index("specialist_trials_session").on(
      t.tenantId,
      t.subjectId,
      t.sessionId,
      t.acceptedAt,
    ),
    statusCheck: check(
      "specialist_trials_status_check",
      sql`${t.status} in ('active','paused','completed')`,
    ),
    executionCheck: check(
      "specialist_trials_execution_check",
      sql`${t.latestExecution} is null or ${t.latestExecution} in ('completed','not_executed','partly_executed','unknown')`,
    ),
    outcomeCheck: check(
      "specialist_trials_outcome_check",
      sql`${t.latestOutcome} is null or ${t.latestOutcome} in ('helpful','no_effect','worse','mixed','unknown')`,
    ),
    scopePolicy: ownerPolicy("specialist_trial_scope", t.tenantId, t.subjectId),
  }),
).enableRLS();
