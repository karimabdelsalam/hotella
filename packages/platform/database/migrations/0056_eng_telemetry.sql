CREATE TYPE "eng"."telemetry_action" AS ENUM('ALERT', 'WORK_ORDER');--> statement-breakpoint
CREATE TYPE "eng"."telemetry_alarm_status" AS ENUM('OPEN', 'ACKNOWLEDGED', 'CLEARED');--> statement-breakpoint
CREATE TYPE "eng"."telemetry_point_status" AS ENUM('ACTIVE', 'IGNORED');--> statement-breakpoint
CREATE TYPE "eng"."telemetry_quantity" AS ENUM('TEMPERATURE', 'HUMIDITY', 'POWER', 'ENERGY', 'WATER_FLOW', 'PRESSURE', 'CO2', 'OCCUPANCY', 'DOOR', 'LEAK', 'ALARM', 'OTHER');--> statement-breakpoint
CREATE TYPE "eng"."telemetry_rule_kind" AS ENUM('THRESHOLD', 'RATE', 'STUCK', 'MISSING');--> statement-breakpoint
CREATE TYPE "eng"."telemetry_rule_status" AS ENUM('ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "eng"."telemetry_severity" AS ENUM('WARNING', 'CRITICAL');--> statement-breakpoint
ALTER TYPE "eng"."work_order_source" ADD VALUE 'TELEMETRY';--> statement-breakpoint
ALTER TYPE "integration"."mapping_type" ADD VALUE 'POINT';--> statement-breakpoint
CREATE TABLE "eng"."telemetry_alarms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"point_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"status" "eng"."telemetry_alarm_status" DEFAULT 'OPEN' NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"value" double precision,
	"peak" double precision,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"cleared_at" timestamp with time zone,
	"work_order_id" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."telemetry_minutes" (
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"point_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"min" double precision NOT NULL,
	"max" double precision NOT NULL,
	"sum" double precision NOT NULL,
	"samples" integer NOT NULL,
	"last" double precision NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telemetry_minutes_pk" PRIMARY KEY("point_id","minute")
) PARTITION BY RANGE ("minute");
--> statement-breakpoint
CREATE TABLE "eng"."telemetry_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"external_code" varchar(64) NOT NULL,
	"name" varchar(200),
	"asset_id" uuid,
	"location_id" uuid,
	"quantity" "eng"."telemetry_quantity" NOT NULL,
	"unit" varchar(16) NOT NULL,
	"status" "eng"."telemetry_point_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_value" double precision,
	"last_at" timestamp with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."telemetry_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"point_id" uuid NOT NULL,
	"kind" "eng"."telemetry_rule_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"severity" "eng"."telemetry_severity" NOT NULL,
	"action" "eng"."telemetry_action" NOT NULL,
	"status" "eng"."telemetry_rule_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eng"."telemetry_alarms" ADD CONSTRAINT "telemetry_alarms_point_id_telemetry_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "eng"."telemetry_points"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_alarms" ADD CONSTRAINT "telemetry_alarms_rule_id_telemetry_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "eng"."telemetry_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_alarms" ADD CONSTRAINT "telemetry_alarms_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "eng"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_minutes" ADD CONSTRAINT "telemetry_minutes_point_id_telemetry_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "eng"."telemetry_points"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_points" ADD CONSTRAINT "telemetry_points_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "eng"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_rules" ADD CONSTRAINT "telemetry_rules_point_id_telemetry_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "eng"."telemetry_points"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_alarms_live_uq" ON "eng"."telemetry_alarms" USING btree ("rule_id") WHERE "eng"."telemetry_alarms"."status" <> 'CLEARED';--> statement-breakpoint
CREATE INDEX "telemetry_alarms_property_idx" ON "eng"."telemetry_alarms" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_points_code_uq" ON "eng"."telemetry_points" USING btree ("instance_id","external_code");--> statement-breakpoint
CREATE INDEX "telemetry_points_property_idx" ON "eng"."telemetry_points" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "telemetry_rules_point_idx" ON "eng"."telemetry_rules" USING btree ("point_id","status");;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_points" ADD CONSTRAINT "telemetry_points_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_minutes" ADD CONSTRAINT "telemetry_minutes_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_rules" ADD CONSTRAINT "telemetry_rules_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_alarms" ADD CONSTRAINT "telemetry_alarms_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_points" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_points" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."telemetry_points" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "eng"."telemetry_minutes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_minutes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."telemetry_minutes" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "eng"."telemetry_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."telemetry_rules" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "eng"."telemetry_alarms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eng"."telemetry_alarms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."telemetry_alarms" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
-- Monthly partitions of the minute aggregates (BUILD_PLAN 13.2): created ahead and behind, dropped past retention.
-- SECURITY DEFINER so the application role (which owns no table) can run it from the worker's daily job; it only
-- builds partition names from dates and takes integers, never identifiers.
CREATE OR REPLACE FUNCTION "eng"."maintain_telemetry_partitions"(
  months_back integer DEFAULT 13,
  months_ahead integer DEFAULT 2,
  keep_days integer DEFAULT 400
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  first_month date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
  k integer;
  from_d date;
  to_d date;
  part text;
  dropped integer := 0;
  r record;
BEGIN
  FOR k IN -greatest(months_back, 0)..greatest(months_ahead, 0) LOOP
    from_d := (first_month + make_interval(months => k))::date;
    to_d := (first_month + make_interval(months => k + 1))::date;
    -- A month already past retention is not recreated.
    CONTINUE WHEN to_d < (now() - make_interval(days => keep_days))::date;
    part := 'telemetry_minutes_' || to_char(from_d, 'YYYYMM');
    IF to_regclass('eng.' || quote_ident(part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE eng.%I PARTITION OF eng.telemetry_minutes FOR VALUES FROM (%L) TO (%L)',
        part, from_d::text || ' 00:00:00+00', to_d::text || ' 00:00:00+00');
      EXECUTE format('ALTER TABLE eng.%I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE eng.%I FORCE ROW LEVEL SECURITY', part);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON eng.%I USING (platform.current_tenant() IS NULL OR tenant_id = platform.current_tenant()) WITH CHECK (platform.current_tenant() IS NULL OR tenant_id = platform.current_tenant())',
        part);
    END IF;
  END LOOP;
  FOR r IN
    SELECT c.relname
    FROM pg_inherits inh
    JOIN pg_class c ON c.oid = inh.inhrelid
    JOIN pg_class p ON p.oid = inh.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'eng' AND p.relname = 'telemetry_minutes' AND c.relname ~ '^telemetry_minutes_[0-9]{6}$'
  LOOP
    IF (to_date(right(r.relname, 6), 'YYYYMM') + interval '1 month') < now() - make_interval(days => keep_days) THEN
      EXECUTE format('DROP TABLE eng.%I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;--> statement-breakpoint
SELECT "eng"."maintain_telemetry_partitions"();
