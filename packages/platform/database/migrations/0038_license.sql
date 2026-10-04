CREATE SCHEMA "license";
--> statement-breakpoint
CREATE TYPE "license"."capability_kind" AS ENUM('MODULE', 'AI', 'CONNECTOR', 'ADDON', 'FEATURE');--> statement-breakpoint
CREATE TYPE "license"."catalog_status" AS ENUM('ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "license"."enforcement" AS ENUM('SOFT', 'HARD');--> statement-breakpoint
CREATE TYPE "license"."grant_source" AS ENUM('MANUAL', 'TRIAL', 'PROMO');--> statement-breakpoint
CREATE TYPE "license"."granularity" AS ENUM('DAY', 'MONTH');--> statement-breakpoint
CREATE TYPE "license"."limit_period" AS ENUM('NONE', 'DAY', 'MONTH');--> statement-breakpoint
CREATE TYPE "license"."limit_scope" AS ENUM('TENANT', 'PROPERTY');--> statement-breakpoint
CREATE TYPE "license"."metric_kind" AS ENUM('COUNTER', 'GAUGE');--> statement-breakpoint
CREATE TYPE "license"."metric_unit" AS ENUM('TOKENS', 'COUNT', 'MINUTES', 'BYTES', 'CALLS');--> statement-breakpoint
CREATE TYPE "license"."plan_version_status" AS ENUM('DRAFT', 'PUBLISHED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "license"."subscription_scope" AS ENUM('TENANT', 'PROPERTIES');--> statement-breakpoint
CREATE TYPE "license"."subscription_status" AS ENUM('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "license"."capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(64) NOT NULL,
	"product_code" varchar(64) NOT NULL,
	"kind" "license"."capability_kind" NOT NULL,
	"module_code" varchar(64),
	"default_included" boolean DEFAULT false NOT NULL,
	"status" "license"."catalog_status" DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "capabilities_code_uq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "license"."entitlement_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"capability_code" varchar(64) NOT NULL,
	"source" "license"."grant_source" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"reason" text NOT NULL,
	"granted_by_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"revoke_reason" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."limit_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"metric_code" varchar(64) NOT NULL,
	"period" "license"."limit_period" NOT NULL,
	"limit_value" bigint NOT NULL,
	"enforcement" "license"."enforcement" NOT NULL,
	"valid_until" timestamp with time zone,
	"reason" text NOT NULL,
	"set_by_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(64) NOT NULL,
	"unit" "license"."metric_unit" NOT NULL,
	"kind" "license"."metric_kind" NOT NULL,
	"status" "license"."catalog_status" DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "metrics_code_uq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "license"."plan_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "plan_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "license"."plan_version_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"capability_code" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."plan_version_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"metric_code" varchar(64) NOT NULL,
	"scope" "license"."limit_scope" NOT NULL,
	"period" "license"."limit_period" NOT NULL,
	"limit_value" bigint NOT NULL,
	"enforcement" "license"."enforcement" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."plan_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "license"."plan_version_status" DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_id" uuid,
	"retired_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(64) NOT NULL,
	"status" "license"."catalog_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "plans_code_uq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "license"."products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(64) NOT NULL,
	"status" "license"."catalog_status" DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "products_code_uq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "license"."subscription_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_status" "license"."subscription_status",
	"to_status" "license"."subscription_status" NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"change" varchar(32) NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."subscription_properties" (
	"subscription_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_properties_pk" PRIMARY KEY("subscription_id","property_id")
);
--> statement-breakpoint
CREATE TABLE "license"."subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"scope" "license"."subscription_scope" NOT NULL,
	"status" "license"."subscription_status" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"grace_days" smallint DEFAULT 0 NOT NULL,
	"external_ref" varchar(128),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."usage_aggregates" (
	"tenant_id" uuid NOT NULL,
	"property_key" uuid NOT NULL,
	"metric_code" varchar(64) NOT NULL,
	"granularity" "license"."granularity" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"quantity" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_aggregates_pk" PRIMARY KEY("tenant_id","property_key","metric_code","granularity","period_start")
);
--> statement-breakpoint
CREATE TABLE "license"."usage_collector_cursors" (
	"collector" varchar(64) PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license"."usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"metric_code" varchar(64) NOT NULL,
	"quantity" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" varchar(64) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "license"."entitlement_grants" ADD CONSTRAINT "entitlement_grants_capability_code_capabilities_code_fk" FOREIGN KEY ("capability_code") REFERENCES "license"."capabilities"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."limit_overrides" ADD CONSTRAINT "limit_overrides_metric_code_metrics_code_fk" FOREIGN KEY ("metric_code") REFERENCES "license"."metrics"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."plan_translations" ADD CONSTRAINT "plan_translations_entity_id_plans_id_fk" FOREIGN KEY ("entity_id") REFERENCES "license"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."plan_version_items" ADD CONSTRAINT "plan_version_items_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "license"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."plan_version_items" ADD CONSTRAINT "plan_version_items_capability_code_capabilities_code_fk" FOREIGN KEY ("capability_code") REFERENCES "license"."capabilities"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."plan_version_limits" ADD CONSTRAINT "plan_version_limits_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "license"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."plan_version_limits" ADD CONSTRAINT "plan_version_limits_metric_code_metrics_code_fk" FOREIGN KEY ("metric_code") REFERENCES "license"."metrics"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "license"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."subscription_history" ADD CONSTRAINT "subscription_history_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "license"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."subscription_properties" ADD CONSTRAINT "subscription_properties_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "license"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "license"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."usage_aggregates" ADD CONSTRAINT "usage_aggregates_metric_code_metrics_code_fk" FOREIGN KEY ("metric_code") REFERENCES "license"."metrics"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license"."usage_events" ADD CONSTRAINT "usage_events_metric_code_metrics_code_fk" FOREIGN KEY ("metric_code") REFERENCES "license"."metrics"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlement_grants_tenant_idx" ON "license"."entitlement_grants" USING btree ("tenant_id","capability_code");--> statement-breakpoint
CREATE INDEX "limit_overrides_tenant_idx" ON "license"."limit_overrides" USING btree ("tenant_id","metric_code");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_items_uq" ON "license"."plan_version_items" USING btree ("plan_version_id","capability_code");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_limits_uq" ON "license"."plan_version_limits" USING btree ("plan_version_id","metric_code","scope","period");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_no_uq" ON "license"."plan_versions" USING btree ("plan_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_one_draft_uq" ON "license"."plan_versions" USING btree ("plan_id") WHERE "license"."plan_versions"."status" = 'DRAFT';--> statement-breakpoint
CREATE INDEX "subscription_history_idx" ON "license"."subscription_history" USING btree ("subscription_id","at");--> statement-breakpoint
CREATE INDEX "subscription_properties_property_idx" ON "license"."subscription_properties" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_idx" ON "license"."subscriptions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idempotency_uq" ON "license"."usage_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_events_metric_idx" ON "license"."usage_events" USING btree ("tenant_id","metric_code","occurred_at");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, value checks, immutable published plan versions (CLAUDE.md
-- rule 9), append-only subscription history and grants that are revoked rather than deleted (rule 10), and
-- row-level security on the tenant-owned tables as in migration 0006. The catalog and plans are platform-level.
ALTER TABLE "license"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."subscription_properties" ADD CONSTRAINT "subscription_properties_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."subscription_properties" ADD CONSTRAINT "subscription_properties_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."subscription_history" ADD CONSTRAINT "subscription_history_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."entitlement_grants" ADD CONSTRAINT "entitlement_grants_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."entitlement_grants" ADD CONSTRAINT "entitlement_grants_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."limit_overrides" ADD CONSTRAINT "limit_overrides_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."limit_overrides" ADD CONSTRAINT "limit_overrides_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."usage_events" ADD CONSTRAINT "usage_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."usage_events" ADD CONSTRAINT "usage_events_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."usage_aggregates" ADD CONSTRAINT "usage_aggregates_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "license"."capabilities" ADD CONSTRAINT "capabilities_feature_module_ck" CHECK (("kind" = 'FEATURE') = ("module_code" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "license"."plan_versions" ADD CONSTRAINT "plan_versions_published_ck" CHECK (("status" = 'DRAFT') = ("published_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "license"."plan_versions" ADD CONSTRAINT "plan_versions_retired_ck" CHECK (("status" = 'RETIRED') = ("retired_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "license"."plan_version_limits" ADD CONSTRAINT "plan_version_limits_value_ck" CHECK ("limit_value" >= 0);
--> statement-breakpoint
ALTER TABLE "license"."limit_overrides" ADD CONSTRAINT "limit_overrides_value_ck" CHECK ("limit_value" >= 0);
--> statement-breakpoint
ALTER TABLE "license"."subscriptions" ADD CONSTRAINT "subscriptions_period_ck" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "license"."subscriptions" ADD CONSTRAINT "subscriptions_grace_ck" CHECK ("grace_days" BETWEEN 0 AND 90);
--> statement-breakpoint
ALTER TABLE "license"."entitlement_grants" ADD CONSTRAINT "entitlement_grants_period_ck" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from");
--> statement-breakpoint
ALTER TABLE "license"."entitlement_grants" ADD CONSTRAINT "entitlement_grants_revoked_ck" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));
--> statement-breakpoint
ALTER TABLE "license"."usage_events" ADD CONSTRAINT "usage_events_quantity_ck" CHECK ("quantity" >= 0);
--> statement-breakpoint
CREATE FUNCTION "license"."plan_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A published plan version is frozen (CLAUDE.md rule 9): the only change left is retiring it.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'published plan versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       (NEW.id, NEW.plan_id, NEW.version_no, NEW.notes, NEW.created_by_id, NEW.published_at, NEW.published_by_id)
       IS DISTINCT FROM
       (OLD.id, OLD.plan_id, OLD.version_no, OLD.notes, OLD.created_by_id, OLD.published_at, OLD.published_by_id)
       OR NOT (NEW.status = OLD.status OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'))) THEN
    RAISE EXCEPTION 'published plan versions are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "plan_versions_immutable" BEFORE UPDATE OR DELETE ON "license"."plan_versions" FOR EACH ROW EXECUTE FUNCTION "license"."plan_versions_immutable"();
--> statement-breakpoint
CREATE FUNCTION "license"."plan_version_parts_draft_only"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_version_id ELSE NEW.plan_version_id END;
BEGIN
  -- Items and limits belong to the version: they change only while it is a draft.
  IF (SELECT status FROM "license"."plan_versions" WHERE id = parent) <> 'DRAFT'
     OR (TG_OP = 'UPDATE' AND OLD.plan_version_id IS DISTINCT FROM NEW.plan_version_id) THEN
    RAISE EXCEPTION 'published plan versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER "plan_version_items_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "license"."plan_version_items" FOR EACH ROW EXECUTE FUNCTION "license"."plan_version_parts_draft_only"();
--> statement-breakpoint
CREATE TRIGGER "plan_version_limits_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "license"."plan_version_limits" FOR EACH ROW EXECUTE FUNCTION "license"."plan_version_parts_draft_only"();
--> statement-breakpoint
CREATE FUNCTION "license"."append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'license.% is append-only', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER "subscription_history_append_only" BEFORE UPDATE OR DELETE ON "license"."subscription_history" FOR EACH ROW EXECUTE FUNCTION "license"."append_only"();
--> statement-breakpoint
CREATE FUNCTION "license"."no_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Grants, overrides and subscriptions are ended (revoked, cancelled), never deleted: history stays (rule 10).
  RAISE EXCEPTION 'license.% rows are never deleted', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER "subscriptions_no_delete" BEFORE DELETE ON "license"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "license"."no_delete"();
--> statement-breakpoint
CREATE TRIGGER "entitlement_grants_no_delete" BEFORE DELETE ON "license"."entitlement_grants" FOR EACH ROW EXECUTE FUNCTION "license"."no_delete"();
--> statement-breakpoint
CREATE TRIGGER "limit_overrides_no_delete" BEFORE DELETE ON "license"."limit_overrides" FOR EACH ROW EXECUTE FUNCTION "license"."no_delete"();
--> statement-breakpoint
CREATE FUNCTION "license"."usage_events_no_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A measured occurrence is never edited; only the retention purge removes old rows.
  RAISE EXCEPTION 'license.usage_events rows are never updated';
END $$;
--> statement-breakpoint
CREATE TRIGGER "usage_events_no_update" BEFORE UPDATE ON "license"."usage_events" FOR EACH ROW EXECUTE FUNCTION "license"."usage_events_no_update"();
--> statement-breakpoint
ALTER TABLE "license"."subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."subscriptions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "license"."subscription_properties" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."subscription_properties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."subscription_properties" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "license"."subscription_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."subscription_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."subscription_history" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "license"."entitlement_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."entitlement_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."entitlement_grants" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "license"."limit_overrides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."limit_overrides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."limit_overrides" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "license"."usage_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."usage_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."usage_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "license"."usage_aggregates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."usage_aggregates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."usage_aggregates" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
