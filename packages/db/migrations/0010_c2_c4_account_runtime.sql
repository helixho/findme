-- Generated from local Drizzle schema; unique indexes moved before dependent composite FKs.
-- No database execution has been performed. FORCE RLS is an explicit migration supplement.
CREATE TABLE IF NOT EXISTS "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"lastRequest" bigint NOT NULL,
	CONSTRAINT "auth_rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_diagnostic_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"execution" uuid NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"input_hash" text NOT NULL,
	"raw" text,
	"result" jsonb,
	"usage" jsonb,
	"model" text,
	"estimate" jsonb,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cloud_diagnostic_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_inference_budgets" (
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_inference_budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_diagnostic_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"basis_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'qualification' NOT NULL,
	"call_cap" integer NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"execution" uuid,
	"lease_until" timestamp with time zone,
	"report_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_jobs_budget" CHECK ("cloud_diagnostic_jobs"."call_cap" >= 0 and "cloud_diagnostic_jobs"."calls_used" >= 0 and "cloud_diagnostic_jobs"."calls_used" <= "cloud_diagnostic_jobs"."call_cap")
);
--> statement-breakpoint
ALTER TABLE "cloud_diagnostic_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_framework_states" (
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_framework_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core_import_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "core_lifecycle_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"source_id" uuid,
	"kind" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_lifecycle_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"principal_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"creation_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_membership_state" CHECK ("profile_memberships"."status" in ('active','archived','deleted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_qualifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_hash" text NOT NULL,
	"assessment_version" integer NOT NULL,
	"rules_hash" text NOT NULL,
	"job_id" uuid NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_qualifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "source_blobs" DROP CONSTRAINT "source_blobs_states";
--> statement-breakpoint
ALTER TABLE "diagnostic_report_revisions" ADD COLUMN "job_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_accounts_identity" ON "auth_accounts" USING btree ("providerId","accountId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_budget_owner" ON "cloud_inference_budgets" USING btree ("tenant_id","subject_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_jobs_scope_id" ON "cloud_diagnostic_jobs" USING btree ("tenant_id","subject_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_jobs_fingerprint" ON "cloud_diagnostic_jobs" USING btree ("tenant_id","subject_id","fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_framework_owner" ON "cloud_framework_states" USING btree ("tenant_id","subject_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "core_import_batch_input" ON "core_import_batches" USING btree ("tenant_id","subject_id","input_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "core_lifecycle_once" ON "core_lifecycle_actions" USING btree ("tenant_id","subject_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profile_memberships_identity" ON "profile_memberships" USING btree ("provider","principal_id","tenant_id","subject_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profile_memberships_creation" ON "profile_memberships" USING btree ("provider","principal_id","creation_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_qualification_version" ON "source_qualifications" USING btree ("source_id","source_hash","assessment_version","job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_reports_job_once" ON "diagnostic_report_revisions" USING btree ("job_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_userId_auth_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_auth_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_diagnostic_attempts" ADD CONSTRAINT "cloud_attempt_job" FOREIGN KEY ("tenant_id","subject_id","job_id") REFERENCES "public"."cloud_diagnostic_jobs"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_inference_budgets" ADD CONSTRAINT "cloud_budget_subject" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_diagnostic_jobs" ADD CONSTRAINT "cloud_jobs_run" FOREIGN KEY ("tenant_id","subject_id","run_id") REFERENCES "public"."diagnostic_runs"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloud_framework_states" ADD CONSTRAINT "cloud_framework_subject" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core_import_batches" ADD CONSTRAINT "core_import_owner" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profile_memberships" ADD CONSTRAINT "profile_membership_subject" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_qualifications" ADD CONSTRAINT "source_qualification_source" FOREIGN KEY ("tenant_id","subject_id","source_id") REFERENCES "public"."source_items"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_accounts_user" ON "auth_accounts" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_user" ON "auth_sessions" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_verifications_identifier" ON "auth_verifications" USING btree ("identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_attempt_phase" ON "cloud_diagnostic_attempts" USING btree ("job_id","phase","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_jobs_queue" ON "cloud_diagnostic_jobs" USING btree ("status","updated_at");
--> statement-breakpoint
ALTER TABLE "source_blobs" ADD CONSTRAINT "source_blobs_states" CHECK ("source_blobs"."status" in ('declared','uploading','available','excluded','delete_pending','deleted'));
--> statement-breakpoint
CREATE POLICY "cloud_attempt_scope" ON "cloud_diagnostic_attempts" AS PERMISSIVE FOR ALL TO public USING ("cloud_diagnostic_attempts"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_diagnostic_attempts"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("cloud_diagnostic_attempts"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_diagnostic_attempts"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "cloud_budget_scope" ON "cloud_inference_budgets" AS PERMISSIVE FOR ALL TO public USING ("cloud_inference_budgets"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_inference_budgets"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("cloud_inference_budgets"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_inference_budgets"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "cloud_jobs_scope" ON "cloud_diagnostic_jobs" AS PERMISSIVE FOR ALL TO public USING ("cloud_diagnostic_jobs"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_diagnostic_jobs"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("cloud_diagnostic_jobs"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_diagnostic_jobs"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "cloud_framework_scope" ON "cloud_framework_states" AS PERMISSIVE FOR ALL TO public USING ("cloud_framework_states"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_framework_states"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("cloud_framework_states"."tenant_id"::text = current_setting('app.tenant_id', true) and "cloud_framework_states"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "core_import_scope" ON "core_import_batches" AS PERMISSIVE FOR ALL TO public USING ("core_import_batches"."tenant_id"::text = current_setting('app.tenant_id', true) and "core_import_batches"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("core_import_batches"."tenant_id"::text = current_setting('app.tenant_id', true) and "core_import_batches"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "core_lifecycle_scope" ON "core_lifecycle_actions" AS PERMISSIVE FOR ALL TO public USING ("core_lifecycle_actions"."tenant_id"::text = current_setting('app.tenant_id', true) and "core_lifecycle_actions"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("core_lifecycle_actions"."tenant_id"::text = current_setting('app.tenant_id', true) and "core_lifecycle_actions"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "source_qualification_scope" ON "source_qualifications" AS PERMISSIVE FOR ALL TO public USING ("source_qualifications"."tenant_id"::text = current_setting('app.tenant_id', true) and "source_qualifications"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("source_qualifications"."tenant_id"::text = current_setting('app.tenant_id', true) and "source_qualifications"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
ALTER TABLE "cloud_diagnostic_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cloud_inference_budgets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cloud_diagnostic_jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cloud_framework_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core_import_batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "core_lifecycle_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "source_qualifications" FORCE ROW LEVEL SECURITY;
