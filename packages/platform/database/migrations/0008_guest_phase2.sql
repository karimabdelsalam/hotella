CREATE SCHEMA "guest";
--> statement-breakpoint
CREATE TYPE "guest"."assignment_reason" AS ENUM('PRE_ASSIGNMENT', 'INITIAL', 'ROOM_MOVE', 'UPGRADE', 'MAINTENANCE');--> statement-breakpoint
CREATE TYPE "guest"."guest_status" AS ENUM('ACTIVE', 'MERGED', 'ANONYMIZED');--> statement-breakpoint
CREATE TYPE "guest"."identifier_kind" AS ENUM('EMAIL', 'PHONE', 'LOYALTY', 'DOCUMENT_HASH');--> statement-breakpoint
CREATE TYPE "guest"."party_role" AS ENUM('PRIMARY', 'ACCOMPANYING');--> statement-breakpoint
CREATE TYPE "guest"."stay_status" AS ENUM('EXPECTED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TABLE "guest"."guest_identifiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"kind" "guest"."identifier_kind" NOT NULL,
	"value_normalized" varchar(320) NOT NULL,
	"source" varchar(16) NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "guest_identifiers_value_uq" UNIQUE("guest_id","kind","value_normalized")
);
--> statement-breakpoint
CREATE TABLE "guest"."guests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"given_name" text NOT NULL,
	"family_name" text,
	"title" varchar(40),
	"primary_locale" varchar(16),
	"vip_code" varchar(32),
	"status" "guest"."guest_status" DEFAULT 'ACTIVE' NOT NULL,
	"merged_into_guest_id" uuid,
	"anonymized_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest"."reservation_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"integration_instance_id" uuid NOT NULL,
	"confirmation_number" varchar(64),
	"last_event_type" varchar(96) NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reservation_references_stay_uq" UNIQUE("stay_id","integration_instance_id")
);
--> statement-breakpoint
CREATE TABLE "guest"."room_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	"unassigned_at" timestamp with time zone,
	"reason" "guest"."assignment_reason" NOT NULL,
	"source_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "guest"."stay_party_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"role" "guest"."party_role" NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "guest"."stays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"status" "guest"."stay_status" NOT NULL,
	"primary_guest_id" uuid NOT NULL,
	"expected_arrival" date NOT NULL,
	"expected_departure" date NOT NULL,
	"actual_checkin_at" timestamp with time zone,
	"actual_checkout_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"eta" timestamp with time zone,
	"adults" integer DEFAULT 1 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"rate_code" varchar(32),
	"market_code" varchar(32),
	"last_pms_event_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest"."guest_identifiers" ADD CONSTRAINT "guest_identifiers_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."reservation_references" ADD CONSTRAINT "reservation_references_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."room_assignments" ADD CONSTRAINT "room_assignments_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."stay_party_members" ADD CONSTRAINT "stay_party_members_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."stay_party_members" ADD CONSTRAINT "stay_party_members_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."stays" ADD CONSTRAINT "stays_primary_guest_id_guests_id_fk" FOREIGN KEY ("primary_guest_id") REFERENCES "guest"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_identifiers_lookup_idx" ON "guest"."guest_identifiers" USING btree ("tenant_id","kind","value_normalized");--> statement-breakpoint
CREATE INDEX "guests_tenant_name_idx" ON "guest"."guests" USING btree ("tenant_id","family_name","given_name");--> statement-breakpoint
CREATE UNIQUE INDEX "room_assignments_open_uq" ON "guest"."room_assignments" USING btree ("stay_id") WHERE "guest"."room_assignments"."unassigned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "room_assignments_room_open_idx" ON "guest"."room_assignments" USING btree ("tenant_id","room_id") WHERE "guest"."room_assignments"."unassigned_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stay_party_members_active_uq" ON "guest"."stay_party_members" USING btree ("stay_id","guest_id") WHERE "guest"."stay_party_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stay_party_members_guest_idx" ON "guest"."stay_party_members" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "stays_property_status_idx" ON "guest"."stays" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE INDEX "stays_primary_guest_idx" ON "guest"."stays" USING btree ("primary_guest_id");--> statement-breakpoint
-- Hand-written (reviewed): integrity across contexts (FKs to org and integration), history sanity, and row-level
-- security as in migration 0006.
ALTER TABLE "guest"."guests" ADD CONSTRAINT "guests_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_identifiers" ADD CONSTRAINT "guest_identifiers_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."stays" ADD CONSTRAINT "stays_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."reservation_references" ADD CONSTRAINT "reservation_references_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."stay_party_members" ADD CONSTRAINT "stay_party_members_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."room_assignments" ADD CONSTRAINT "room_assignments_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."stays" ADD CONSTRAINT "stays_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."room_assignments" ADD CONSTRAINT "room_assignments_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."room_assignments" ADD CONSTRAINT "room_assignments_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."reservation_references" ADD CONSTRAINT "reservation_references_instance_fk" FOREIGN KEY ("integration_instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guests" ADD CONSTRAINT "guests_merged_into_fk" FOREIGN KEY ("merged_into_guest_id") REFERENCES "guest"."guests"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."room_assignments" ADD CONSTRAINT "room_assignments_period_ck" CHECK ("unassigned_at" IS NULL OR "unassigned_at" >= "assigned_at");
--> statement-breakpoint
ALTER TABLE "guest"."stay_party_members" ADD CONSTRAINT "stay_party_members_period_ck" CHECK ("left_at" IS NULL OR "left_at" >= "joined_at");
--> statement-breakpoint
ALTER TABLE "guest"."guests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guests" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."guest_identifiers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guest_identifiers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guest_identifiers" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."stays" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."stays" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."stays" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."reservation_references" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."reservation_references" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."reservation_references" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."stay_party_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."stay_party_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."stay_party_members" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."room_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."room_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."room_assignments" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
