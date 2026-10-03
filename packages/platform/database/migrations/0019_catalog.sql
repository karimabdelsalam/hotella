CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE TYPE "catalog"."category_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "catalog"."definition_status" AS ENUM('ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "catalog"."priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "catalog"."request_event_type" AS ENUM('CREATED', 'RELATED', 'STATUS_CHANGED');--> statement-breakpoint
CREATE TYPE "catalog"."request_source" AS ENUM('GUEST_WEB', 'WHATSAPP', 'STAFF', 'AI', 'QR');--> statement-breakpoint
CREATE TYPE "catalog"."request_status" AS ENUM('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "catalog"."version_status" AS ENUM('DRAFT', 'PUBLISHED', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE "catalog"."service_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"code" varchar(64) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"icon" varchar(40),
	"status" "catalog"."category_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."service_category_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "service_category_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "catalog"."service_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"code" varchar(64) NOT NULL,
	"category_id" uuid NOT NULL,
	"status" "catalog"."definition_status" DEFAULT 'ACTIVE' NOT NULL,
	"published_version_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."service_request_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"type" "catalog"."request_event_type" NOT NULL,
	"from_status" "catalog"."request_status",
	"to_status" "catalog"."request_status",
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"source" "catalog"."request_source",
	"fields" jsonb,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."service_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"service_version_id" uuid NOT NULL,
	"service_code" varchar(64) NOT NULL,
	"guest_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"room_id" uuid,
	"conversation_id" uuid,
	"work_item_id" uuid,
	"status" "catalog"."request_status" DEFAULT 'OPEN' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_for_at" timestamp with time zone,
	"locale" varchar(16) NOT NULL,
	"source" "catalog"."request_source" NOT NULL,
	"created_by_type" varchar(16) NOT NULL,
	"created_by_id" uuid,
	"related_count" integer DEFAULT 0 NOT NULL,
	"last_related_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."service_version_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"short_description" text,
	"description" text,
	"guest_prompt_hints" text,
	"field_labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "service_version_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "catalog"."service_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "catalog"."version_status" DEFAULT 'DRAFT' NOT NULL,
	"department_code" varchar(32) NOT NULL,
	"priority" "catalog"."priority" DEFAULT 'NORMAL' NOT NULL,
	"workflow_code" varchar(64),
	"required_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"availability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"guest_visible" boolean DEFAULT true NOT NULL,
	"automation_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price" jsonb,
	"duplicate_window_minutes" smallint DEFAULT 30 NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "service_versions_definition_no_uq" UNIQUE("definition_id","version_no")
);
--> statement-breakpoint
ALTER TABLE "catalog"."service_category_translations" ADD CONSTRAINT "service_category_translations_entity_id_service_categories_id_fk" FOREIGN KEY ("entity_id") REFERENCES "catalog"."service_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."service_definitions" ADD CONSTRAINT "service_definitions_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "catalog"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."service_request_events" ADD CONSTRAINT "service_request_events_request_id_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "catalog"."service_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_definition_id_service_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "catalog"."service_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_service_version_id_service_versions_id_fk" FOREIGN KEY ("service_version_id") REFERENCES "catalog"."service_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."service_version_translations" ADD CONSTRAINT "service_version_translations_entity_id_service_versions_id_fk" FOREIGN KEY ("entity_id") REFERENCES "catalog"."service_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."service_versions" ADD CONSTRAINT "service_versions_definition_id_service_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "catalog"."service_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_categories_tenant_code_uq" ON "catalog"."service_categories" USING btree ("tenant_id","code") WHERE "catalog"."service_categories"."property_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "service_categories_property_code_uq" ON "catalog"."service_categories" USING btree ("tenant_id","property_id","code") WHERE "catalog"."service_categories"."property_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "service_definitions_tenant_code_uq" ON "catalog"."service_definitions" USING btree ("tenant_id","code") WHERE "catalog"."service_definitions"."property_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "service_definitions_property_code_uq" ON "catalog"."service_definitions" USING btree ("tenant_id","property_id","code") WHERE "catalog"."service_definitions"."property_id" is not null;--> statement-breakpoint
CREATE INDEX "service_definitions_category_idx" ON "catalog"."service_definitions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "service_request_events_request_idx" ON "catalog"."service_request_events" USING btree ("tenant_id","request_id","id");--> statement-breakpoint
CREATE INDEX "service_requests_stay_service_idx" ON "catalog"."service_requests" USING btree ("tenant_id","stay_id","definition_id","status");--> statement-breakpoint
CREATE INDEX "service_requests_board_idx" ON "catalog"."service_requests" USING btree ("tenant_id","property_id","status","created_at");--> statement-breakpoint
CREATE INDEX "service_requests_guest_idx" ON "catalog"."service_requests" USING btree ("tenant_id","guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_requests_work_item_uq" ON "catalog"."service_requests" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_versions_one_draft_uq" ON "catalog"."service_versions" USING btree ("definition_id") WHERE "catalog"."service_versions"."status" = 'DRAFT';--> statement-breakpoint
ALTER TABLE "catalog"."service_categories" ADD CONSTRAINT "service_categories_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_definitions" ADD CONSTRAINT "service_definitions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_versions" ADD CONSTRAINT "service_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_request_events" ADD CONSTRAINT "service_request_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_categories" ADD CONSTRAINT "service_categories_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_definitions" ADD CONSTRAINT "service_definitions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;

--> statement-breakpoint
ALTER TABLE "catalog"."service_categories" ADD CONSTRAINT "service_categories_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "catalog"."service_categories"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_definitions" ADD CONSTRAINT "service_definitions_published_version_fk" FOREIGN KEY ("published_version_id") REFERENCES "catalog"."service_versions"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_guest_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_stay_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_work_item_fk" FOREIGN KEY ("work_item_id") REFERENCES "ops"."work_items"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ADD CONSTRAINT "service_requests_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "comms"."conversations"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE FUNCTION "catalog"."service_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Published definitions are immutable (CLAUDE.md rule 9): a published version may only be superseded; drafts may be
  -- edited or discarded.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'catalog.service_versions: a published version cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED'
     AND (NEW.id, NEW.tenant_id, NEW.definition_id, NEW.version_no, NEW.department_code, NEW.priority,
          NEW.workflow_code, NEW.required_fields, NEW.eligibility, NEW.availability, NEW.guest_visible,
          NEW.automation_policy, NEW.price, NEW.duplicate_window_minutes, NEW.published_at, NEW.published_by,
          NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.tenant_id, OLD.definition_id, OLD.version_no, OLD.department_code, OLD.priority,
          OLD.workflow_code, OLD.required_fields, OLD.eligibility, OLD.availability, OLD.guest_visible,
          OLD.automation_policy, OLD.price, OLD.duplicate_window_minutes, OLD.published_at, OLD.published_by,
          OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'catalog.service_versions: version % is % and immutable', OLD.id, OLD.status;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "service_versions_immutable" BEFORE UPDATE OR DELETE ON "catalog"."service_versions" FOR EACH ROW EXECUTE FUNCTION "catalog"."service_versions_immutable"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."service_version_translations_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status "catalog"."version_status";
BEGIN
  -- The texts of a published version are part of what was published (rule 9).
  SELECT status INTO parent_status FROM "catalog"."service_versions"
    WHERE id = COALESCE(NEW.entity_id, OLD.entity_id);
  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'catalog.service_version_translations: version is % and immutable', parent_status;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "service_version_translations_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "catalog"."service_version_translations" FOR EACH ROW EXECUTE FUNCTION "catalog"."service_version_translations_immutable"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."service_request_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Request history (CLAUDE.md rule 10): never deleted; only the guest's words (field values, reason) may be cleared
  -- when the guest is anonymized (Spec §69).
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.service_request_events is append-only';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.request_id, NEW.type, NEW.from_status, NEW.to_status, NEW.actor_type, NEW.actor_id,
      NEW.source, NEW.occurred_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.request_id, OLD.type, OLD.from_status, OLD.to_status, OLD.actor_type, OLD.actor_id,
      OLD.source, OLD.occurred_at) THEN
    RAISE EXCEPTION 'catalog.service_request_events is append-only';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "service_request_events_append_only" BEFORE UPDATE OR DELETE ON "catalog"."service_request_events" FOR EACH ROW EXECUTE FUNCTION "catalog"."service_request_events_append_only"();
--> statement-breakpoint
ALTER TABLE "catalog"."service_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."service_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "catalog"."service_categories" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "catalog"."service_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."service_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "catalog"."service_definitions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "catalog"."service_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."service_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "catalog"."service_versions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."service_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "catalog"."service_requests" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "catalog"."service_request_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."service_request_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "catalog"."service_request_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
