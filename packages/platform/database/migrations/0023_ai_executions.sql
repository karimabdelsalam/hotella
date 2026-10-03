CREATE TYPE "ai"."execution_status" AS ENUM('RUNNING', 'COMPLETED', 'FAILED', 'HANDED_OFF');--> statement-breakpoint
CREATE TYPE "ai"."proposal_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "ai"."risk" AS ENUM('READ', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "ai"."step_type" AS ENUM('CONTEXT', 'MODEL_CALL', 'TOOL_CALL', 'RETRIEVAL', 'DECISION', 'APPROVAL', 'RESPONSE');--> statement-breakpoint
CREATE TABLE "ai"."action_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"tool_code" varchar(128) NOT NULL,
	"arguments" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"reason" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" "ai"."risk" NOT NULL,
	"approval_id" uuid,
	"status" "ai"."proposal_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai"."execution_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"type" "ai"."step_type" NOT NULL,
	"name" varchar(128) NOT NULL,
	"outcome" varchar(32) NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai"."executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"agent_code" varchar(64) NOT NULL,
	"agent_version_id" uuid,
	"trigger" varchar(16) NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"conversation_id" uuid,
	"status" "ai"."execution_status" DEFAULT 'RUNNING' NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_minor" integer DEFAULT 0 NOT NULL,
	"correlation_id" varchar(128),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai"."action_proposals" ADD CONSTRAINT "action_proposals_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "ai"."executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."execution_steps" ADD CONSTRAINT "execution_steps_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "ai"."executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_proposals_tenant_status_idx" ON "ai"."action_proposals" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_approval_uq" ON "ai"."action_proposals" USING btree ("approval_id") WHERE "ai"."action_proposals"."approval_id" is not null;--> statement-breakpoint
CREATE INDEX "execution_steps_execution_idx" ON "ai"."execution_steps" USING btree ("execution_id","id");--> statement-breakpoint
CREATE INDEX "executions_tenant_time_idx" ON "ai"."executions" USING btree ("tenant_id","started_at");--> statement-breakpoint
ALTER TABLE "ai"."executions" ADD CONSTRAINT "executions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."execution_steps" ADD CONSTRAINT "execution_steps_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."action_proposals" ADD CONSTRAINT "action_proposals_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."executions" ADD CONSTRAINT "executions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."action_proposals" ADD CONSTRAINT "action_proposals_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."executions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai"."executions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."executions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ai"."execution_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai"."execution_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."execution_steps" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ai"."action_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai"."action_proposals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."action_proposals" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ai"."executions" ADD CONSTRAINT "executions_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "comms"."conversations"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE FUNCTION "ai"."execution_steps_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The record of what an AI did (Spec §34, CLAUDE.md rule 12) is never rewritten. Steps hold codes, decisions and
  -- outcomes only (never guest text), so anonymization has nothing to clear here.
  RAISE EXCEPTION 'ai.execution_steps is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "execution_steps_no_update_delete" BEFORE UPDATE OR DELETE ON "ai"."execution_steps" FOR EACH ROW EXECUTE FUNCTION "ai"."execution_steps_append_only"();
