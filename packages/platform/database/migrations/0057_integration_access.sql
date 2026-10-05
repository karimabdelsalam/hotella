CREATE TYPE "integration"."access_grant_status" AS ENUM('REQUESTED', 'ISSUED', 'FAILED', 'REVOKE_REQUESTED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "integration"."access_kind" AS ENUM('KEY', 'MOBILE_KEY', 'WIFI');--> statement-breakpoint
CREATE TABLE "integration"."access_grant_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"from_status" "integration"."access_grant_status",
	"to_status" "integration"."access_grant_status" NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"reason" varchar(32),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"kind" "integration"."access_kind" NOT NULL,
	"room_id" uuid,
	"room_number" varchar(16),
	"instance_id" uuid NOT NULL,
	"status" "integration"."access_grant_status" DEFAULT 'REQUESTED' NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"issue_command_id" uuid,
	"revoke_command_id" uuid,
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" uuid,
	"issued_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(32),
	"failure" varchar(500),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration"."access_grant_events" ADD CONSTRAINT "access_grant_events_grant_id_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "integration"."access_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."access_grants" ADD CONSTRAINT "access_grants_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grant_events_grant_idx" ON "integration"."access_grant_events" USING btree ("grant_id","at");--> statement-breakpoint
CREATE INDEX "access_grants_stay_idx" ON "integration"."access_grants" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE INDEX "access_grants_issue_cmd_idx" ON "integration"."access_grants" USING btree ("issue_command_id");--> statement-breakpoint
CREATE INDEX "access_grants_revoke_cmd_idx" ON "integration"."access_grants" USING btree ("revoke_command_id");;--> statement-breakpoint
ALTER TABLE "integration"."access_grants" ADD CONSTRAINT "access_grants_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "integration"."access_grant_events" ADD CONSTRAINT "access_grant_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "integration"."access_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration"."access_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."access_grants" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "integration"."access_grant_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration"."access_grant_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."access_grant_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
CREATE FUNCTION "integration"."access_grant_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Access history (CLAUDE.md rule 10): every key and Wi-Fi transition stays.
  RAISE EXCEPTION 'integration.access_grant_events is append-only';
END
$$;--> statement-breakpoint
CREATE TRIGGER "access_grant_events_append_only" BEFORE UPDATE OR DELETE ON "integration"."access_grant_events" FOR EACH ROW EXECUTE FUNCTION "integration"."access_grant_events_append_only"();
