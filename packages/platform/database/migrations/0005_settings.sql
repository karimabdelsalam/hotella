CREATE TYPE "platform"."config_scope" AS ENUM('PLATFORM', 'TENANT', 'PROPERTY', 'DEPARTMENT', 'MODULE');--> statement-breakpoint
CREATE TYPE "platform"."data_class" AS ENUM('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SENSITIVE', 'RESTRICTED');--> statement-breakpoint
CREATE TYPE "platform"."retention_action" AS ENUM('DELETE', 'ANONYMIZE', 'ARCHIVE');--> statement-breakpoint
CREATE TABLE "platform"."attribution_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"show_powered_by" boolean DEFAULT true NOT NULL,
	"override_entitlement_ref" varchar(128),
	"updated_by" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "attribution_policies_override_ck" CHECK ("platform"."attribution_policies"."show_powered_by" OR "platform"."attribution_policies"."override_entitlement_ref" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "platform"."configuration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"scope" "platform"."config_scope" NOT NULL,
	"scope_id" uuid,
	"key" varchar(128) NOT NULL,
	"value" jsonb NOT NULL,
	"changed_by" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "configuration_scope_key_uq" UNIQUE NULLS NOT DISTINCT("scope","scope_id","key"),
	CONSTRAINT "configuration_scope_id_ck" CHECK (("platform"."configuration"."scope" = 'PLATFORM') = ("platform"."configuration"."scope_id" IS NULL AND "platform"."configuration"."tenant_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "platform"."configuration_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"scope" "platform"."config_scope" NOT NULL,
	"scope_id" uuid,
	"key" varchar(128) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"version" integer NOT NULL,
	"changed_by" varchar(64),
	"reason" text,
	"correlation_id" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "platform"."retention_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"data_class" "platform"."data_class" NOT NULL,
	"entity_type" varchar(64),
	"retain_days" integer NOT NULL,
	"action" "platform"."retention_action" NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "retention_policies_scope_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","data_class","entity_type"),
	CONSTRAINT "retention_policies_days_ck" CHECK ("platform"."retention_policies"."retain_days" >= 1)
);
--> statement-breakpoint
CREATE INDEX "configuration_tenant_key_idx" ON "platform"."configuration" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "configuration_history_key_idx" ON "platform"."configuration_history" USING btree ("scope","scope_id","key","changed_at");--> statement-breakpoint
-- Hand-written (reviewed): tenant references are real tenants; configuration history is append-only like the audit log.
ALTER TABLE "platform"."configuration" ADD CONSTRAINT "configuration_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "platform"."retention_policies" ADD CONSTRAINT "retention_policies_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "platform"."attribution_policies" ADD CONSTRAINT "attribution_policies_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
CREATE FUNCTION "platform"."reject_history_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% rejected)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "configuration_history_no_update_delete" BEFORE UPDATE OR DELETE ON "platform"."configuration_history" FOR EACH ROW EXECUTE FUNCTION "platform"."reject_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "configuration_history_no_truncate" BEFORE TRUNCATE ON "platform"."configuration_history" FOR EACH STATEMENT EXECUTE FUNCTION "platform"."reject_history_mutation"();
