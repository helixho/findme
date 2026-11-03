CREATE UNIQUE INDEX IF NOT EXISTS "questionnaires_name_unique" ON "questionnaires" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "static_materials_title_unique" ON "static_materials" USING btree ("title");--> statement-breakpoint
ALTER TABLE "async_tasks" ADD CONSTRAINT "async_tasks_status_check" CHECK ("status" in ('pending', 'running', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_visibility_check" CHECK ("visibility" in ('active', 'hidden', 'archived'));--> statement-breakpoint
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_visibility_check" CHECK ("visibility" in ('active', 'hidden', 'archived')); 
