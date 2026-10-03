CREATE SCHEMA "comms";
--> statement-breakpoint
CREATE TYPE "comms"."channel_health" AS ENUM('HEALTHY', 'DEGRADED', 'OFFLINE', 'AUTH_FAILED');--> statement-breakpoint
CREATE TYPE "comms"."channel_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "comms"."channel_type" AS ENUM('WHATSAPP', 'SMS', 'EMAIL', 'GUEST_WEB', 'ROOM_QR', 'VOICE', 'MESSENGER', 'INSTAGRAM', 'APP');--> statement-breakpoint
CREATE TABLE "comms"."channel_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_type" "comms"."channel_type" NOT NULL,
	"identifier_normalized" varchar(320) NOT NULL,
	"guest_id" uuid,
	"verified_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "channel_identities_identifier_uq" UNIQUE("tenant_id","channel_type","identifier_normalized")
);
--> statement-breakpoint
CREATE TABLE "comms"."channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"type" "comms"."channel_type" NOT NULL,
	"name" varchar(80) NOT NULL,
	"provider_code" varchar(64) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_ref" varchar(256),
	"status" "comms"."channel_status" DEFAULT 'ACTIVE' NOT NULL,
	"health" "comms"."channel_health" DEFAULT 'HEALTHY' NOT NULL,
	"health_changed_at" timestamp with time zone,
	"brand_profile_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "channels_property_name_uq" UNIQUE("property_id","name")
);
--> statement-breakpoint
CREATE INDEX "channel_identities_guest_idx" ON "comms"."channel_identities" USING btree ("tenant_id","guest_id") WHERE "comms"."channel_identities"."guest_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "channels_property_type_idx" ON "comms"."channels" USING btree ("tenant_id","property_id","type");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property/guest integrity and row-level security as in migration 0006.
ALTER TABLE "comms"."channels" ADD CONSTRAINT "channels_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."channel_identities" ADD CONSTRAINT "channel_identities_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."channels" ADD CONSTRAINT "channels_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."channel_identities" ADD CONSTRAINT "channel_identities_guest_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."channel_identities" ADD CONSTRAINT "channel_identities_verified_ck" CHECK ("verified_at" IS NULL OR "guest_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "comms"."channels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."channels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."channels" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."channel_identities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."channel_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."channel_identities" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
