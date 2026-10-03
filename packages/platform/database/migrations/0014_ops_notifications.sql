CREATE TYPE "ops"."delivery_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "ops"."notification_channel" AS ENUM('IN_APP', 'EMAIL', 'PUSH', 'WHATSAPP', 'SMS');--> statement-breakpoint
CREATE TYPE "ops"."notification_priority" AS ENUM('NORMAL', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "ops"."notification_recipient_type" AS ENUM('USER', 'ROLE', 'PERMISSION');--> statement-breakpoint
CREATE TABLE "ops"."notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "ops"."notification_channel" NOT NULL,
	"status" "ops"."delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"provider_ref" varchar(200),
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."notification_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"category" varchar(32) NOT NULL,
	"template_key" varchar(128) NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_type" "ops"."notification_recipient_type" NOT NULL,
	"recipient_ref" varchar(128) NOT NULL,
	"priority" "ops"."notification_priority" DEFAULT 'NORMAL' NOT NULL,
	"critical_override" boolean DEFAULT false NOT NULL,
	"source_type" varchar(64),
	"source_id" uuid,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" varchar(32) NOT NULL,
	"channel" "ops"."notification_channel" NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "ops"."notification_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_once_uq" ON "ops"."notification_deliveries" USING btree ("intent_id","user_id","channel");--> statement-breakpoint
CREATE INDEX "notification_deliveries_inbox_idx" ON "ops"."notification_deliveries" USING btree ("user_id","channel","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_pending_idx" ON "ops"."notification_deliveries" USING btree ("next_attempt_at") WHERE "ops"."notification_deliveries"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "notification_intents_property_idx" ON "ops"."notification_intents" USING btree ("property_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_uq" ON "ops"."notification_preferences" USING btree ("tenant_id","user_id","category","channel");
--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, delivery sanity and row-level security as in migration 0006.
ALTER TABLE "ops"."notification_intents" ADD CONSTRAINT "notification_intents_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."notification_intents" ADD CONSTRAINT "notification_intents_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ops"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_pending_ck" CHECK ("status" <> 'PENDING' OR "next_attempt_at" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "ops"."notification_intents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."notification_intents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."notification_intents" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."notification_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."notification_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."notification_deliveries" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ops"."notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ops"."notification_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ops"."notification_preferences" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
