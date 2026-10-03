CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TYPE "ops"."assignee_type" AS ENUM('USER', 'TEAM', 'AI', 'ROBOT');--> statement-breakpoint
CREATE TYPE "ops"."priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "ops"."task_status" AS ENUM('NEW', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'PAUSED', 'DONE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "ops"."work_item_status" AS ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "ops"."task_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"assignee_type" "ops"."assignee_type" NOT NULL,
	"assignee_id" uuid NOT NULL,
	"assigned_by_type" varchar(16) NOT NULL,
	"assigned_by_id" uuid,
	"assigned_at" timestamp with time zone NOT NULL,
	"reason" text,
	"unassigned_at" timestamp with time zone,
	"end_reason" varchar(16),
	CONSTRAINT "task_assignments_end_ck" CHECK (("ops"."task_assignments"."unassigned_at" IS NULL) = ("ops"."task_assignments"."end_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ops"."task_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"type" varchar(32) NOT NULL,
	"from_status" "ops"."task_status",
	"to_status" "ops"."task_status" NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"title_key" varchar(128),
	"title_params" jsonb,
	"title" text,
	"status" "ops"."task_status" DEFAULT 'NEW' NOT NULL,
	"priority" "ops"."priority" DEFAULT 'NORMAL' NOT NULL,
	"due_at" timestamp with time zone,
	"location_id" uuid,
	"department_code" varchar(32),
	"assignee_type" "ops"."assignee_type",
	"assignee_id" uuid,
	"pause_reason" varchar(64),
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tasks_title_ck" CHECK (("ops"."tasks"."title_key" IS NOT NULL) <> ("ops"."tasks"."title" IS NOT NULL)),
	CONSTRAINT "tasks_assignee_ck" CHECK (("ops"."tasks"."assignee_type" IS NULL) = ("ops"."tasks"."assignee_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ops"."work_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"source_module" varchar(32) NOT NULL,
	"source_entity_type" varchar(64) NOT NULL,
	"source_entity_id" uuid,
	"title_key" varchar(128),
	"title_params" jsonb,
	"title" text,
	"status" "ops"."work_item_status" DEFAULT 'OPEN' NOT NULL,
	"priority" "ops"."priority" DEFAULT 'NORMAL' NOT NULL,
	"location_id" uuid,
	"guest_id" uuid,
	"stay_id" uuid,
	"department_code" varchar(32),
	"workflow_instance_id" uuid,
	"sla_instance_id" uuid,
	"created_by_type" varchar(16) NOT NULL,
	"created_by_id" uuid,
	"correlation_id" varchar(64),
	"resolved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "work_items_title_ck" CHECK (("ops"."work_items"."title_key" IS NOT NULL) <> ("ops"."work_items"."title" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "org"."department_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "department_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "org"."departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"status" "org"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "departments_property_code_uq" UNIQUE("property_id","code")
);
--> statement-breakpoint
ALTER TABLE "ops"."task_assignments" ADD CONSTRAINT "task_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "ops"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "ops"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."tasks" ADD CONSTRAINT "tasks_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "ops"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."department_translations" ADD CONSTRAINT "department_translations_entity_id_departments_id_fk" FOREIGN KEY ("entity_id") REFERENCES "org"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."departments" ADD CONSTRAINT "departments_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."departments" ADD CONSTRAINT "departments_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_assignments_task_idx" ON "ops"."task_assignments" USING btree ("task_id","assigned_at");--> statement-breakpoint
CREATE INDEX "task_assignments_assignee_idx" ON "ops"."task_assignments" USING btree ("assignee_type","assignee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_assignments_open_uq" ON "ops"."task_assignments" USING btree ("task_id") WHERE "ops"."task_assignments"."unassigned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "ops"."task_events" USING btree ("task_id","occurred_at");--> statement-breakpoint
CREATE INDEX "tasks_work_item_idx" ON "ops"."tasks" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "ops"."tasks" USING btree ("assignee_type","assignee_id","status");--> statement-breakpoint
CREATE INDEX "tasks_property_status_idx" ON "ops"."tasks" USING btree ("property_id","status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_department_idx" ON "ops"."tasks" USING btree ("property_id","department_code","status");--> statement-breakpoint
CREATE INDEX "work_items_property_status_idx" ON "ops"."work_items" USING btree ("property_id","status","created_at");--> statement-breakpoint
CREATE INDEX "work_items_source_idx" ON "ops"."work_items" USING btree ("tenant_id","source_entity_type","source_entity_id");--> statement-breakpoint
CREATE INDEX "work_items_stay_idx" ON "ops"."work_items" USING btree ("stay_id");
--> statement-breakpoint
-- Hand-written (reviewed): integrity across contexts (tenants, properties, locations, departments, stays, guests),
-- history sanity, append-only task history and row-level security as in migration 0006.
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."tasks" ADD CONSTRAINT "tasks_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."tasks" ADD CONSTRAINT "tasks_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."task_assignments" ADD CONSTRAINT "task_assignments_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."task_assignments" ADD CONSTRAINT "task_assignments_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."task_events" ADD CONSTRAINT "task_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."task_events" ADD CONSTRAINT "task_events_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_location_fk" FOREIGN KEY ("location_id") REFERENCES "org"."locations"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_department_fk" FOREIGN KEY ("property_id","department_code") REFERENCES "org"."departments"("property_id","code") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."tasks" ADD CONSTRAINT "tasks_location_fk" FOREIGN KEY ("location_id") REFERENCES "org"."locations"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."tasks" ADD CONSTRAINT "tasks_department_fk" FOREIGN KEY ("property_id","department_code") REFERENCES "org"."departments"("property_id","code") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_stay_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ADD CONSTRAINT "work_items_guest_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."task_assignments" ADD CONSTRAINT "task_assignments_period_ck" CHECK ("unassigned_at" IS NULL OR "unassigned_at" >= "assigned_at");
--> statement-breakpoint
CREATE FUNCTION "ops"."task_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Operational history (CLAUDE.md rule 10): never deleted or rewritten. The only permitted update clears a free-text
  -- reason when the person it quotes is anonymized (Spec §69).
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ops.task_events is append-only';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.property_id, NEW.task_id, NEW.type, NEW.from_status, NEW.to_status, NEW.actor_type,
      NEW.actor_id, NEW.payload, NEW.occurred_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.property_id, OLD.task_id, OLD.type, OLD.from_status, OLD.to_status, OLD.actor_type,
      OLD.actor_id, OLD.payload, OLD.occurred_at, OLD.created_at)
     OR (NEW.reason IS NOT NULL AND NEW.reason IS DISTINCT FROM OLD.reason) THEN
    RAISE EXCEPTION 'ops.task_events is append-only';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "task_events_append_only" BEFORE UPDATE OR DELETE ON "ops"."task_events" FOR EACH ROW EXECUTE FUNCTION "ops"."task_events_append_only"();
--> statement-breakpoint
ALTER TABLE "ops"."work_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."work_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."work_items" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."tasks" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."task_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."task_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."task_assignments" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."task_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."task_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."task_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "org"."departments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."departments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."departments" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
