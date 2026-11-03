CREATE TABLE IF NOT EXISTS "exploration_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exploration_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"basis_version" integer NOT NULL,
	"input_turn_id" uuid,
	"current_reading" text NOT NULL,
	"key_uncertainty" text,
	"decision" text NOT NULL,
	"intent" text NOT NULL,
	"stop_reason" text,
	"question_id" uuid,
	"model_meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_item_id" uuid NOT NULL,
	"target_source_item_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_input_turn_id_exploration_turns_id_fk" FOREIGN KEY ("input_turn_id") REFERENCES "public"."exploration_turns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "exploration_steps" ADD CONSTRAINT "exploration_steps_question_id_exploration_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."exploration_questions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_links" ADD CONSTRAINT "source_links_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "source_links" ADD CONSTRAINT "source_links_target_source_item_id_source_items_id_fk" FOREIGN KEY ("target_source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exploration_steps_sequence_unique" ON "exploration_steps" USING btree ("exploration_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exploration_steps_exploration_idx" ON "exploration_steps" USING btree ("exploration_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_links_unique" ON "source_links" USING btree ("source_item_id","target_source_item_id","relation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_links_target_idx" ON "source_links" USING btree ("target_source_item_id","created_at");