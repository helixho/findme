CREATE TABLE IF NOT EXISTS "agent_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_key" text NOT NULL,
	"task_type" text NOT NULL,
	"prompt_template" text NOT NULL,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"model_route" text NOT NULL,
	"structured_output_strategy" text DEFAULT 'text_parse' NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb,
	"allowed_data_scope" jsonb DEFAULT '{}'::jsonb,
	"logging_policy" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_registry_agent_key_unique" UNIQUE("agent_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "async_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"insight_type" text NOT NULL,
	"content" text NOT NULL,
	"theoretical_frame" text,
	"evidence_refs" jsonb NOT NULL,
	"generation_meta" jsonb DEFAULT '{}'::jsonb,
	"acknowledgment_history" jsonb DEFAULT '[]'::jsonb,
	"revision_of" uuid,
	"visibility" text DEFAULT 'active' NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "light_extracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb,
	"emotion_hints" jsonb DEFAULT '[]'::jsonb,
	"mentioned_objects" jsonb DEFAULT '[]'::jsonb,
	"user_tags" jsonb DEFAULT '[]'::jsonb,
	"evidence_snippets" jsonb DEFAULT '[]'::jsonb,
	"confidence" real,
	"extraction_version" text NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_key" text NOT NULL,
	"prompt_version" integer,
	"model_used" text NOT NULL,
	"task_type" text,
	"token_usage" jsonb DEFAULT '{}'::jsonb,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"questionnaire_id" uuid,
	"prompt_text" text NOT NULL,
	"response_format" text NOT NULL,
	"response_options" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "questionnaires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"questionnaire_type" text NOT NULL,
	"source_meta" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"source_meta" jsonb DEFAULT '{}'::jsonb,
	"content" jsonb NOT NULL,
	"content_format" text DEFAULT 'plain_text' NOT NULL,
	"user_context" jsonb DEFAULT '{}'::jsonb,
	"visibility" text DEFAULT 'active' NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_category" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"safety_meta" jsonb DEFAULT '{}'::jsonb,
	"created_by" text DEFAULT 'user' NOT NULL,
	"visibility" text DEFAULT 'active' NOT NULL,
	"ext" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "safety_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger_type" text NOT NULL,
	"rule_id" text,
	"trigger_meta" jsonb DEFAULT '{}'::jsonb,
	"resources_shown" jsonb DEFAULT '[]'::jsonb,
	"user_acknowledged_at" timestamp with time zone,
	"ext" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "static_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"linked_refs" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor" text DEFAULT 'user' NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "type_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"value" text NOT NULL,
	"display_name" text,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "light_extracts" ADD CONSTRAINT "light_extracts_source_record_id_raw_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."raw_records"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "question_items" ADD CONSTRAINT "question_items_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_async_tasks_status" ON "async_tasks" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_insights_generated" ON "insights" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_insights_evidence_gin" ON "insights" USING gin ("evidence_refs");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_light_extracts_source" ON "light_extracts" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_light_extracts_extracted" ON "light_extracts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_raw_records_created" ON "raw_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_raw_records_source" ON "raw_records" USING btree ("source_type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_raw_records_visibility" ON "raw_records" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_safety_events_triggered" ON "safety_events" USING btree ("created_at");