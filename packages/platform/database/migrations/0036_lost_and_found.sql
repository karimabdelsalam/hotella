CREATE SCHEMA "lostfound";
--> statement-breakpoint
CREATE TYPE "lostfound"."colour" AS ENUM('BLACK', 'WHITE', 'GREY', 'SILVER', 'GOLD', 'RED', 'PINK', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE', 'BROWN', 'BEIGE', 'MULTI');--> statement-breakpoint
CREATE TYPE "lostfound"."disposal_method" AS ENUM('DONATED', 'DESTROYED', 'HANDED_TO_AUTHORITIES', 'GIVEN_TO_FINDER');--> statement-breakpoint
CREATE TYPE "lostfound"."handover" AS ENUM('IN_PERSON', 'COURIER', 'REPRESENTATIVE');--> statement-breakpoint
CREATE TYPE "lostfound"."id_document" AS ENUM('PASSPORT', 'NATIONAL_ID', 'DRIVING_LICENCE', 'ROOM_KEY_AND_PMS', 'OTHER');--> statement-breakpoint
CREATE TYPE "lostfound"."item_category" AS ENUM('ELECTRONICS', 'PHONE', 'JEWELLERY', 'WATCH', 'CLOTHING', 'BAG', 'DOCUMENT', 'MONEY', 'KEYS', 'GLASSES', 'TOILETRIES', 'TOY', 'OTHER');--> statement-breakpoint
CREATE TYPE "lostfound"."item_kind" AS ENUM('FOUND', 'LOST');--> statement-breakpoint
CREATE TYPE "lostfound"."item_status" AS ENUM('REGISTERED', 'MATCHED', 'CLAIMED', 'RELEASED', 'DISPOSED');--> statement-breakpoint
CREATE TYPE "lostfound"."match_status" AS ENUM('PROPOSED', 'CONFIRMED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "lostfound"."ai_metadata" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"object_type" varchar(80),
	"colours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brand" varchar(60),
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_call_id" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lostfound"."claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"claimant_guest_id" uuid,
	"claimant_name" varchar(160) NOT NULL,
	"id_document" "lostfound"."id_document" NOT NULL,
	"verification_note" text NOT NULL,
	"handover" "lostfound"."handover" NOT NULL,
	"released_by_id" uuid,
	"released_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lostfound"."item_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"event" varchar(32) NOT NULL,
	"from_status" "lostfound"."item_status",
	"to_status" "lostfound"."item_status",
	"note" text,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "lostfound"."items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" "lostfound"."item_kind" NOT NULL,
	"category" "lostfound"."item_category" NOT NULL,
	"colour" "lostfound"."colour",
	"brand" varchar(60),
	"description" text NOT NULL,
	"location_id" uuid,
	"place_note" varchar(200),
	"occurred_at" timestamp with time zone NOT NULL,
	"guest_id" uuid,
	"stay_id" uuid,
	"storage_location" varchar(120),
	"photo_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"valuable" boolean DEFAULT false NOT NULL,
	"status" "lostfound"."item_status" DEFAULT 'REGISTERED' NOT NULL,
	"retention_until" date,
	"disposal_method" "lostfound"."disposal_method",
	"closed_at" timestamp with time zone,
	"reported_by_type" varchar(16) NOT NULL,
	"reported_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lostfound"."match_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"found_item_id" uuid NOT NULL,
	"lost_item_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"source" varchar(8) DEFAULT 'RULES' NOT NULL,
	"status" "lostfound"."match_status" DEFAULT 'PROPOSED' NOT NULL,
	"decided_by_type" varchar(16),
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lostfound"."ai_metadata" ADD CONSTRAINT "ai_metadata_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "lostfound"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lostfound"."claims" ADD CONSTRAINT "claims_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "lostfound"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lostfound"."item_history" ADD CONSTRAINT "item_history_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "lostfound"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lostfound"."match_candidates" ADD CONSTRAINT "match_candidates_found_item_id_items_id_fk" FOREIGN KEY ("found_item_id") REFERENCES "lostfound"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lostfound"."match_candidates" ADD CONSTRAINT "match_candidates_lost_item_id_items_id_fk" FOREIGN KEY ("lost_item_id") REFERENCES "lostfound"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_metadata_item_uq" ON "lostfound"."ai_metadata" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_item_uq" ON "lostfound"."claims" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_history_idx" ON "lostfound"."item_history" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_number_uq" ON "lostfound"."items" USING btree ("property_id","number");--> statement-breakpoint
CREATE INDEX "items_open_idx" ON "lostfound"."items" USING btree ("tenant_id","property_id","kind","status");--> statement-breakpoint
CREATE INDEX "items_stay_idx" ON "lostfound"."items" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_candidates_pair_uq" ON "lostfound"."match_candidates" USING btree ("found_item_id","lost_item_id");--> statement-breakpoint
CREATE INDEX "match_candidates_open_idx" ON "lostfound"."match_candidates" USING btree ("tenant_id","property_id") WHERE status = 'PROPOSED';
--> statement-breakpoint
ALTER TABLE "lostfound"."items" ADD CONSTRAINT "items_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."item_history" ADD CONSTRAINT "item_history_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."ai_metadata" ADD CONSTRAINT "ai_metadata_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."match_candidates" ADD CONSTRAINT "match_candidates_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."claims" ADD CONSTRAINT "claims_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."items" ADD CONSTRAINT "items_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."match_candidates" ADD CONSTRAINT "match_candidates_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."claims" ADD CONSTRAINT "claims_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "lostfound"."items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lostfound"."items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lostfound"."items" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "lostfound"."item_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lostfound"."item_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lostfound"."item_history" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "lostfound"."ai_metadata" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lostfound"."ai_metadata" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lostfound"."ai_metadata" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "lostfound"."match_candidates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lostfound"."match_candidates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lostfound"."match_candidates" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "lostfound"."claims" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "lostfound"."claims" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lostfound"."claims" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
CREATE FUNCTION "lostfound"."append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An item's history and its claim record are kept exactly as recorded (rule 10, Spec §13 audited release).
  RAISE EXCEPTION 'lostfound.% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "item_history_append_only" BEFORE UPDATE OR DELETE ON "lostfound"."item_history" FOR EACH ROW EXECUTE FUNCTION "lostfound"."append_only"();
--> statement-breakpoint
CREATE TRIGGER "claims_append_only" BEFORE UPDATE OR DELETE ON "lostfound"."claims" FOR EACH ROW EXECUTE FUNCTION "lostfound"."append_only"();
--> statement-breakpoint
CREATE FUNCTION "lostfound"."keep_description"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- What the finder or the guest wrote is never overwritten (Spec §13); AI attributes live in ai_metadata.
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'lostfound.items.description is never overwritten';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "items_keep_description" BEFORE UPDATE ON "lostfound"."items" FOR EACH ROW EXECUTE FUNCTION "lostfound"."keep_description"();
