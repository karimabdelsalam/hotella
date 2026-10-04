CREATE TYPE "integration"."commissioning_run_status" AS ENUM('PASSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "integration"."commissioning_sheet_status" AS ENUM('MATCH', 'GAP', 'CHANGE_REQUIRED', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TABLE "integration"."commissioning_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"connector_code" varchar(48) NOT NULL,
	"status" "integration"."commissioning_run_status" NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "integration"."commissioning_sheet_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"requirement" varchar(64) NOT NULL,
	"status" "integration"."commissioning_sheet_status" NOT NULL,
	"hotel_value" varchar(500),
	"note" varchar(1000),
	"recorded_by_type" varchar(16) NOT NULL,
	"recorded_by_id" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_runs" ADD CONSTRAINT "commissioning_runs_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commissioning_runs_instance_idx" ON "integration"."commissioning_runs" USING btree ("instance_id","started_at");--> statement-breakpoint
CREATE INDEX "commissioning_sheet_rows_property_idx" ON "integration"."commissioning_sheet_rows" USING btree ("property_id","requirement","created_at");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity and row-level security as in migration 0006. Interface settings,
-- counts and reasons only; sheet rows are append-only (the latest per requirement is current).
ALTER TABLE "integration"."commissioning_sheet_rows" ADD CONSTRAINT "commissioning_sheet_rows_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_sheet_rows" ADD CONSTRAINT "commissioning_sheet_rows_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_runs" ADD CONSTRAINT "commissioning_runs_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_runs" ADD CONSTRAINT "commissioning_runs_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_runs" ADD CONSTRAINT "commissioning_runs_checks_ck" CHECK (jsonb_typeof("checks") = 'array' AND "finished_at" >= "started_at");
--> statement-breakpoint
CREATE TRIGGER "commissioning_sheet_rows_no_update" BEFORE UPDATE ON "integration"."commissioning_sheet_rows" FOR EACH ROW EXECUTE FUNCTION "platform"."reject_history_mutation"();
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_sheet_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_sheet_rows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."commissioning_sheet_rows" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."commissioning_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."commissioning_runs" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
