CREATE TYPE "ai"."evaluation_outcome" AS ENUM('PASS', 'FAIL', 'ERROR');--> statement-breakpoint
CREATE TYPE "ai"."evaluation_run_status" AS ENUM('RUNNING', 'PASSED', 'FAILED', 'ERROR');--> statement-breakpoint
CREATE TYPE "ai"."evaluation_set_status" AS ENUM('ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "ai"."release_stage" AS ENUM('SHADOW', 'CANARY', 'ACTIVE', 'ROLLED_BACK');--> statement-breakpoint
CREATE TABLE "ai"."agent_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"agent_code" varchar(64) NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"stage" "ai"."release_stage" NOT NULL,
	"canary_percent" integer,
	"previous_version_id" uuid,
	"run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"reason" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "ai"."evaluation_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"set_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"input" jsonb NOT NULL,
	"tool_fixtures" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expectations" jsonb NOT NULL,
	"data_class" "ai"."data_class" DEFAULT 'INTERNAL' NOT NULL,
	"status" "ai"."evaluation_set_status" DEFAULT 'ACTIVE' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai"."evaluation_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid,
	"outcome" "ai"."evaluation_outcome" NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ai"."evaluation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"agent_code" varchar(64) NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"mode" varchar(16) DEFAULT 'REGRESSION' NOT NULL,
	"status" "ai"."evaluation_run_status" DEFAULT 'RUNNING' NOT NULL,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_minor" integer DEFAULT 0 NOT NULL,
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai"."evaluation_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"agent_code" varchar(64) NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(160) NOT NULL,
	"status" "ai"."evaluation_set_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai"."agent_releases" ADD CONSTRAINT "agent_releases_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "ai"."agent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_cases" ADD CONSTRAINT "evaluation_cases_set_id_evaluation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "ai"."evaluation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_results" ADD CONSTRAINT "evaluation_results_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "ai"."evaluation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_results" ADD CONSTRAINT "evaluation_results_case_id_evaluation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "ai"."evaluation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_runs" ADD CONSTRAINT "evaluation_runs_set_id_evaluation_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "ai"."evaluation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_runs" ADD CONSTRAINT "evaluation_runs_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "ai"."agent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_releases_agent_idx" ON "ai"."agent_releases" USING btree ("agent_code","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_cases_code_uq" ON "ai"."evaluation_cases" USING btree ("set_id","code");--> statement-breakpoint
CREATE INDEX "evaluation_results_run_idx" ON "ai"."evaluation_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_version_idx" ON "ai"."evaluation_runs" USING btree ("agent_version_id","set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_sets_platform_uq" ON "ai"."evaluation_sets" USING btree ("agent_code","code") WHERE "ai"."evaluation_sets"."tenant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_sets_tenant_uq" ON "ai"."evaluation_sets" USING btree ("tenant_id","agent_code","code") WHERE "ai"."evaluation_sets"."tenant_id" is not null;--> statement-breakpoint
-- Tenant FKs and row-level security (platform sets and releases have no tenant and are visible to every tenant).
ALTER TABLE "ai"."evaluation_sets" ADD CONSTRAINT "evaluation_sets_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_cases" ADD CONSTRAINT "evaluation_cases_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_runs" ADD CONSTRAINT "evaluation_runs_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_results" ADD CONSTRAINT "evaluation_results_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."agent_releases" ADD CONSTRAINT "agent_releases_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_sets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."evaluation_sets" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "ai"."evaluation_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."evaluation_cases" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "ai"."evaluation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."evaluation_runs" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "ai"."evaluation_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."evaluation_results" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."evaluation_results" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "ai"."agent_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."agent_releases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."agent_releases" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
-- Release history is append-only (rule 10): a rollback is a new row, never an edit.
CREATE FUNCTION "ai"."agent_releases_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai.agent_releases is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agent_releases_append_only" BEFORE UPDATE OR DELETE ON "ai"."agent_releases" FOR EACH ROW EXECUTE FUNCTION "ai"."agent_releases_append_only"();
