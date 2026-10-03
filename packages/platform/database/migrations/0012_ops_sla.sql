CREATE TYPE "ops"."active_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "ops"."alert_severity" AS ENUM('INFO', 'WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "ops"."alert_status" AS ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "ops"."sla_status" AS ENUM('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "ops"."alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"severity" "ops"."alert_severity" NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"status" "ops"."alert_status" DEFAULT 'OPEN' NOT NULL,
	"subject_type" varchar(64),
	"subject_id" uuid,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"acknowledged_by_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_by_type" varchar(16),
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."business_hours" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"schedule" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."escalations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"sla_instance_id" uuid NOT NULL,
	"trigger" varchar(32) NOT NULL,
	"level" integer NOT NULL,
	"severity" "ops"."alert_severity" NOT NULL,
	"notify_roles" text[] NOT NULL,
	"alert_id" uuid,
	"triggered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."sla_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"calendar" jsonb NOT NULL,
	"response_minutes" integer,
	"resolution_minutes" integer NOT NULL,
	"pause_reasons" text[] NOT NULL,
	"escalation_rules" jsonb NOT NULL,
	"status" "ops"."sla_status" DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"response_due_at" timestamp with time zone,
	"resolution_due_at" timestamp with time zone NOT NULL,
	"response_met_at" timestamp with time zone,
	"resolution_met_at" timestamp with time zone,
	"response_breached_at" timestamp with time zone,
	"resolution_breached_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."sla_pauses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"sla_instance_id" uuid NOT NULL,
	"reason" varchar(64) NOT NULL,
	"paused_at" timestamp with time zone NOT NULL,
	"resumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."sla_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"match_kind" varchar(64),
	"match_service_code" varchar(64),
	"match_department_code" varchar(32),
	"match_priority" "ops"."priority",
	"response_minutes" integer,
	"resolution_minutes" integer NOT NULL,
	"business_hours_id" uuid,
	"pause_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"escalation_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "ops"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sla_policies_minutes_ck" CHECK ("ops"."sla_policies"."resolution_minutes" > 0 AND ("ops"."sla_policies"."response_minutes" IS NULL OR "ops"."sla_policies"."response_minutes" > 0))
);
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD COLUMN "service_code" varchar(64);--> statement-breakpoint
ALTER TABLE "ops"."escalations" ADD CONSTRAINT "escalations_sla_instance_id_sla_instances_id_fk" FOREIGN KEY ("sla_instance_id") REFERENCES "ops"."sla_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."escalations" ADD CONSTRAINT "escalations_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "ops"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sla_instances" ADD CONSTRAINT "sla_instances_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "ops"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sla_instances" ADD CONSTRAINT "sla_instances_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "ops"."sla_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sla_pauses" ADD CONSTRAINT "sla_pauses_sla_instance_id_sla_instances_id_fk" FOREIGN KEY ("sla_instance_id") REFERENCES "ops"."sla_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."sla_policies" ADD CONSTRAINT "sla_policies_business_hours_id_business_hours_id_fk" FOREIGN KEY ("business_hours_id") REFERENCES "ops"."business_hours"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_dedupe_uq" ON "ops"."alerts" USING btree ("tenant_id","dedupe_key") WHERE "ops"."alerts"."status" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "alerts_property_status_idx" ON "ops"."alerts" USING btree ("property_id","status","last_seen_at");--> statement-breakpoint
CREATE INDEX "alerts_subject_idx" ON "ops"."alerts" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_hours_property_code_uq" ON "ops"."business_hours" USING btree ("property_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_step_uq" ON "ops"."escalations" USING btree ("sla_instance_id","trigger","level");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_instances_work_item_uq" ON "ops"."sla_instances" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "sla_instances_due_idx" ON "ops"."sla_instances" USING btree ("next_check_at") WHERE "ops"."sla_instances"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "sla_pauses_instance_idx" ON "ops"."sla_pauses" USING btree ("sla_instance_id","paused_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_pauses_open_uq" ON "ops"."sla_pauses" USING btree ("sla_instance_id") WHERE "ops"."sla_pauses"."resumed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policies_property_code_uq" ON "ops"."sla_policies" USING btree ("property_id","code");--> statement-breakpoint
CREATE INDEX "sla_policies_property_status_idx" ON "ops"."sla_policies" USING btree ("property_id","status");
--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, the work item → SLA link, pause history sanity and row-level
-- security as in migration 0006.
ALTER TABLE "ops"."business_hours" ADD CONSTRAINT "business_hours_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."business_hours" ADD CONSTRAINT "business_hours_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."sla_policies" ADD CONSTRAINT "sla_policies_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."sla_policies" ADD CONSTRAINT "sla_policies_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."sla_instances" ADD CONSTRAINT "sla_instances_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."sla_instances" ADD CONSTRAINT "sla_instances_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."sla_pauses" ADD CONSTRAINT "sla_pauses_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."sla_pauses" ADD CONSTRAINT "sla_pauses_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."escalations" ADD CONSTRAINT "escalations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."escalations" ADD CONSTRAINT "escalations_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_sla_instance_fk" FOREIGN KEY ("sla_instance_id") REFERENCES "ops"."sla_instances"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "ops"."sla_pauses" ADD CONSTRAINT "sla_pauses_period_ck" CHECK ("resumed_at" IS NULL OR "resumed_at" >= "paused_at");
--> statement-breakpoint
ALTER TABLE "ops"."alerts" ADD CONSTRAINT "alerts_seen_ck" CHECK ("last_seen_at" >= "first_seen_at" AND "occurrences" >= 1);
--> statement-breakpoint
ALTER TABLE "ops"."business_hours" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."business_hours" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."business_hours" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."sla_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."sla_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."sla_policies" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."sla_instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."sla_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."sla_instances" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."sla_pauses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."sla_pauses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."sla_pauses" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."alerts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."alerts" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."escalations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."escalations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."escalations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
