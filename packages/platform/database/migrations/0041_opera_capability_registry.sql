CREATE TYPE "integration"."capability_history_action" AS ENUM('VERIFIED', 'UNVERIFIED', 'ENABLED', 'DISABLED', 'COMMISSIONED', 'ROUTING_CHANGED');--> statement-breakpoint
CREATE TABLE "integration"."property_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"connector_code" varchar(48) NOT NULL,
	"capability" varchar(48) NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"verification_ref" varchar(300),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."property_capability_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid,
	"capability" varchar(48),
	"action" "integration"."capability_history_action" NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" varchar(64),
	"reference" varchar(300),
	"reason" varchar(500),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."property_capability_states" (
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"capability" varchar(48) NOT NULL,
	"effective" boolean NOT NULL,
	"connectors" text[] NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_capability_states_pk" PRIMARY KEY("property_id","capability")
);
--> statement-breakpoint
CREATE TABLE "integration"."routing_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"operation" varchar(48) NOT NULL,
	"connectors" text[] NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration"."integration_commands" ADD COLUMN "routing" jsonb;--> statement-breakpoint
ALTER TABLE "integration"."integration_instances" ADD COLUMN "commissioned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration"."integration_instances" ADD COLUMN "commissioned_by" uuid;--> statement-breakpoint
ALTER TABLE "integration"."property_capabilities" ADD CONSTRAINT "property_capabilities_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "property_capabilities_uq" ON "integration"."property_capabilities" USING btree ("instance_id","capability");--> statement-breakpoint
CREATE INDEX "property_capabilities_property_idx" ON "integration"."property_capabilities" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "property_capability_history_idx" ON "integration"."property_capability_history" USING btree ("tenant_id","property_id","at");--> statement-breakpoint
CREATE INDEX "property_capability_states_tenant_idx" ON "integration"."property_capability_states" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_overrides_uq" ON "integration"."routing_overrides" USING btree ("property_id","operation");;--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, append-only capability history (rule 10), verification facts
-- that are never deleted, and row-level security on the tenant-owned tables as in migration 0006.
ALTER TABLE "integration"."property_capabilities" ADD CONSTRAINT "property_capabilities_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."property_capabilities" ADD CONSTRAINT "property_capabilities_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_history" ADD CONSTRAINT "property_capability_history_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_history" ADD CONSTRAINT "property_capability_history_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_states" ADD CONSTRAINT "property_capability_states_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_states" ADD CONSTRAINT "property_capability_states_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."routing_overrides" ADD CONSTRAINT "routing_overrides_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."routing_overrides" ADD CONSTRAINT "routing_overrides_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."property_capabilities" ADD CONSTRAINT "property_capabilities_verified_ck" CHECK (("verified_at" IS NULL AND "verified_by" IS NULL AND "verification_ref" IS NULL) OR ("verified_at" IS NOT NULL AND "verification_ref" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION "integration"."capability_history_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration.property_capability_history is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER "property_capability_history_append_only" BEFORE UPDATE OR DELETE ON "integration"."property_capability_history" FOR EACH ROW EXECUTE FUNCTION "integration"."capability_history_append_only"();
--> statement-breakpoint
CREATE FUNCTION "integration"."property_capabilities_no_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration.property_capabilities rows are un-verified, never deleted';
END $$;
--> statement-breakpoint
CREATE TRIGGER "property_capabilities_no_delete" BEFORE DELETE ON "integration"."property_capabilities" FOR EACH ROW EXECUTE FUNCTION "integration"."property_capabilities_no_delete"();
--> statement-breakpoint
ALTER TABLE "integration"."property_capabilities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."property_capabilities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."property_capabilities" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."property_capability_history" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."property_capability_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."property_capability_states" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."routing_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."routing_overrides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."routing_overrides" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
