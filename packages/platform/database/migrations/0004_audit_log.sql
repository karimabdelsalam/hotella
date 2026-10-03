CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TYPE "audit"."actor_type" AS ENUM('USER', 'GUEST', 'AI_AGENT', 'SYSTEM', 'INTEGRATION', 'SUPPORT');--> statement-breakpoint
CREATE TABLE "audit"."audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"property_id" uuid,
	"actor_type" "audit"."actor_type" NOT NULL,
	"actor_id" varchar(64),
	"action" varchar(128) NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"entity_id" varchar(128) NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"approval_ref" varchar(128),
	"policy_ref" varchar(128),
	"correlation_id" varchar(128),
	"trace_id" varchar(32)
);
--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit"."audit_log" USING btree ("tenant_id","entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_time_idx" ON "audit"."audit_log" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_correlation_idx" ON "audit"."audit_log" USING btree ("correlation_id");--> statement-breakpoint
-- Hand-written (reviewed): the audit log is append-only for every role, including the table owner (Spec §68).
-- No foreign keys on purpose: audit rows must outlive anything they describe.
CREATE FUNCTION "audit"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.audit_log is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update_delete" BEFORE UPDATE OR DELETE ON "audit"."audit_log" FOR EACH ROW EXECUTE FUNCTION "audit"."reject_mutation"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit"."audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "audit"."reject_mutation"();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit"."audit_log" FROM PUBLIC;
