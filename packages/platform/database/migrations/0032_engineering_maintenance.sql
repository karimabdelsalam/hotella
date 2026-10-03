CREATE TYPE "eng"."meter_kind" AS ENUM('RUNTIME_HOURS', 'CYCLES', 'ENERGY_KWH', 'TEMPERATURE', 'PRESSURE');--> statement-breakpoint
CREATE TYPE "eng"."pms_sync_status" AS ENUM('NOT_REQUIRED', 'PENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "eng"."procedure_status" AS ENUM('DRAFT', 'PUBLISHED');--> statement-breakpoint
CREATE TYPE "eng"."reading_source" AS ENUM('STAFF', 'IOT', 'BMS', 'API');--> statement-breakpoint
CREATE TYPE "eng"."restriction_kind" AS ENUM('OOO', 'OOS', 'BLOCKED_OPERATIONALLY');--> statement-breakpoint
CREATE TABLE "eng"."meter_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"meter_id" uuid NOT NULL,
	"value" numeric(14, 3) NOT NULL,
	"reset" boolean DEFAULT false NOT NULL,
	"source" "eng"."reading_source" NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"read_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."meters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" "eng"."meter_kind" NOT NULL,
	"unit" varchar(16) NOT NULL,
	"last_value" numeric(14, 3),
	"last_read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eng"."pm_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"trigger" jsonb NOT NULL,
	"lead_days" integer DEFAULT 0 NOT NULL,
	"last_done_on" date NOT NULL,
	"last_done_value" numeric(14, 3),
	"open_work_order_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."pm_procedure_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "eng"."procedure_status" DEFAULT 'DRAFT' NOT NULL,
	"steps" jsonb NOT NULL,
	"estimated_minutes" integer,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eng"."pm_procedures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"title" varchar(200) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."room_restrictions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"kind" "eng"."restriction_kind" NOT NULL,
	"reason" varchar(300) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"work_order_id" uuid,
	"pms_sync" "eng"."pms_sync_status" DEFAULT 'NOT_REQUIRED' NOT NULL,
	"created_by_type" varchar(16) NOT NULL,
	"created_by_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_type" varchar(16),
	"released_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD COLUMN "pm_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD COLUMN "procedure_version_id" uuid;--> statement-breakpoint
ALTER TABLE "eng"."meter_readings" ADD CONSTRAINT "meter_readings_meter_id_meters_id_fk" FOREIGN KEY ("meter_id") REFERENCES "eng"."meters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."meters" ADD CONSTRAINT "meters_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "eng"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."pm_plans" ADD CONSTRAINT "pm_plans_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "eng"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."pm_plans" ADD CONSTRAINT "pm_plans_procedure_id_pm_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "eng"."pm_procedures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."pm_procedure_versions" ADD CONSTRAINT "pm_procedure_versions_procedure_id_pm_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "eng"."pm_procedures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."room_restrictions" ADD CONSTRAINT "room_restrictions_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "eng"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meter_readings_meter_idx" ON "eng"."meter_readings" USING btree ("meter_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meters_asset_kind_uq" ON "eng"."meters" USING btree ("asset_id","kind");--> statement-breakpoint
CREATE INDEX "pm_plans_property_idx" ON "eng"."pm_plans" USING btree ("tenant_id","property_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "pm_procedure_versions_uq" ON "eng"."pm_procedure_versions" USING btree ("procedure_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pm_procedures_code_uq" ON "eng"."pm_procedures" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "room_restrictions_open_uq" ON "eng"."room_restrictions" USING btree ("room_id") WHERE "eng"."room_restrictions"."released_at" is null;--> statement-breakpoint
CREATE INDEX "room_restrictions_property_idx" ON "eng"."room_restrictions" USING btree ("tenant_id","property_id");--> statement-breakpoint
ALTER TABLE "eng"."meters" ADD CONSTRAINT "meters_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."meter_readings" ADD CONSTRAINT "meter_readings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."pm_procedures" ADD CONSTRAINT "pm_procedures_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."pm_procedure_versions" ADD CONSTRAINT "pm_procedure_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."pm_plans" ADD CONSTRAINT "pm_plans_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."room_restrictions" ADD CONSTRAINT "room_restrictions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."meters" ADD CONSTRAINT "meters_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."meter_readings" ADD CONSTRAINT "meter_readings_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."pm_plans" ADD CONSTRAINT "pm_plans_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."room_restrictions" ADD CONSTRAINT "room_restrictions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."meters" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."meters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."meters" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."meter_readings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."meter_readings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."meter_readings" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."pm_procedures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."pm_procedures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."pm_procedures" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."pm_procedure_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."pm_procedure_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."pm_procedure_versions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."pm_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."pm_plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."pm_plans" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."room_restrictions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."room_restrictions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."room_restrictions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."room_restrictions" ADD CONSTRAINT "room_restrictions_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."room_restrictions" ADD CONSTRAINT "room_restrictions_period" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD CONSTRAINT "work_orders_pm_plan_fk" FOREIGN KEY ("pm_plan_id") REFERENCES "eng"."pm_plans"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD CONSTRAINT "work_orders_procedure_version_fk" FOREIGN KEY ("procedure_version_id") REFERENCES "eng"."pm_procedure_versions"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."pm_plans" ADD CONSTRAINT "pm_plans_lead_days" CHECK ("lead_days" BETWEEN 0 AND 60);
--> statement-breakpoint
CREATE FUNCTION "eng"."meter_readings_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Readings are evidence for preventive maintenance and reliability; a wrong reading is followed by a new one.
  RAISE EXCEPTION 'eng.meter_readings is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "meter_readings_no_update_delete" BEFORE UPDATE OR DELETE ON "eng"."meter_readings" FOR EACH ROW EXECUTE FUNCTION "eng"."meter_readings_append_only"();
--> statement-breakpoint
CREATE FUNCTION "eng"."pm_procedure_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A published procedure version never changes (CLAUDE.md rule 9); publishing itself is the last allowed update.
  IF TG_OP = 'DELETE' AND OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'eng.pm_procedure_versions: a published version is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'eng.pm_procedure_versions: a published version is immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "pm_procedure_versions_immutable" BEFORE UPDATE OR DELETE ON "eng"."pm_procedure_versions" FOR EACH ROW EXECUTE FUNCTION "eng"."pm_procedure_versions_immutable"();
