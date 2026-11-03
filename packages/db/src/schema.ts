import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// 1. raw_records — L1 原始数据(append-only)
export const rawRecords = pgTable(
  "raw_records",
  {
    id: id(),
    createdAt: createdAt(),
    sourceType: text("source_type").notNull(),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>().default({}),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    contentFormat: text("content_format").default("plain_text").notNull(),
    userContext: jsonb("user_context").$type<Record<string, unknown>>().default({}),
    visibility: text("visibility").default("active").notNull(), // active|hidden|archived
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    byCreated: index("idx_raw_records_created").on(t.createdAt),
    bySource: index("idx_raw_records_source").on(t.sourceType, t.createdAt),
    byVisibility: index("idx_raw_records_visibility").on(t.visibility),
    visibilityCheck: check(
      "raw_records_visibility_check",
      sql`${t.visibility} in ('active', 'hidden', 'archived')`,
    ),
  }),
);

// 2. light_extracts — M-O1
export const lightExtracts = pgTable(
  "light_extracts",
  {
    id: id(),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => rawRecords.id),
    asyncTaskId: text("async_task_id"),
    extractedAt: createdAt(),
    topics: jsonb("topics").$type<string[]>().default([]),
    emotionHints: jsonb("emotion_hints").$type<string[]>().default([]),
    mentionedObjects: jsonb("mentioned_objects").$type<string[]>().default([]),
    userTags: jsonb("user_tags").$type<string[]>().default([]),
    evidenceSnippets: jsonb("evidence_snippets").$type<string[]>().default([]),
    confidence: real("confidence"), // I1:real 而非 numeric,避免 Drizzle 映射为 string,与 shared zod number 对齐
    extractionVersion: text("extraction_version").notNull(),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    bySource: index("idx_light_extracts_source").on(t.sourceRecordId),
    byAsyncTask: uniqueIndex("light_extracts_async_task_unique")
      .on(t.asyncTaskId)
      .where(sql`${t.asyncTaskId} is not null`),
    byExtracted: index("idx_light_extracts_extracted").on(t.extractedAt),
  }),
);

// 3. roles
export const roles = pgTable("roles", {
  id: id(),
  roleCategory: text("role_category").notNull(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  promptVersion: integer("prompt_version").default(1).notNull(),
  safetyMeta: jsonb("safety_meta").$type<Record<string, unknown>>().default({}),
  createdBy: text("created_by").default("user").notNull(),
  visibility: text("visibility").default("active").notNull(),
  ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 4. static_materials — M-B0 学习材料
export const staticMaterials = pgTable(
  "static_materials",
  {
    id: id(),
    materialType: text("material_type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    linkedRefs: jsonb("linked_refs").$type<Record<string, unknown>>().default({}),
    enabled: boolean("enabled").default(true).notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    titleUnique: uniqueIndex("static_materials_title_unique").on(t.title),
  }),
);

// 5. questionnaires
export const questionnaires = pgTable(
  "questionnaires",
  {
    id: id(),
    name: text("name").notNull(),
    questionnaireType: text("questionnaire_type").notNull(),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>().default({}),
    enabled: boolean("enabled").default(true).notNull(),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
    createdAt: createdAt(),
  },
  (t) => ({
    nameUnique: uniqueIndex("questionnaires_name_unique").on(t.name),
  }),
);

// 6. question_items
export const questionItems = pgTable("question_items", {
  id: id(),
  questionnaireId: uuid("questionnaire_id").references(() => questionnaires.id),
  promptText: text("prompt_text").notNull(),
  responseFormat: text("response_format").notNull(), // single_choice|multi_choice|likert_scale|free_text|boolean
  responseOptions: jsonb("response_options").$type<Record<string, unknown>>().default({}),
  enabled: boolean("enabled").default(true).notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
  createdAt: createdAt(),
});

// 7. insights — L3(evidence_refs 强约束 + GIN 索引,B2)
export const insights = pgTable(
  "insights",
  {
    id: id(),
    generatedAt: createdAt(),
    insightType: text("insight_type").notNull(),
    content: text("content").notNull(),
    theoreticalFrame: text("theoretical_frame"),
    evidenceRefs: jsonb("evidence_refs")
      .$type<{ l1_record_ids: string[]; l2_entity_refs?: unknown[] }>()
      .notNull(),
    generationMeta: jsonb("generation_meta").$type<Record<string, unknown>>().default({}),
    acknowledgmentHistory: jsonb("acknowledgment_history").$type<unknown[]>().default([]),
    revisionOf: uuid("revision_of"),
    visibility: text("visibility").default("active").notNull(),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    byGenerated: index("idx_insights_generated").on(t.generatedAt),
    byEvidence: index("idx_insights_evidence_gin").using("gin", t.evidenceRefs), // B2: 引用查询
    byAsyncTask: uniqueIndex("insights_async_task_unique")
      .on(sql`(${t.generationMeta}->>'async_task_id')`)
      .where(sql`${t.generationMeta} ? 'async_task_id'`),
    visibilityCheck: check(
      "insights_visibility_check",
      sql`${t.visibility} in ('active', 'hidden', 'archived')`,
    ),
  }),
);

// 8. safety_events — M-S1(不存原文)
export const safetyEvents = pgTable(
  "safety_events",
  {
    id: id(),
    triggeredAt: createdAt(),
    triggerType: text("trigger_type").notNull(), // keyword_match|...
    ruleId: text("rule_id"),
    triggerMeta: jsonb("trigger_meta").$type<Record<string, unknown>>().default({}),
    resourcesShown: jsonb("resources_shown").$type<unknown[]>().default([]),
    userAcknowledgedAt: timestamp("user_acknowledged_at", { withTimezone: true }),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({ byTriggered: index("idx_safety_events_triggered").on(t.triggeredAt) }),
);

// 9. async_tasks — 含租约列(I1)
export const asyncTasks = pgTable(
  "async_tasks",
  {
    id: id(),
    taskType: text("task_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    status: text("status").default("pending").notNull(), // pending|running|completed|failed
    retryCount: integer("retry_count").default(0).notNull(),
    maxRetries: integer("max_retries").default(3).notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    byStatus: index("idx_async_tasks_status").on(t.status, t.nextRunAt),
    statusCheck: check(
      "async_tasks_status_check",
      sql`${t.status} in ('pending', 'running', 'completed', 'failed')`,
    ),
  }),
);

// 10. app_sessions — V1.1 单用户可吊销会话(token 只存 hash)
export const appSessions = pgTable(
  "app_sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    byToken: index("idx_app_sessions_token_hash").on(t.tokenHash),
    byExpiry: index("idx_app_sessions_expires").on(t.expiresAt),
  }),
);

// 11. worker_heartbeats — health 严格模式判断 worker 是否仍在跑
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  beatAt: timestamp("beat_at", { withTimezone: true }).defaultNow().notNull(),
  status: text("status").default("ok").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
});

// 12. insight_feedback — V1.1 洞察质量反馈(准确/部分准确/不准确 + 原因)
export const insightFeedback = pgTable(
  "insight_feedback",
  {
    id: id(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insights.id),
    dimension: text("dimension"),
    rating: text("rating").notNull(), // accurate|partial|inaccurate
    reason: text("reason"),
    createdAt: createdAt(),
    ext: jsonb("ext").$type<Record<string, unknown>>().default({}),
  },
  (t) => ({
    byInsight: index("idx_insight_feedback_insight").on(t.insightId, t.createdAt),
  }),
);

// 13. system_logs
export const systemLogs = pgTable("system_logs", {
  id: id(),
  createdAt: createdAt(),
  action: text("action").notNull(),
  actor: text("actor").default("user").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
});

// 14. type_registry
export const typeRegistry = pgTable("type_registry", {
  id: id(),
  domain: text("domain").notNull(),
  value: text("value").notNull(),
  displayName: text("display_name"),
  description: text("description"),
  enabled: boolean("enabled").default(true).notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().default({}),
  createdAt: createdAt(),
});

// 15. agent_registry — 含 structured_output_strategy(I4)
export const agentRegistry = pgTable("agent_registry", {
  id: id(),
  agentKey: text("agent_key").notNull().unique(),
  taskType: text("task_type").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  promptVersion: integer("prompt_version").default(1).notNull(),
  modelRoute: text("model_route").notNull(),
  structuredOutputStrategy: text("structured_output_strategy").default("text_parse").notNull(), // json_mode|tool_call|text_parse
  outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().default({}),
  allowedDataScope: jsonb("allowed_data_scope").$type<Record<string, unknown>>().default({}),
  loggingPolicy: jsonb("logging_policy").$type<Record<string, unknown>>().default({}),
  status: text("status").default("active").notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// 16. llm_call_logs(只记元数据)
export const llmCallLogs = pgTable("llm_call_logs", {
  id: id(),
  createdAt: createdAt(),
  agentKey: text("agent_key").notNull(),
  promptVersion: integer("prompt_version"),
  modelUsed: text("model_used").notNull(),
  taskType: text("task_type"),
  tokenUsage: jsonb("token_usage").$type<Record<string, number>>().default({}),
  latencyMs: integer("latency_ms"),
  status: text("status").notNull(),
  errorCode: text("error_code"),
});
