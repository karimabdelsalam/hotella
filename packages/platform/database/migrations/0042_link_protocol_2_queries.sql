CREATE TYPE "integration"."query_status" AS ENUM('PENDING', 'SENT', 'ANSWERED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "integration"."integration_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"query_type" varchar(64) NOT NULL,
	"params" jsonb NOT NULL,
	"status" "integration"."query_status" DEFAULT 'PENDING' NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"row_count" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"error" varchar(1000),
	"routing" jsonb,
	"correlation_id" varchar(128),
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "integration"."agent_links" ADD COLUMN "agent_protocol" integer;--> statement-breakpoint
ALTER TABLE "integration"."connector_definitions" ADD COLUMN "queries" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "integration"."integration_queries" ADD CONSTRAINT "integration_queries_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_queries_pending_idx" ON "integration"."integration_queries" USING btree ("instance_id","status");--> statement-breakpoint
CREATE INDEX "integration_queries_created_idx" ON "integration"."integration_queries" USING btree ("created_at");;--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity and row-level security as in migration 0006; an answer is kept
-- only while it waits for its asker (cleared on read, swept after minutes).
ALTER TABLE "integration"."integration_queries" ADD CONSTRAINT "integration_queries_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_queries" ADD CONSTRAINT "integration_queries_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_queries" ADD CONSTRAINT "integration_queries_result_ck" CHECK ("result" IS NULL OR "status" = 'ANSWERED');
--> statement-breakpoint
ALTER TABLE "integration"."integration_queries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."integration_queries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."integration_queries" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
