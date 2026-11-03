CREATE TABLE IF NOT EXISTS "core_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"exploration_id" uuid,
	"idempotency_key" text NOT NULL,
	"operation_type" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"basis_version" integer,
	"lease_expires_at" timestamp with time zone,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "claim_revisions" ADD COLUMN "evidence_status" text DEFAULT 'valid' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_revisions" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claim_revisions" ADD COLUMN "invalidation_reason" text;--> statement-breakpoint
ALTER TABLE "exploration_questions" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "exploration_questions" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "explorations" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "explorations" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "exploration_questions" AS q
SET
  "status" = 'answered',
  "answered_at" = answered."answered_at"
FROM (
  SELECT "question_id", max("created_at") AS "answered_at"
  FROM "exploration_turns"
  WHERE "question_id" IS NOT NULL AND "role" = 'user' AND "turn_kind" = 'answer'
  GROUP BY "question_id"
) AS answered
WHERE q."id" = answered."question_id";--> statement-breakpoint
WITH ranked_open AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "exploration_id"
      ORDER BY "sequence" DESC, "created_at" DESC
    ) AS rn
  FROM "exploration_questions"
  WHERE "status" = 'open'
)
UPDATE "exploration_questions" AS q
SET "status" = 'superseded'
FROM ranked_open
WHERE q."id" = ranked_open."id" AND ranked_open.rn > 1;--> statement-breakpoint
UPDATE "explorations" AS e
SET "last_activity_at" = COALESCE(
  (
    SELECT max(t."created_at")
    FROM "exploration_turns" AS t
    WHERE t."exploration_id" = e."id"
  ),
  e."created_at"
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core_operations" ADD CONSTRAINT "core_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core_operations" ADD CONSTRAINT "core_operations_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "core_operations" ADD CONSTRAINT "core_operations_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "core_operations_tenant_idempotency_unique" ON "core_operations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "core_operations_exploration_idx" ON "core_operations" USING btree ("exploration_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "core_operations_status_lease_idx" ON "core_operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "exploration_questions_one_open" ON "exploration_questions" USING btree ("exploration_id") WHERE "exploration_questions"."status" = 'open';