CREATE TYPE "ai"."insight_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "ai"."insight_status" AS ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED', 'EXPIRED');--> statement-breakpoint
ALTER TYPE "ai"."feedback_kind" ADD VALUE 'RECOMMENDATION_ACCEPTED';--> statement-breakpoint
ALTER TYPE "ai"."feedback_kind" ADD VALUE 'RECOMMENDATION_REJECTED';--> statement-breakpoint
CREATE TABLE "ai"."insight_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"insight_id" uuid NOT NULL,
	"from_status" "ai"."insight_status",
	"to_status" "ai"."insight_status" NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"reason" varchar(500),
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai"."insights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"detector" varchar(64) NOT NULL,
	"fingerprint" varchar(200) NOT NULL,
	"severity" "ai"."insight_severity" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"reason_key" varchar(128) NOT NULL,
	"reason_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_action" jsonb,
	"status" "ai"."insight_status" DEFAULT 'OPEN' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai"."signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"signal" varchar(40) NOT NULL,
	"subject_kind" varchar(32) NOT NULL,
	"subject_ref" uuid NOT NULL,
	"codes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_source_uq" UNIQUE("tenant_id","source_event_id","signal")
);
--> statement-breakpoint
ALTER TABLE "ai"."feedback" ALTER COLUMN "execution_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai"."feedback" ADD COLUMN "insight_id" uuid;--> statement-breakpoint
ALTER TABLE "ai"."insight_history" ADD CONSTRAINT "insight_history_insight_id_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "ai"."insights"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "insight_history_insight_idx" ON "ai"."insight_history" USING btree ("insight_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_live_uq" ON "ai"."insights" USING btree ("tenant_id","property_id","detector","fingerprint") WHERE "ai"."insights"."status" in ('OPEN', 'ACKNOWLEDGED');--> statement-breakpoint
CREATE INDEX "insights_property_idx" ON "ai"."insights" USING btree ("tenant_id","property_id","status","last_seen_at");--> statement-breakpoint
CREATE INDEX "signals_property_idx" ON "ai"."signals" USING btree ("tenant_id","property_id","signal","occurred_at");--> statement-breakpoint
-- Feedback is about an execution or an insight, never neither.
ALTER TABLE "ai"."feedback" ADD CONSTRAINT "feedback_insight_id_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "ai"."insights"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."feedback" ADD CONSTRAINT "feedback_subject_ck" CHECK ("execution_id" IS NOT NULL OR "insight_id" IS NOT NULL);--> statement-breakpoint
-- Tenant FKs and row-level security.
ALTER TABLE "ai"."signals" ADD CONSTRAINT "signals_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."insights" ADD CONSTRAINT "insights_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."insight_history" ADD CONSTRAINT "insight_history_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."signals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."signals" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "ai"."insights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."insights" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."insights" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "ai"."insight_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."insight_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."insight_history" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
-- Insight history is append-only (rule 10).
CREATE FUNCTION "ai"."insight_history_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai.insight_history is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "insight_history_append_only" BEFORE UPDATE OR DELETE ON "ai"."insight_history" FOR EACH ROW EXECUTE FUNCTION "ai"."insight_history_append_only"();
