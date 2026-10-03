CREATE TYPE "ai"."feedback_kind" AS ENUM('DRAFT_EDIT', 'REASSIGNMENT', 'GUEST_CORRECTION', 'RATING');--> statement-breakpoint
CREATE TYPE "ai"."version_status" AS ENUM('DRAFT', 'PUBLISHED', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE "ai"."agent_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "ai"."version_status" DEFAULT 'DRAFT' NOT NULL,
	"capability" varchar(32) NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"tool_codes" text[] NOT NULL,
	"context_policy" jsonb NOT NULL,
	"autonomy_policy" jsonb NOT NULL,
	"output_contract" jsonb NOT NULL,
	"max_steps" integer NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "agent_versions_no_uq" UNIQUE("agent_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "ai"."agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(64) NOT NULL,
	"status" "ai"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "agents_code_uq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ai"."feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"execution_id" uuid NOT NULL,
	"kind" "ai"."feedback_kind" NOT NULL,
	"edit_distance" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"source_ref" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_source_uq" UNIQUE("tenant_id","kind","source_ref")
);
--> statement-breakpoint
CREATE TABLE "ai"."prompt_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "ai"."version_status" DEFAULT 'DRAFT' NOT NULL,
	"layers" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "prompt_versions_no_uq" UNIQUE("prompt_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "ai"."prompts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(64) NOT NULL,
	CONSTRAINT "prompts_code_uq" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "ai"."agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "ai"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."agent_versions" ADD CONSTRAINT "agent_versions_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "ai"."prompt_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."feedback" ADD CONSTRAINT "feedback_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "ai"."executions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "ai"."prompts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_execution_idx" ON "ai"."feedback" USING btree ("execution_id");--> statement-breakpoint
ALTER TABLE "ai"."feedback" ADD CONSTRAINT "feedback_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."feedback" ADD CONSTRAINT "feedback_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."feedback" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai"."feedback" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."feedback" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "ai"."executions" ADD CONSTRAINT "executions_agent_version_fk" FOREIGN KEY ("agent_version_id") REFERENCES "ai"."agent_versions"("id") ON DELETE restrict;
--> statement-breakpoint
-- One published version per prompt and per agent at a time.
CREATE UNIQUE INDEX "prompt_versions_published_uq" ON "ai"."prompt_versions" ("prompt_id") WHERE "status" = 'PUBLISHED';
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_published_uq" ON "ai"."agent_versions" ("agent_id") WHERE "status" = 'PUBLISHED';
--> statement-breakpoint
CREATE FUNCTION "ai"."published_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Published prompt and agent versions are immutable (CLAUDE.md rule 9): only PUBLISHED → SUPERSEDED may change, and
  -- nothing but a draft may be deleted.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION '%.%: version % is % and immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED'
     AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.%: version % is % and immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id, OLD.status;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "prompt_versions_immutable" BEFORE UPDATE OR DELETE ON "ai"."prompt_versions" FOR EACH ROW EXECUTE FUNCTION "ai"."published_versions_immutable"();
--> statement-breakpoint
CREATE TRIGGER "agent_versions_immutable" BEFORE UPDATE OR DELETE ON "ai"."agent_versions" FOR EACH ROW EXECUTE FUNCTION "ai"."published_versions_immutable"();
