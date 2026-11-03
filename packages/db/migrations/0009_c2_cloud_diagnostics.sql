-- C2 schema only; NOT applied. Validate on an isolated database before deployment.
-- Supporting indices precede composite FKs; FORCE RLS is an explicit custom addition.
CREATE TABLE IF NOT EXISTS "diagnostic_report_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"basis_version" integer NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"format" text DEFAULT 'understanding-report@1' NOT NULL,
	"body" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnostic_reports_states" CHECK ("diagnostic_report_revisions"."status" in ('candidate','accepted','rejected','needs_review','withdrawn')),
	CONSTRAINT "diagnostic_reports_versions" CHECK ("diagnostic_report_revisions"."version" > 0 and "diagnostic_report_revisions"."basis_version" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "diagnostic_report_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"report_revision_id" uuid NOT NULL,
	"evidence_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"span_id" uuid NOT NULL,
	"assessment_version" integer NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "diagnostic_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"report_revision_id" uuid,
	"source_id" uuid,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"basis_version" integer NOT NULL,
	"result_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"processing_status" text DEFAULT 'recorded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnostic_responses_states" CHECK ("diagnostic_responses"."processing_status" in ('recorded','qualified','rejected','processed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "diagnostic_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'awaiting_input' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"head_version" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnostic_runs_versions" CHECK ("diagnostic_runs"."version" > 0 and "diagnostic_runs"."head_version" >= 0),
	CONSTRAINT "diagnostic_runs_states" CHECK ("diagnostic_runs"."status" in ('awaiting_input','pending','review_pending','ready','needs_review','archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_length" integer NOT NULL,
	"media_type" text NOT NULL,
	"status" text DEFAULT 'declared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "source_blobs_size" CHECK ("source_blobs"."byte_length" >= 0 and "source_blobs"."byte_length" <= 52428800),
	CONSTRAINT "source_blobs_states" CHECK ("source_blobs"."status" in ('declared','available','excluded','deleted'))
);
--> statement-breakpoint
ALTER TABLE "diagnostic_report_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "diagnostic_report_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "diagnostic_responses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "diagnostic_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "source_blobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_reports_scope_id" ON "diagnostic_report_revisions" USING btree ("tenant_id","subject_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_reports_run_version" ON "diagnostic_report_revisions" USING btree ("tenant_id","subject_id","run_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_report_evidence_unique" ON "diagnostic_report_sources" USING btree ("report_revision_id","evidence_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagnostic_report_source_dependencies" ON "diagnostic_report_sources" USING btree ("tenant_id","subject_id","source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_responses_idempotency" ON "diagnostic_responses" USING btree ("tenant_id","subject_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagnostic_responses_run_time" ON "diagnostic_responses" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_runs_scope_id" ON "diagnostic_runs" USING btree ("tenant_id","subject_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_runs_idempotency" ON "diagnostic_runs" USING btree ("tenant_id","subject_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diagnostic_runs_owner_updated" ON "diagnostic_runs" USING btree ("tenant_id","subject_id","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_blobs_object_key" ON "source_blobs" USING btree ("object_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_blobs_owner" ON "source_blobs" USING btree ("tenant_id","subject_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_spans_source_id_unique" ON "evidence_spans" USING btree ("source_item_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_items_scope_id_unique" ON "source_items" USING btree ("tenant_id","subject_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subjects_tenant_id_unique" ON "subjects" USING btree ("tenant_id","id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_report_revisions" ADD CONSTRAINT "diag_rev_run_fk" FOREIGN KEY ("tenant_id","subject_id","run_id") REFERENCES "public"."diagnostic_runs"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_report_sources" ADD CONSTRAINT "diag_ref_report_fk" FOREIGN KEY ("tenant_id","subject_id","report_revision_id") REFERENCES "public"."diagnostic_report_revisions"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_report_sources" ADD CONSTRAINT "diag_ref_source_fk" FOREIGN KEY ("tenant_id","subject_id","source_id") REFERENCES "public"."source_items"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_report_sources" ADD CONSTRAINT "diag_ref_span_fk" FOREIGN KEY ("source_id","span_id") REFERENCES "public"."evidence_spans"("source_item_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_report_sources" ADD CONSTRAINT "diag_ref_assessment_fk" FOREIGN KEY ("source_id","assessment_version") REFERENCES "public"."source_assessments"("source_item_id","version") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_responses" ADD CONSTRAINT "diag_response_run_fk" FOREIGN KEY ("tenant_id","subject_id","run_id") REFERENCES "public"."diagnostic_runs"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_responses" ADD CONSTRAINT "diag_response_report_fk" FOREIGN KEY ("tenant_id","subject_id","report_revision_id") REFERENCES "public"."diagnostic_report_revisions"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_responses" ADD CONSTRAINT "diag_response_source_fk" FOREIGN KEY ("tenant_id","subject_id","source_id") REFERENCES "public"."source_items"("tenant_id","subject_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "diagnostic_runs" ADD CONSTRAINT "diag_run_owner_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_blobs" ADD CONSTRAINT "source_blob_owner_fk" FOREIGN KEY ("tenant_id","subject_id") REFERENCES "public"."subjects"("tenant_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "diag_rev_scope" ON "diagnostic_report_revisions" AS PERMISSIVE FOR ALL TO public USING ("diagnostic_report_revisions"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_report_revisions"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("diagnostic_report_revisions"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_report_revisions"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "diag_ref_scope" ON "diagnostic_report_sources" AS PERMISSIVE FOR ALL TO public USING ("diagnostic_report_sources"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_report_sources"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("diagnostic_report_sources"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_report_sources"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "diag_response_scope" ON "diagnostic_responses" AS PERMISSIVE FOR ALL TO public USING ("diagnostic_responses"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_responses"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("diagnostic_responses"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_responses"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "diag_run_scope" ON "diagnostic_runs" AS PERMISSIVE FOR ALL TO public USING ("diagnostic_runs"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_runs"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("diagnostic_runs"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "diagnostic_runs"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
CREATE POLICY "source_blob_scope" ON "source_blobs" AS PERMISSIVE FOR ALL TO public USING ("source_blobs"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "source_blobs"."subject_id"::text = current_setting('app.subject_id', true)) WITH CHECK ("source_blobs"."tenant_id"::text = current_setting('app.tenant_id', true)
    and "source_blobs"."subject_id"::text = current_setting('app.subject_id', true));
--> statement-breakpoint
ALTER TABLE "diagnostic_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "diagnostic_report_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "diagnostic_report_sources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "diagnostic_responses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "source_blobs" FORCE ROW LEVEL SECURITY;
