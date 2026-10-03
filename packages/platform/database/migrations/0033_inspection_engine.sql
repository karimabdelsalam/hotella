CREATE SCHEMA "inspection";
--> statement-breakpoint
CREATE TYPE "inspection"."finding_severity" AS ENUM('INFO', 'MINOR', 'MAJOR', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "inspection"."finding_status" AS ENUM('OPEN', 'LINKED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "inspection"."inspection_result" AS ENUM('PASS', 'FAIL');--> statement-breakpoint
CREATE TYPE "inspection"."inspection_source" AS ENUM('STAFF', 'SCHEDULE', 'HK_JOB', 'WORK_ORDER');--> statement-breakpoint
CREATE TYPE "inspection"."inspection_status" AS ENUM('IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "inspection"."template_scope" AS ENUM('ROOM', 'AREA', 'ASSET');--> statement-breakpoint
CREATE TYPE "inspection"."version_status" AS ENUM('DRAFT', 'PUBLISHED');--> statement-breakpoint
CREATE TABLE "inspection"."findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"severity" "inspection"."finding_severity" NOT NULL,
	"status" "inspection"."finding_status" DEFAULT 'OPEN' NOT NULL,
	"work_item_id" uuid,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection"."inspections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"asset_id" uuid,
	"source" "inspection"."inspection_source" NOT NULL,
	"source_ref" varchar(64),
	"status" "inspection"."inspection_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"inspector_type" varchar(16) NOT NULL,
	"inspector_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"score" integer,
	"result" "inspection"."inspection_result",
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection"."responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inspection_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"answer" jsonb NOT NULL,
	"note" text,
	"answered_by_type" varchar(16) NOT NULL,
	"answered_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "inspection"."template_item_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"label" text NOT NULL,
	"help" text,
	"option_labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "template_item_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "inspection"."template_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"position" integer NOT NULL,
	"rule" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection"."template_section_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "template_section_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "inspection"."template_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection"."template_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "template_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "inspection"."template_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "inspection"."version_status" DEFAULT 'DRAFT' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "inspection"."templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"scope" "inspection"."template_scope" NOT NULL,
	"department_code" varchar(32) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspection"."findings" ADD CONSTRAINT "findings_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "inspection"."inspections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."findings" ADD CONSTRAINT "findings_item_id_template_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "inspection"."template_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."inspections" ADD CONSTRAINT "inspections_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "inspection"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."inspections" ADD CONSTRAINT "inspections_template_version_id_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "inspection"."template_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."responses" ADD CONSTRAINT "responses_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "inspection"."inspections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."responses" ADD CONSTRAINT "responses_item_id_template_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "inspection"."template_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."template_item_translations" ADD CONSTRAINT "template_item_translations_entity_id_template_items_id_fk" FOREIGN KEY ("entity_id") REFERENCES "inspection"."template_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."template_items" ADD CONSTRAINT "template_items_version_id_template_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "inspection"."template_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."template_items" ADD CONSTRAINT "template_items_section_id_template_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "inspection"."template_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."template_section_translations" ADD CONSTRAINT "template_section_translations_entity_id_template_sections_id_fk" FOREIGN KEY ("entity_id") REFERENCES "inspection"."template_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."template_sections" ADD CONSTRAINT "template_sections_version_id_template_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "inspection"."template_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."template_translations" ADD CONSTRAINT "template_translations_entity_id_templates_id_fk" FOREIGN KEY ("entity_id") REFERENCES "inspection"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection"."template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "inspection"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "findings_item_uq" ON "inspection"."findings" USING btree ("inspection_id","item_id");--> statement-breakpoint
CREATE INDEX "findings_status_idx" ON "inspection"."findings" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_number_uq" ON "inspection"."inspections" USING btree ("property_id","number");--> statement-breakpoint
CREATE INDEX "inspections_location_idx" ON "inspection"."inspections" USING btree ("tenant_id","property_id","location_id");--> statement-breakpoint
CREATE INDEX "inspections_status_idx" ON "inspection"."inspections" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE INDEX "responses_inspection_idx" ON "inspection"."responses" USING btree ("inspection_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_items_code_uq" ON "inspection"."template_items" USING btree ("version_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "template_sections_code_uq" ON "inspection"."template_sections" USING btree ("version_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_no_uq" ON "inspection"."template_versions" USING btree ("template_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_code_uq" ON "inspection"."templates" USING btree ("tenant_id","code");--> statement-breakpoint
ALTER TABLE "inspection"."templates" ADD CONSTRAINT "templates_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."template_versions" ADD CONSTRAINT "template_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."template_sections" ADD CONSTRAINT "template_sections_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."template_items" ADD CONSTRAINT "template_items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."inspections" ADD CONSTRAINT "inspections_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."responses" ADD CONSTRAINT "responses_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."findings" ADD CONSTRAINT "findings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."inspections" ADD CONSTRAINT "inspections_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."findings" ADD CONSTRAINT "findings_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "inspection"."templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inspection"."templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection"."templates" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "inspection"."template_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inspection"."template_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection"."template_versions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "inspection"."template_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inspection"."template_sections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection"."template_sections" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "inspection"."template_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inspection"."template_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection"."template_items" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "inspection"."inspections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inspection"."inspections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection"."inspections" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "inspection"."responses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inspection"."responses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection"."responses" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "inspection"."findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inspection"."findings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inspection"."findings" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "inspection"."inspections" ADD CONSTRAINT "inspections_location_fk" FOREIGN KEY ("location_id") REFERENCES "org"."locations"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE FUNCTION "inspection"."template_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A published checklist version never changes (CLAUDE.md rule 9); publishing itself is the last allowed update.
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'inspection.template_versions: a published version is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "template_versions_immutable" BEFORE UPDATE OR DELETE ON "inspection"."template_versions" FOR EACH ROW EXECUTE FUNCTION "inspection"."template_versions_immutable"();
--> statement-breakpoint
CREATE FUNCTION "inspection"."version_content_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_id uuid;
BEGIN
  -- Sections, items and their translations belong to a version: once it is published they never change.
  IF TG_TABLE_NAME IN ('template_sections', 'template_items') THEN
    version_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
  ELSIF TG_TABLE_NAME = 'template_section_translations' THEN
    SELECT s.version_id INTO version_id FROM "inspection"."template_sections" s
      WHERE s.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.entity_id ELSE OLD.entity_id END;
  ELSE
    SELECT i.version_id INTO version_id FROM "inspection"."template_items" i
      WHERE i.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.entity_id ELSE OLD.entity_id END;
  END IF;
  IF EXISTS (SELECT 1 FROM "inspection"."template_versions" v WHERE v.id = version_id AND v.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'inspection.%: the content of a published version is immutable', TG_TABLE_NAME;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "template_sections_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "inspection"."template_sections" FOR EACH ROW EXECUTE FUNCTION "inspection"."version_content_immutable"();
--> statement-breakpoint
CREATE TRIGGER "template_items_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "inspection"."template_items" FOR EACH ROW EXECUTE FUNCTION "inspection"."version_content_immutable"();
--> statement-breakpoint
CREATE TRIGGER "template_section_translations_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "inspection"."template_section_translations" FOR EACH ROW EXECUTE FUNCTION "inspection"."version_content_immutable"();
--> statement-breakpoint
CREATE TRIGGER "template_item_translations_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "inspection"."template_item_translations" FOR EACH ROW EXECUTE FUNCTION "inspection"."version_content_immutable"();
--> statement-breakpoint
CREATE FUNCTION "inspection"."responses_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Every answer is kept as given; a correction is a new answer (the latest counts).
  RAISE EXCEPTION 'inspection.responses is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "responses_no_update_delete" BEFORE UPDATE OR DELETE ON "inspection"."responses" FOR EACH ROW EXECUTE FUNCTION "inspection"."responses_append_only"();
