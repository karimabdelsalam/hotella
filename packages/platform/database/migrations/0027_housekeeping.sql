CREATE SCHEMA "hk";
--> statement-breakpoint
CREATE TYPE "hk"."housekeeping_state" AS ENUM('DIRTY', 'CLEANING', 'CLEAN', 'INSPECTING', 'INSPECTED', 'PICKUP');--> statement-breakpoint
CREATE TYPE "hk"."occupancy" AS ENUM('VACANT', 'OCCUPIED');--> statement-breakpoint
CREATE TYPE "hk"."signal" AS ENUM('DND', 'MAKE_UP_ROOM', 'PRIVACY', 'SERVICE_REQUESTED');--> statement-breakpoint
CREATE TYPE "hk"."signal_source" AS ENUM('PMS', 'BMS', 'SMART_ROOM', 'STAFF', 'GUEST_PORTAL');--> statement-breakpoint
CREATE TYPE "hk"."state_cause" AS ENUM('PMS', 'JOB', 'INSPECTION', 'STAFF', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "hk"."state_dimension" AS ENUM('OCCUPANCY', 'HOUSEKEEPING', 'FRONT_OFFICE');--> statement-breakpoint
CREATE TABLE "hk"."room_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"signal" "hk"."signal" NOT NULL,
	"source" "hk"."signal_source" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"started_by_type" varchar(16) NOT NULL,
	"started_by_id" uuid,
	"ended_by_type" varchar(16),
	"ended_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hk"."room_state_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"dimension" "hk"."state_dimension" NOT NULL,
	"from_value" varchar(32),
	"to_value" varchar(32),
	"cause" "hk"."state_cause" NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"job_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hk"."room_states" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"occupancy" "hk"."occupancy" DEFAULT 'VACANT' NOT NULL,
	"housekeeping" "hk"."housekeeping_state" DEFAULT 'DIRTY' NOT NULL,
	"front_office" varchar(32),
	"last_cleaned_at" timestamp with time zone,
	"last_inspected_at" timestamp with time zone,
	"last_pms_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "room_signals_open_uq" ON "hk"."room_signals" USING btree ("room_id","signal") WHERE "hk"."room_signals"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "room_signals_property_idx" ON "hk"."room_signals" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "room_state_events_room_idx" ON "hk"."room_state_events" USING btree ("tenant_id","room_id","occurred_at");--> statement-breakpoint
CREATE INDEX "room_states_property_idx" ON "hk"."room_states" USING btree ("tenant_id","property_id");--> statement-breakpoint
ALTER TABLE "hk"."room_states" ADD CONSTRAINT "room_states_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_state_events" ADD CONSTRAINT "room_state_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_signals" ADD CONSTRAINT "room_signals_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_states" ADD CONSTRAINT "room_states_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_state_events" ADD CONSTRAINT "room_state_events_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_signals" ADD CONSTRAINT "room_signals_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hk"."room_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hk"."room_states" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "hk"."room_state_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hk"."room_state_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hk"."room_state_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "hk"."room_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hk"."room_signals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hk"."room_signals" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "hk"."room_states" ADD CONSTRAINT "room_states_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_state_events" ADD CONSTRAINT "room_state_events_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "hk"."room_signals" ADD CONSTRAINT "room_signals_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
CREATE FUNCTION "hk"."room_state_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Room state history (CLAUDE.md rule 10) is never rewritten or deleted; it holds codes, never guest data.
  RAISE EXCEPTION 'hk.room_state_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "room_state_events_no_update_delete" BEFORE UPDATE OR DELETE ON "hk"."room_state_events" FOR EACH ROW EXECUTE FUNCTION "hk"."room_state_events_append_only"();
