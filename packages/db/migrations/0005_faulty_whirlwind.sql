CREATE TABLE IF NOT EXISTS "claim_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_revision_id" uuid NOT NULL,
	"evidence_span_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"directness" text NOT NULL,
	"contribution" text NOT NULL,
	"independence_group" text NOT NULL,
	"scope_match" text NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	"text" text NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"confidence_level" text NOT NULL,
	"confidence_basis" text NOT NULL,
	"revision_reason" text,
	"supersedes_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"claim_key" text NOT NULL,
	"claim_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"quote" text NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb,
	"author_kind" text NOT NULL,
	"about_subject" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experience_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experience_id" uuid NOT NULL,
	"evidence_span_id" uuid NOT NULL,
	"relation" text DEFAULT 'describes' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"context" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'current' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exploration_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exploration_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"question" text NOT NULL,
	"intent" text NOT NULL,
	"quick_options" jsonb DEFAULT '[]'::jsonb,
	"model_meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "exploration_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exploration_id" uuid NOT NULL,
	"question_id" uuid,
	"source_item_id" uuid,
	"role" text NOT NULL,
	"turn_kind" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "explorations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"experience_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"exploration_id" uuid,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"feedback_type" text NOT NULL,
	"note" text NOT NULL,
	"source_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"principal_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exploration_id" uuid NOT NULL,
	"gap_key" text NOT NULL,
	"question" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"attribution_status" text NOT NULL,
	"context_completeness" text NOT NULL,
	"temporal_precision" text NOT NULL,
	"eligibility" text NOT NULL,
	"rationale" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"author_kind" text NOT NULL,
	"content" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_ref" text,
	"source_meta" jsonb DEFAULT '{}'::jsonb,
	"usage_status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" text DEFAULT 'self' NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_revision_id_claim_revisions_id_fk" FOREIGN KEY ("claim_revision_id") REFERENCES "public"."claim_revisions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claim_revisions" ADD CONSTRAINT "claim_revisions_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "claims" ADD CONSTRAINT "claims_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "evidence_spans" ADD CONSTRAINT "evidence_spans_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experience_evidence" ADD CONSTRAINT "experience_evidence_experience_id_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experiences"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experience_evidence" ADD CONSTRAINT "experience_evidence_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiences" ADD CONSTRAINT "experiences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "experiences" ADD CONSTRAINT "experiences_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exploration_questions" ADD CONSTRAINT "exploration_questions_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exploration_turns" ADD CONSTRAINT "exploration_turns_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exploration_turns" ADD CONSTRAINT "exploration_turns_question_id_exploration_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."exploration_questions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exploration_turns" ADD CONSTRAINT "exploration_turns_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "explorations" ADD CONSTRAINT "explorations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "explorations" ADD CONSTRAINT "explorations_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "explorations" ADD CONSTRAINT "explorations_experience_id_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experiences"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_events" ADD CONSTRAINT "feedback_events_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_bindings" ADD CONSTRAINT "identity_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identity_bindings" ADD CONSTRAINT "identity_bindings_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_assessments" ADD CONSTRAINT "source_assessments_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_items" ADD CONSTRAINT "source_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_items" ADD CONSTRAINT "source_items_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subjects" ADD CONSTRAINT "subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_evidence_unique" ON "claim_evidence" USING btree ("claim_revision_id","evidence_span_id","relation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_evidence_revision_idx" ON "claim_evidence" USING btree ("claim_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_revisions_version_unique" ON "claim_revisions" USING btree ("claim_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_revisions_one_current" ON "claim_revisions" USING btree ("claim_id") WHERE "claim_revisions"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claims_subject_key_unique" ON "claims" USING btree ("subject_id","claim_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claims_subject_kind_idx" ON "claims" USING btree ("subject_id","claim_kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_spans_source_idx" ON "evidence_spans" USING btree ("source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_evidence_unique" ON "experience_evidence" USING btree ("experience_id","evidence_span_id","relation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiences_subject_time_idx" ON "experiences" USING btree ("subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exploration_questions_sequence_unique" ON "exploration_questions" USING btree ("exploration_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exploration_turns_exploration_idx" ON "exploration_turns" USING btree ("exploration_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "explorations_subject_idx" ON "explorations" USING btree ("subject_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_events_target_idx" ON "feedback_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "identity_bindings_principal_unique" ON "identity_bindings" USING btree ("provider","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_bindings_tenant_idx" ON "identity_bindings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_gaps_key_unique" ON "knowledge_gaps" USING btree ("exploration_id","gap_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_assessments_version_unique" ON "source_assessments" USING btree ("source_item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_assessments_one_current" ON "source_assessments" USING btree ("source_item_id") WHERE "source_assessments"."is_current" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_items_tenant_time_idx" ON "source_items" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_items_external_unique" ON "source_items" USING btree ("tenant_id","external_ref") WHERE "source_items"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subjects_one_self_per_tenant" ON "subjects" USING btree ("tenant_id") WHERE "subjects"."subject_type" = 'self';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_tenant_idx" ON "subjects" USING btree ("tenant_id");