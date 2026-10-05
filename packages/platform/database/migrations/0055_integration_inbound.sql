CREATE TYPE "integration"."inbound_endpoint_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TABLE "integration"."inbound_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"status" "integration"."inbound_endpoint_status" DEFAULT 'ACTIVE' NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration"."inbound_endpoints" ADD CONSTRAINT "inbound_endpoints_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_endpoints_instance_idx" ON "integration"."inbound_endpoints" USING btree ("tenant_id","instance_id");--> statement-breakpoint
ALTER TABLE "integration"."inbound_endpoints" ADD CONSTRAINT "inbound_endpoints_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "integration"."inbound_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration"."inbound_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."inbound_endpoints" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
