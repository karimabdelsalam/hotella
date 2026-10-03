CREATE TYPE "hk"."cleaning_type" AS ENUM('STAYOVER', 'CHECKOUT', 'ARRIVAL', 'DEEP_CLEAN', 'TURNDOWN', 'TOUCH_UP', 'VIP', 'OTHER');--> statement-breakpoint
CREATE TYPE "hk"."inspection_result" AS ENUM('PASS', 'FAIL');--> statement-breakpoint
CREATE TYPE "hk"."job_origin" AS ENUM('GENERATED', 'STAFF', 'INSPECTION');--> statement-breakpoint
CREATE TYPE "hk"."job_status" AS ENUM('OPEN', 'IN_PROGRESS', 'DONE', 'INSPECTED', 'FAILED_INSPECTION', 'SKIPPED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "hk"."credit_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"cleaning_type" "hk"."cleaning_type" NOT NULL,
	"room_type_id" uuid,
	"credits" numeric(5, 2) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hk"."inspections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"result" "hk"."inspection_result" NOT NULL,
	"notes" text,
	"inspector_id" uuid,
	"inspected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hk"."jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"work_item_id" uuid,
	"room_id" uuid NOT NULL,
	"stay_id" uuid,
	"cleaning_type" "hk"."cleaning_type" NOT NULL,
	"origin" "hk"."job_origin" NOT NULL,
	"credits" numeric(5, 2) NOT NULL,
	"status" "hk"."job_status" DEFAULT 'OPEN' NOT NULL,
	"scheduled_for" date NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"inspected_at" timestamp with time zone,
	"skip_reason" varchar(200),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hk"."inspections" ADD CONSTRAINT "inspections_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "hk"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_rules_type_uq" ON "hk"."credit_rules" USING btree ("property_id","cleaning_type") WHERE "hk"."credit_rules"."room_type_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_rules_room_type_uq" ON "hk"."credit_rules" USING btree ("property_id","cleaning_type","room_type_id") WHERE "hk"."credit_rules"."room_type_id" is not null;--> statement-breakpoint
CREATE INDEX "inspections_job_idx" ON "hk"."inspections" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_generated_uq" ON "hk"."jobs" USING btree ("room_id","cleaning_type","scheduled_for") WHERE "hk"."jobs"."origin" = 'GENERATED';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_work_item_uq" ON "hk"."jobs" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "jobs_property_day_idx" ON "hk"."jobs" USING btree ("tenant_id","property_id","scheduled_for");--> statement-breakpoint
ALTER TABLE "hk"."jobs" ADD CONSTRAINT "jobs_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."credit_rules" ADD CONSTRAINT "credit_rules_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."inspections" ADD CONSTRAINT "inspections_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."jobs" ADD CONSTRAINT "jobs_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."credit_rules" ADD CONSTRAINT "credit_rules_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."inspections" ADD CONSTRAINT "inspections_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hk"."jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hk"."jobs" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "hk"."credit_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hk"."credit_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hk"."credit_rules" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "hk"."inspections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hk"."inspections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hk"."inspections" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "hk"."jobs" ADD CONSTRAINT "jobs_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."inspections" ADD CONSTRAINT "inspections_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."credit_rules" ADD CONSTRAINT "credit_rules_room_type_fk" FOREIGN KEY ("room_type_id") REFERENCES "org"."room_types"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."credit_rules" ADD CONSTRAINT "credit_rules_credits_range" CHECK ("credits" >= 0 AND "credits" <= 20);
--> statement-breakpoint
ALTER TABLE "hk"."jobs" ADD CONSTRAINT "jobs_credits_range" CHECK ("credits" >= 0 AND "credits" <= 20);
--> statement-breakpoint
CREATE FUNCTION "hk"."inspections_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An inspection is a record of what a supervisor found; it is never rewritten or deleted.
  RAISE EXCEPTION 'hk.inspections is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "inspections_no_update_delete" BEFORE UPDATE OR DELETE ON "hk"."inspections" FOR EACH ROW EXECUTE FUNCTION "hk"."inspections_append_only"();
