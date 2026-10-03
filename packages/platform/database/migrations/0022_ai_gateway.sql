CREATE SCHEMA "ai";
--> statement-breakpoint
CREATE TYPE "ai"."active_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "ai"."data_class" AS ENUM('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SENSITIVE', 'RESTRICTED');--> statement-breakpoint
CREATE TYPE "ai"."egress" AS ENUM('ON_PREM', 'EXTERNAL');--> statement-breakpoint
CREATE TYPE "ai"."provider_kind" AS ENUM('OPENAI_COMPATIBLE', 'ANTHROPIC', 'FAKE');--> statement-breakpoint
CREATE TABLE "ai"."model_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"execution_id" uuid,
	"agent_code" varchar(64),
	"capability" varchar(32) NOT NULL,
	"provider_code" varchar(64) NOT NULL,
	"model_code" varchar(128) NOT NULL,
	"egress" "ai"."egress" NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cached" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"cost_minor" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) NOT NULL,
	"fallback_from" varchar(128),
	"outcome" varchar(32) NOT NULL,
	"dropped_parts" integer DEFAULT 0 NOT NULL,
	"correlation_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai"."models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" uuid NOT NULL,
	"code" varchar(128) NOT NULL,
	"capabilities" text[] NOT NULL,
	"context_window" integer DEFAULT 8192 NOT NULL,
	"input_per_million_minor" integer DEFAULT 0 NOT NULL,
	"output_per_million_minor" integer DEFAULT 0 NOT NULL,
	"cached_per_million_minor" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"status" "ai"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "models_provider_code_uq" UNIQUE("provider_id","code")
);
--> statement-breakpoint
CREATE TABLE "ai"."providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(64) NOT NULL,
	"kind" "ai"."provider_kind" NOT NULL,
	"base_url" varchar(512),
	"credential_ref" varchar(256),
	"egress" "ai"."egress" NOT NULL,
	"max_data_class" "ai"."data_class" DEFAULT 'INTERNAL' NOT NULL,
	"status" "ai"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "providers_code_uq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ai"."routing_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"property_id" uuid,
	"capability" varchar(32) NOT NULL,
	"model_ids" uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai"."models" ADD CONSTRAINT "models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "ai"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_calls_tenant_time_idx" ON "ai"."model_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_execution_idx" ON "ai"."model_calls" USING btree ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_rules_platform_uq" ON "ai"."routing_rules" USING btree ("capability") WHERE "ai"."routing_rules"."tenant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_rules_tenant_uq" ON "ai"."routing_rules" USING btree ("tenant_id","capability") WHERE "ai"."routing_rules"."tenant_id" is not null and "ai"."routing_rules"."property_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_rules_property_uq" ON "ai"."routing_rules" USING btree ("tenant_id","property_id","capability") WHERE "ai"."routing_rules"."property_id" is not null;--> statement-breakpoint
ALTER TABLE "ai"."routing_rules" ADD CONSTRAINT "routing_rules_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."model_calls" ADD CONSTRAINT "model_calls_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."routing_rules" ADD CONSTRAINT "routing_rules_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."model_calls" ADD CONSTRAINT "model_calls_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "ai"."model_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai"."model_calls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."model_calls" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());

--> statement-breakpoint
ALTER TABLE "ai"."routing_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai"."routing_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Platform defaults (tenant_id NULL) are visible to every tenant; a tenant's own rules only to that tenant.
CREATE POLICY "tenant_isolation" ON "ai"."routing_rules" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
