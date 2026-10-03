CREATE SCHEMA "eng";
--> statement-breakpoint
CREATE TYPE "eng"."asset_status" AS ENUM('ACTIVE', 'OUT_OF_SERVICE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "eng"."criticality" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "eng"."asset_document_kind" AS ENUM('MANUAL', 'DATASHEET', 'WARRANTY', 'DIAGRAM', 'PHOTO');--> statement-breakpoint
CREATE TYPE "eng"."failure_kind" AS ENUM('SYMPTOM', 'FAILURE_MODE', 'CAUSE', 'RESOLUTION');--> statement-breakpoint
CREATE TABLE "eng"."asset_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid,
	"asset_model_id" uuid,
	"knowledge_document_id" uuid NOT NULL,
	"kind" "eng"."asset_document_kind" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."asset_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"manufacturer" varchar(120) NOT NULL,
	"model_code" varchar(120) NOT NULL,
	"expected_life_months" integer,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."asset_type_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "asset_type_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "eng"."asset_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"properties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"parent_asset_id" uuid,
	"asset_number" varchar(40) NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"asset_model_id" uuid,
	"location_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"serial_number" varchar(120),
	"status" "eng"."asset_status" DEFAULT 'ACTIVE' NOT NULL,
	"criticality" "eng"."criticality" DEFAULT 'MEDIUM' NOT NULL,
	"installed_at" date,
	"warranty_until" date,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng"."failure_code_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "failure_code_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "eng"."failure_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "eng"."failure_kind" NOT NULL,
	"code" varchar(60) NOT NULL,
	"asset_type_id" uuid,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eng"."asset_documents" ADD CONSTRAINT "asset_documents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "eng"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."asset_documents" ADD CONSTRAINT "asset_documents_asset_model_id_asset_models_id_fk" FOREIGN KEY ("asset_model_id") REFERENCES "eng"."asset_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."asset_models" ADD CONSTRAINT "asset_models_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "eng"."asset_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."asset_type_translations" ADD CONSTRAINT "asset_type_translations_entity_id_asset_types_id_fk" FOREIGN KEY ("entity_id") REFERENCES "eng"."asset_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."assets" ADD CONSTRAINT "assets_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "eng"."asset_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."assets" ADD CONSTRAINT "assets_asset_model_id_asset_models_id_fk" FOREIGN KEY ("asset_model_id") REFERENCES "eng"."asset_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."failure_code_translations" ADD CONSTRAINT "failure_code_translations_entity_id_failure_codes_id_fk" FOREIGN KEY ("entity_id") REFERENCES "eng"."failure_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."failure_codes" ADD CONSTRAINT "failure_codes_asset_type_id_asset_types_id_fk" FOREIGN KEY ("asset_type_id") REFERENCES "eng"."asset_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_documents_asset_uq" ON "eng"."asset_documents" USING btree ("asset_id","knowledge_document_id") WHERE "eng"."asset_documents"."asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_documents_model_uq" ON "eng"."asset_documents" USING btree ("asset_model_id","knowledge_document_id") WHERE "eng"."asset_documents"."asset_model_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_models_uq" ON "eng"."asset_models" USING btree ("tenant_id","manufacturer","model_code");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_types_code_uq" ON "eng"."asset_types" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_number_uq" ON "eng"."assets" USING btree ("property_id","asset_number");--> statement-breakpoint
CREATE INDEX "assets_location_idx" ON "eng"."assets" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "assets_parent_idx" ON "eng"."assets" USING btree ("parent_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "failure_codes_uq" ON "eng"."failure_codes" USING btree ("tenant_id","kind","code");--> statement-breakpoint
ALTER TABLE "eng"."asset_types" ADD CONSTRAINT "asset_types_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."asset_models" ADD CONSTRAINT "asset_models_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."assets" ADD CONSTRAINT "assets_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."asset_documents" ADD CONSTRAINT "asset_documents_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."failure_codes" ADD CONSTRAINT "failure_codes_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."assets" ADD CONSTRAINT "assets_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."asset_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."asset_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."asset_types" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."asset_models" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."asset_models" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."asset_models" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."assets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."assets" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."asset_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."asset_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."asset_documents" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."failure_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eng"."failure_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."failure_codes" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "eng"."assets" ADD CONSTRAINT "assets_location_fk" FOREIGN KEY ("location_id") REFERENCES "org"."locations"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."assets" ADD CONSTRAINT "assets_parent_fk" FOREIGN KEY ("parent_asset_id") REFERENCES "eng"."assets"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."asset_documents" ADD CONSTRAINT "asset_documents_document_fk" FOREIGN KEY ("knowledge_document_id") REFERENCES "knowledge"."documents"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "eng"."asset_documents" ADD CONSTRAINT "asset_documents_one_target" CHECK (("asset_id" IS NULL) <> ("asset_model_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "eng"."asset_models" ADD CONSTRAINT "asset_models_life_range" CHECK ("expected_life_months" IS NULL OR "expected_life_months" BETWEEN 1 AND 1200);
