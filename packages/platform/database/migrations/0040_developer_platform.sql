CREATE TYPE "iam"."api_client_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "integration"."webhook_delivery_status" AS ENUM('PENDING', 'DELIVERED', 'DEAD');--> statement-breakpoint
CREATE TYPE "integration"."webhook_endpoint_status" AS ENUM('ACTIVE', 'PAUSED');--> statement-breakpoint
CREATE TABLE "iam"."api_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"name" varchar(120) NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"status" "iam"."api_client_status" DEFAULT 'ACTIVE' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"body" jsonb NOT NULL,
	"status" "integration"."webhook_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_status_code" integer,
	"last_error" varchar(300),
	"delivered_at" timestamp with time zone,
	"replays" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"url" text NOT NULL,
	"event_types" text[] NOT NULL,
	"description" text,
	"status" "integration"."webhook_endpoint_status" DEFAULT 'ACTIVE' NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "integration"."webhook_endpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_prefix_uq" ON "iam"."api_clients" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "api_clients_tenant_idx" ON "iam"."api_clients" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_uq" ON "integration"."webhook_deliveries" USING btree ("endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "integration"."webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_idx" ON "integration"."webhook_endpoints" USING btree ("tenant_id","status");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, revoked-never-deleted API clients and row-level security on
-- the tenant-owned tables as in migration 0006.
ALTER TABLE "iam"."api_clients" ADD CONSTRAINT "api_clients_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "iam"."api_clients" ADD CONSTRAINT "api_clients_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "iam"."api_clients" ADD CONSTRAINT "api_clients_revoked_ck" CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION "iam"."api_clients_no_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'iam.api_clients rows are revoked, never deleted';
END $$;
--> statement-breakpoint
CREATE TRIGGER "api_clients_no_delete" BEFORE DELETE ON "iam"."api_clients" FOR EACH ROW EXECUTE FUNCTION "iam"."api_clients_no_delete"();
--> statement-breakpoint
ALTER TABLE "integration"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "iam"."api_clients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."api_clients" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."api_clients" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."webhook_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."webhook_endpoints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."webhook_endpoints" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."webhook_deliveries" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
