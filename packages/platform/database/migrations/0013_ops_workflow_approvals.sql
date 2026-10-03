CREATE TYPE "ops"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "ops"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "ops"."workflow_instance_status" AS ENUM('RUNNING', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "ops"."workflow_version_status" AS ENUM('DRAFT', 'PUBLISHED', 'RETIRED');--> statement-breakpoint
CREATE TABLE "ops"."approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"subject_type" varchar(64) NOT NULL,
	"subject_id" uuid,
	"work_item_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_level" "ops"."risk_level" NOT NULL,
	"status" "ops"."approval_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" uuid,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by_type" varchar(16),
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"executed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."workflow_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"status" "ops"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."workflow_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"current_state" varchar(64) NOT NULL,
	"status" "ops"."workflow_instance_status" DEFAULT 'RUNNING' NOT NULL,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."workflow_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"from_state" varchar(64),
	"to_state" varchar(64) NOT NULL,
	"trigger" varchar(80) NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."workflow_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"status" "ops"."workflow_version_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "ops"."approval_requests" ADD CONSTRAINT "approval_requests_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "ops"."work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."workflow_instances" ADD CONSTRAINT "workflow_instances_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "ops"."workflow_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."workflow_instances" ADD CONSTRAINT "workflow_instances_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "ops"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."workflow_transitions" ADD CONSTRAINT "workflow_transitions_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "ops"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."workflow_versions" ADD CONSTRAINT "workflow_versions_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "ops"."workflow_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_property_status_idx" ON "ops"."approval_requests" USING btree ("property_id","status","created_at");--> statement-breakpoint
CREATE INDEX "approval_requests_pending_expiry_idx" ON "ops"."approval_requests" USING btree ("expires_at") WHERE "ops"."approval_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "approval_requests_work_item_idx" ON "ops"."approval_requests" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_property_code_uq" ON "ops"."workflow_definitions" USING btree ("property_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_instances_work_item_uq" ON "ops"."workflow_instances" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "workflow_transitions_instance_idx" ON "ops"."workflow_transitions" USING btree ("instance_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_definition_version_uq" ON "ops"."workflow_versions" USING btree ("definition_id","version");
--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, the work item → workflow link, immutable published workflow
-- versions (CLAUDE.md rule 9), append-only workflow history and row-level security as in migration 0006.
ALTER TABLE "ops"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_versions" ADD CONSTRAINT "workflow_versions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_instances" ADD CONSTRAINT "workflow_instances_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_instances" ADD CONSTRAINT "workflow_instances_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_transitions" ADD CONSTRAINT "workflow_transitions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_transitions" ADD CONSTRAINT "workflow_transitions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."approval_requests" ADD CONSTRAINT "approval_requests_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."approval_requests" ADD CONSTRAINT "approval_requests_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_workflow_instance_fk" FOREIGN KEY ("workflow_instance_id") REFERENCES "ops"."workflow_instances"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_versions" ADD CONSTRAINT "workflow_versions_published_ck" CHECK (("status" = 'DRAFT') = ("published_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "ops"."approval_requests" ADD CONSTRAINT "approval_requests_decision_ck" CHECK (("status" IN ('PENDING', 'CANCELLED')) OR "decided_at" IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION "ops"."workflow_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A published version is frozen (CLAUDE.md rule 9): the only change left is retiring it.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'published workflow versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       (NEW.id, NEW.tenant_id, NEW.property_id, NEW.definition_id, NEW.version, NEW.definition, NEW.published_at,
        NEW.published_by_id, NEW.created_by_id)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.property_id, OLD.definition_id, OLD.version, OLD.definition, OLD.published_at,
        OLD.published_by_id, OLD.created_by_id)
       OR NOT (NEW.status = OLD.status OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'))) THEN
    RAISE EXCEPTION 'published workflow versions are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "workflow_versions_immutable" BEFORE UPDATE OR DELETE ON "ops"."workflow_versions" FOR EACH ROW EXECUTE FUNCTION "ops"."workflow_versions_immutable"();
--> statement-breakpoint
CREATE FUNCTION "ops"."workflow_transitions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ops.workflow_transitions is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER "workflow_transitions_append_only" BEFORE UPDATE OR DELETE ON "ops"."workflow_transitions" FOR EACH ROW EXECUTE FUNCTION "ops"."workflow_transitions_append_only"();
--> statement-breakpoint
ALTER TABLE "ops"."workflow_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."workflow_definitions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."workflow_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."workflow_versions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."workflow_instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."workflow_instances" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."workflow_transitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."workflow_transitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."workflow_transitions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."approval_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."approval_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."approval_requests" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
