CREATE TYPE "eng"."warranty_status" AS ENUM('SUGGESTED', 'OPENED', 'CLOSED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "eng"."work_order_source" AS ENUM('STAFF', 'GUEST_REQUEST', 'PM', 'INSPECTION', 'AI');--> statement-breakpoint
CREATE TYPE "eng"."work_order_status" AS ENUM('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "eng"."work_order_type" AS ENUM('CORRECTIVE', 'PREVENTIVE', 'PREDICTIVE', 'INSPECTION', 'EMERGENCY', 'PROJECT');--> statement-breakpoint
CREATE TABLE "eng"."part_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"work_order_id" uuid,
	"kind" varchar(16) NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"part_number" varchar(60) NOT NULL,
	"name" varchar(200) NOT NULL,
	"unit" varchar(16) DEFAULT 'EA' NOT NULL,
	"on_hand" numeric(12, 2) DEFAULT 0 NOT NULL,
	"reorder_level" numeric(12, 2) DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."warranty_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"warranty_until" date NOT NULL,
	"status" "eng"."warranty_status" DEFAULT 'SUGGESTED' NOT NULL,
	"note" varchar(500),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."work_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"work_item_id" uuid NOT NULL,
	"type" "eng"."work_order_type" NOT NULL,
	"source" "eng"."work_order_source" NOT NULL,
	"asset_id" uuid,
	"location_id" uuid NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"symptom_code" varchar(60),
	"diagnosis" text,
	"failure_mode_code" varchar(60),
	"cause_code" varchar(60),
	"resolution_code" varchar(60),
	"downtime_started_at" timestamp with time zone,
	"downtime_ended_at" timestamp with time zone,
	"status" "eng"."work_order_status" DEFAULT 'OPEN' NOT NULL,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eng"."part_movements" ADD CONSTRAINT "part_movements_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "eng"."parts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."part_movements" ADD CONSTRAINT "part_movements_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "eng"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."warranty_cases" ADD CONSTRAINT "warranty_cases_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "eng"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."warranty_cases" ADD CONSTRAINT "warranty_cases_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "eng"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD CONSTRAINT "work_orders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "eng"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "part_movements_part_idx" ON "eng"."part_movements" USING btree ("part_id","occurred_at");--> statement-breakpoint
CREATE INDEX "part_movements_work_order_idx" ON "eng"."part_movements" USING btree ("work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parts_number_uq" ON "eng"."parts" USING btree ("property_id","part_number");--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_cases_work_order_uq" ON "eng"."warranty_cases" USING btree ("work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_work_item_uq" ON "eng"."work_orders" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_number_uq" ON "eng"."work_orders" USING btree ("property_id","number");--> statement-breakpoint
CREATE INDEX "work_orders_asset_idx" ON "eng"."work_orders" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE INDEX "work_orders_property_idx" ON "eng"."work_orders" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD CONSTRAINT "work_orders_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."parts" ADD CONSTRAINT "parts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."part_movements" ADD CONSTRAINT "part_movements_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."warranty_cases" ADD CONSTRAINT "warranty_cases_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD CONSTRAINT "work_orders_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."parts" ADD CONSTRAINT "parts_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."part_movements" ADD CONSTRAINT "part_movements_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."warranty_cases" ADD CONSTRAINT "warranty_cases_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."work_orders" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."parts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."parts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."parts" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."part_movements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."part_movements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."part_movements" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."warranty_cases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."warranty_cases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."warranty_cases" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD CONSTRAINT "work_orders_location_fk" FOREIGN KEY ("location_id") REFERENCES "org"."locations"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."work_orders" ADD CONSTRAINT "work_orders_downtime_order" CHECK ("downtime_ended_at" IS NULL OR "downtime_started_at" IS NULL OR "downtime_ended_at" >= "downtime_started_at");
--> statement-breakpoint
ALTER TABLE "eng"."parts" ADD CONSTRAINT "parts_on_hand_not_negative" CHECK ("on_hand" >= 0 AND "reorder_level" >= 0);
--> statement-breakpoint
ALTER TABLE "eng"."part_movements" ADD CONSTRAINT "part_movements_kind" CHECK ("kind" IN ('USAGE', 'RECEIPT') AND "quantity" > 0);
--> statement-breakpoint
CREATE FUNCTION "eng"."part_movements_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Stock history is evidence (CLAUDE.md rule 10): corrections are new movements, never edits.
  RAISE EXCEPTION 'eng.part_movements is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "part_movements_no_update_delete" BEFORE UPDATE OR DELETE ON "eng"."part_movements" FOR EACH ROW EXECUTE FUNCTION "eng"."part_movements_append_only"();
