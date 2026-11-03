CREATE TABLE IF NOT EXISTS "specialist_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "subject_id" uuid NOT NULL,
  "pathway" text NOT NULL,
  "voluntary" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "goal" text,
  "setting" text,
  "difficulty" text,
  "difficulty_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scope_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "environment" text,
  "environment_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "existing_supports" text,
  "burden" text,
  "self_reported_diagnosis" text,
  "skipped_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "specialist_session_owner_fk" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id"),
  CONSTRAINT "specialist_sessions_pathway_check" CHECK ("pathway" in ('general','adhd')),
  CONSTRAINT "specialist_sessions_voluntary_check" CHECK ("voluntary" = 'yes'),
  CONSTRAINT "specialist_sessions_status_check" CHECK ("status" in ('open','paused','completed')),
  CONSTRAINT "specialist_sessions_diagnosis_check" CHECK ("self_reported_diagnosis" is null or "self_reported_diagnosis" in ('diagnosed','concern','none','prefer_not_to_say'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "specialist_sessions_scope_id" ON "specialist_sessions" ("tenant_id", "subject_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "specialist_sessions_idempotency" ON "specialist_sessions" ("tenant_id", "subject_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_sessions_owner_updated" ON "specialist_sessions" ("tenant_id", "subject_id", "updated_at");
--> statement-breakpoint
ALTER TABLE "specialist_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "specialist_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "specialist_session_scope" ON "specialist_sessions" USING ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "specialist_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "subject_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "adjustment_kind" text NOT NULL,
  "action_text" text NOT NULL,
  "burden" text NOT NULL,
  "cost" text NOT NULL,
  "unknowns" text NOT NULL,
  "personal_basis" jsonb NOT NULL,
  "applicability" jsonb NOT NULL,
  "content_basis" jsonb NOT NULL,
  "evidence_mode" text DEFAULT 'content_supported' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "decision_note" text,
  CONSTRAINT "specialist_proposal_owner_fk" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id"),
  CONSTRAINT "specialist_proposal_session_fk" FOREIGN KEY ("tenant_id", "subject_id", "session_id") REFERENCES "specialist_sessions"("tenant_id", "subject_id", "id"),
  CONSTRAINT "specialist_proposals_status_check" CHECK ("status" in ('proposed','accepted','rejected','paused')),
  CONSTRAINT "specialist_proposals_evidence_mode_check" CHECK ("evidence_mode" in ('content_supported','exploratory')),
  CONSTRAINT "specialist_proposals_kind_check" CHECK ("adjustment_kind" in ('environment','task_structure','written_instruction','distraction_reduction','movement_break'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "specialist_proposals_scope_id" ON "specialist_proposals" ("tenant_id", "subject_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "specialist_proposals_idempotency" ON "specialist_proposals" ("tenant_id", "subject_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_proposals_session_created" ON "specialist_proposals" ("tenant_id", "subject_id", "session_id", "created_at");
--> statement-breakpoint
ALTER TABLE "specialist_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "specialist_proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "specialist_proposal_scope" ON "specialist_proposals" USING ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "specialist_trials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "subject_id" uuid NOT NULL,
  "proposal_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "accepted_action" text NOT NULL,
  "accepted_proposal_version" integer NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "latest_execution" text,
  "latest_outcome" text,
  "latest_burden" text,
  "latest_observation" text,
  "continue_trial" text,
  "reviewed_at" timestamp with time zone,
  "review_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  CONSTRAINT "specialist_trial_owner_fk" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id"),
  CONSTRAINT "specialist_trial_proposal_fk" FOREIGN KEY ("tenant_id", "subject_id", "proposal_id") REFERENCES "specialist_proposals"("tenant_id", "subject_id", "id"),
  CONSTRAINT "specialist_trial_session_fk" FOREIGN KEY ("tenant_id", "subject_id", "session_id") REFERENCES "specialist_sessions"("tenant_id", "subject_id", "id"),
  CONSTRAINT "specialist_trials_status_check" CHECK ("status" in ('active','paused','completed')),
  CONSTRAINT "specialist_trials_execution_check" CHECK ("latest_execution" is null or "latest_execution" in ('completed','not_executed','partly_executed','unknown')),
  CONSTRAINT "specialist_trials_outcome_check" CHECK ("latest_outcome" is null or "latest_outcome" in ('helpful','no_effect','worse','mixed','unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "specialist_trials_proposal_unique" ON "specialist_trials" ("tenant_id", "subject_id", "proposal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_trials_session" ON "specialist_trials" ("tenant_id", "subject_id", "session_id", "accepted_at");
--> statement-breakpoint
ALTER TABLE "specialist_trials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "specialist_trials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "specialist_trial_scope" ON "specialist_trials" USING ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_processing_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "subject_id" uuid NOT NULL,
  "topic_key" text NOT NULL,
  "version" integer NOT NULL,
  "record_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_processing_subject_fk" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id"),
  CONSTRAINT "knowledge_processing_version_check" CHECK ("version" > 0),
  CONSTRAINT "knowledge_processing_type_check" CHECK ("record_type" in ('topic_result','feedback'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_processing_topic_version_unique" ON "knowledge_processing_records" ("tenant_id", "subject_id", "topic_key", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_processing_topic_idx" ON "knowledge_processing_records" ("tenant_id", "subject_id", "topic_key", "created_at");
--> statement-breakpoint
ALTER TABLE "knowledge_processing_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge_processing_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "knowledge_processing_scope" ON "knowledge_processing_records" USING ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true) and "subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'findme_runtime') THEN
    EXECUTE 'GRANT SELECT,INSERT,UPDATE,DELETE ON specialist_sessions,specialist_proposals,specialist_trials,knowledge_processing_records TO findme_runtime';
  END IF;
END $$;
--> statement-breakpoint
