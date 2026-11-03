DROP INDEX IF EXISTS "light_extracts_source_record_unique";--> statement-breakpoint
ALTER TABLE "light_extracts" ADD COLUMN "async_task_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "light_extracts_async_task_unique" ON "light_extracts" USING btree ("async_task_id") WHERE "light_extracts"."async_task_id" is not null;