CREATE EXTENSION IF NOT EXISTS ltree;
--> statement-breakpoint
CREATE SCHEMA "org";
--> statement-breakpoint
CREATE TYPE "org"."active_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "org"."brand_scope" AS ENUM('TENANT', 'ORGANIZATION', 'PROPERTY', 'CHANNEL');--> statement-breakpoint
CREATE TYPE "org"."location_kind" AS ENUM('PROPERTY', 'BUILDING', 'FLOOR', 'ROOM', 'AREA', 'PLANT', 'OTHER');--> statement-breakpoint
CREATE TYPE "org"."organization_type" AS ENUM('GROUP', 'BRAND', 'LEGAL_ENTITY', 'OTHER');--> statement-breakpoint
CREATE TYPE "org"."property_status" AS ENUM('DRAFT', 'ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "org"."tenant_status" AS ENUM('ACTIVE', 'SUSPENDED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "org"."brand_profile_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"welcome_text" text,
	"farewell_text" text,
	CONSTRAINT "brand_profile_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "org"."brand_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" "org"."brand_scope" NOT NULL,
	"scope_id" uuid NOT NULL,
	"channel" varchar(32),
	"display_name" text,
	"logo_asset_key" text,
	"logo_alt_asset_key" text,
	"primary_color" varchar(9),
	"secondary_color" varchar(9),
	"cover_asset_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"favicon_asset_key" text,
	"typography" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"social" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_persona" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"presentation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "brand_profiles_scope_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","scope","scope_id","channel")
);
--> statement-breakpoint
CREATE TABLE "org"."location_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "location_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "org"."locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" "org"."location_kind" NOT NULL,
	"code" varchar(64) NOT NULL,
	"path" "ltree" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" "org"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "locations_property_path_uq" UNIQUE("property_id","path")
);
--> statement-breakpoint
CREATE TABLE "org"."organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"type" "org"."organization_type" DEFAULT 'BRAND' NOT NULL,
	"status" "org"."active_status" DEFAULT 'ACTIVE' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "organizations_tenant_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "org"."properties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"currency" char(3) NOT NULL,
	"default_locale" varchar(16) DEFAULT 'en' NOT NULL,
	"enabled_locales" text[] DEFAULT '{en,ar}'::text[] NOT NULL,
	"country" char(2),
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"geo_lat" numeric(9, 6),
	"geo_lng" numeric(9, 6),
	"status" "org"."property_status" DEFAULT 'DRAFT' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "properties_tenant_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "org"."room_type_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "room_type_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "org"."room_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"capacity" integer DEFAULT 2 NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "room_types_property_code_uq" UNIQUE("property_id","code")
);
--> statement-breakpoint
CREATE TABLE "org"."rooms" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_number" varchar(16) NOT NULL,
	"room_type_id" uuid,
	"bed_config" varchar(64),
	"floor_label" varchar(32),
	"connecting_room_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_property_number_uq" UNIQUE("property_id","room_number")
);
--> statement-breakpoint
CREATE TABLE "org"."tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"status" "org"."tenant_status" DEFAULT 'ACTIVE' NOT NULL,
	"default_locale" varchar(16) DEFAULT 'en' NOT NULL,
	"default_timezone" varchar(64) DEFAULT 'Africa/Cairo' NOT NULL,
	"default_currency" char(3) DEFAULT 'EGP' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tenants_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "org"."brand_profile_translations" ADD CONSTRAINT "brand_profile_translations_entity_id_brand_profiles_id_fk" FOREIGN KEY ("entity_id") REFERENCES "org"."brand_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."brand_profiles" ADD CONSTRAINT "brand_profiles_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."location_translations" ADD CONSTRAINT "location_translations_entity_id_locations_id_fk" FOREIGN KEY ("entity_id") REFERENCES "org"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."locations" ADD CONSTRAINT "locations_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "org"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD CONSTRAINT "organizations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD CONSTRAINT "organizations_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "org"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."properties" ADD CONSTRAINT "properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."properties" ADD CONSTRAINT "properties_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."room_type_translations" ADD CONSTRAINT "room_type_translations_entity_id_room_types_id_fk" FOREIGN KEY ("entity_id") REFERENCES "org"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."room_types" ADD CONSTRAINT "room_types_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."room_types" ADD CONSTRAINT "room_types_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."rooms" ADD CONSTRAINT "rooms_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "org"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."rooms" ADD CONSTRAINT "rooms_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "org"."room_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."rooms" ADD CONSTRAINT "rooms_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."rooms" ADD CONSTRAINT "rooms_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org"."rooms" ADD CONSTRAINT "rooms_connecting_room_fk" FOREIGN KEY ("connecting_room_id") REFERENCES "org"."rooms"("location_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "locations_path_gist" ON "org"."locations" USING gist ("path");--> statement-breakpoint
CREATE INDEX "locations_parent_idx" ON "org"."locations" USING btree ("property_id","parent_id");--> statement-breakpoint
CREATE INDEX "organizations_tenant_idx" ON "org"."organizations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "properties_tenant_idx" ON "org"."properties" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "rooms_property_idx" ON "org"."rooms" USING btree ("property_id");