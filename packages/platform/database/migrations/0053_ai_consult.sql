ALTER TABLE "ai"."executions" ADD COLUMN "parent_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "ai"."executions" ADD CONSTRAINT "executions_parent_fk" FOREIGN KEY ("parent_execution_id") REFERENCES "ai"."executions"("id") ON DELETE restrict;
