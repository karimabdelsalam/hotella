CREATE TYPE "guest"."consent_type" AS ENUM('SERVICE_COMMUNICATION', 'MARKETING_WHATSAPP', 'MARKETING_EMAIL', 'PERSONALIZATION');--> statement-breakpoint
CREATE TYPE "guest"."data_request_kind" AS ENUM('EXPORT', 'CORRECTION', 'ANONYMIZE', 'DELETE');--> statement-breakpoint
CREATE TYPE "guest"."data_request_status" AS ENUM('REQUESTED', 'COMPLETED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "guest"."preference_source" AS ENUM('EXPLICIT', 'INFERRED', 'PMS');--> statement-breakpoint
CREATE TYPE "integration"."reconciliation_outcome" AS ENUM('MATCH', 'MISSING_INTERNAL', 'MISSING_EXTERNAL', 'DIFFERENT');--> statement-breakpoint
CREATE TYPE "integration"."reconciliation_status" AS ENUM('RUNNING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TABLE "guest"."guest_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"type" "guest"."consent_type" NOT NULL,
	"granted" boolean NOT NULL,
	"channel" varchar(32) NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_by_type" varchar(16) NOT NULL,
	"captured_by_id" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "guest"."guest_data_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"kind" "guest"."data_request_kind" NOT NULL,
	"status" "guest"."data_request_status" DEFAULT 'REQUESTED' NOT NULL,
	"reason" text NOT NULL,
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" varchar(64),
	"completed_at" timestamp with time zone,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest"."guest_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"category" varchar(64) NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" jsonb NOT NULL,
	"source" "guest"."preference_source" NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"expires_at" timestamp with time zone,
	"recorded_by_type" varchar(16) NOT NULL,
	"recorded_by_id" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "guest_preferences_key_uq" UNIQUE("guest_id","category","key")
);
--> statement-breakpoint
CREATE TABLE "integration"."reconciliation_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"room_code" varchar(64),
	"room_id" uuid,
	CONSTRAINT "reconciliation_entries_uq" UNIQUE("run_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "integration"."reconciliation_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"entity_type" varchar(32) NOT NULL,
	"external_id" varchar(128),
	"internal_id" uuid,
	"outcome" "integration"."reconciliation_outcome" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"status" "integration"."reconciliation_status" DEFAULT 'RUNNING' NOT NULL,
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" varchar(64),
	"command_id" uuid,
	"snapshot_started_at" timestamp with time zone,
	"snapshot_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest"."guest_consents" ADD CONSTRAINT "guest_consents_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."guest_data_requests" ADD CONSTRAINT "guest_data_requests_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."guest_preferences" ADD CONSTRAINT "guest_preferences_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_entries" ADD CONSTRAINT "reconciliation_entries_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "integration"."reconciliation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_results" ADD CONSTRAINT "reconciliation_results_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "integration"."reconciliation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_consents_current_idx" ON "guest"."guest_consents" USING btree ("guest_id","type","captured_at");--> statement-breakpoint
CREATE INDEX "guest_data_requests_guest_idx" ON "guest"."guest_data_requests" USING btree ("tenant_id","guest_id");--> statement-breakpoint
CREATE INDEX "reconciliation_results_run_idx" ON "integration"."reconciliation_results" USING btree ("run_id","outcome");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_instance_idx" ON "integration"."reconciliation_runs" USING btree ("instance_id","status");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, consent history is append-only, preference confidence range,
-- and row-level security as in migration 0006.
ALTER TABLE "guest"."guest_consents" ADD CONSTRAINT "guest_consents_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_data_requests" ADD CONSTRAINT "guest_data_requests_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_preferences" ADD CONSTRAINT "guest_preferences_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_entries" ADD CONSTRAINT "reconciliation_entries_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_results" ADD CONSTRAINT "reconciliation_results_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_preferences" ADD CONSTRAINT "guest_preferences_confidence_ck" CHECK ("confidence" BETWEEN 0 AND 100);
--> statement-breakpoint
CREATE FUNCTION "guest"."consents_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- History is evidence (Spec §26): rows are never deleted; the only permitted update is re-pointing a merged guest or
  -- clearing evidence on anonymization.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guest.guest_consents is append-only';
  END IF;
  IF NEW.type <> OLD.type OR NEW.granted <> OLD.granted OR NEW.channel <> OLD.channel
     OR NEW.captured_at <> OLD.captured_at OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'guest.guest_consents rows are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "guest_consents_append_only" BEFORE UPDATE OR DELETE ON "guest"."guest_consents" FOR EACH ROW EXECUTE FUNCTION "guest"."consents_append_only"();
--> statement-breakpoint
ALTER TABLE "guest"."guest_consents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guest_consents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guest_consents" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."guest_data_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guest_data_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guest_data_requests" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."guest_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guest_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guest_preferences" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."reconciliation_entries" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."reconciliation_results" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."reconciliation_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."reconciliation_runs" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
