CREATE TYPE "license"."installation_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TABLE "license"."installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"public_key" text NOT NULL,
	"status" "license"."installation_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_issued_at" timestamp with time zone,
	"created_by_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."site_bundles" (
	"installation_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"grace_until" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "installations_tenant_idx" ON "license"."installations" USING btree ("tenant_id");--> statement-breakpoint
-- Hand-written (reviewed): tenant integrity and row-level security as in migration 0038.
ALTER TABLE "license"."installations" ADD CONSTRAINT "installations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."installations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."installations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."installations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
-- A site's bundle names the central tenant id; the site is provisioned with the same tenant id, but the bundle may be
-- stored before that tenant row exists, so no foreign key here.
ALTER TABLE "license"."site_bundles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."site_bundles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."site_bundles" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
