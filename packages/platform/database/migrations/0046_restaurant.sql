CREATE SCHEMA "restaurant";
--> statement-breakpoint
CREATE TYPE "restaurant"."reservation_channel" AS ENUM('GUEST_APP', 'STAFF', 'AI');--> statement-breakpoint
CREATE TYPE "restaurant"."reservation_status" AS ENUM('CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "restaurant"."restaurant_status" AS ENUM('DRAFT', 'ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "restaurant"."closures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"sitting_id" uuid,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restaurant"."reservation_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"from_status" "restaurant"."reservation_status",
	"to_status" "restaurant"."reservation_status" NOT NULL,
	"reason" text,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "restaurant"."reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"sitting_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"starts_at" varchar(5) NOT NULL,
	"party_size" smallint NOT NULL,
	"stay_id" uuid NOT NULL,
	"guest_id" uuid,
	"room_number" varchar(16),
	"status" "restaurant"."reservation_status" DEFAULT 'CONFIRMED' NOT NULL,
	"channel" "restaurant"."reservation_channel" NOT NULL,
	"notes" text,
	"override_reason" text,
	"cancel_reason" text,
	"created_by_type" varchar(16) NOT NULL,
	"created_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "reservations_party_ck" CHECK ("restaurant"."reservations"."party_size" >= 1)
);
--> statement-breakpoint
CREATE TABLE "restaurant"."restaurant_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"dress_code" text,
	CONSTRAINT "restaurant_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "restaurant"."restaurants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"status" "restaurant"."restaurant_status" DEFAULT 'DRAFT' NOT NULL,
	"min_party" smallint DEFAULT 1 NOT NULL,
	"max_party" smallint DEFAULT 8 NOT NULL,
	"book_days_ahead" smallint DEFAULT 7 NOT NULL,
	"guest_cutoff_minutes" integer DEFAULT 120 NOT NULL,
	"allowance_applies" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "restaurants_party_ck" CHECK ("restaurant"."restaurants"."min_party" >= 1 and "restaurant"."restaurants"."max_party" >= "restaurant"."restaurants"."min_party")
);
--> statement-breakpoint
CREATE TABLE "restaurant"."sitting_loads" (
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"sitting_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"covers" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sitting_loads_pk" PRIMARY KEY("sitting_id","service_date"),
	CONSTRAINT "sitting_loads_covers_ck" CHECK ("restaurant"."sitting_loads"."covers" >= 0)
);
--> statement-breakpoint
CREATE TABLE "restaurant"."sittings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"starts_at" varchar(5) NOT NULL,
	"seats" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "sittings_weekday_ck" CHECK ("restaurant"."sittings"."weekday" between 0 and 6),
	CONSTRAINT "sittings_seats_ck" CHECK ("restaurant"."sittings"."seats" >= 1),
	CONSTRAINT "sittings_time_ck" CHECK ("restaurant"."sittings"."starts_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
ALTER TABLE "restaurant"."closures" ADD CONSTRAINT "closures_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant"."closures" ADD CONSTRAINT "closures_sitting_id_sittings_id_fk" FOREIGN KEY ("sitting_id") REFERENCES "restaurant"."sittings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant"."reservation_transitions" ADD CONSTRAINT "reservation_transitions_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "restaurant"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant"."reservations" ADD CONSTRAINT "reservations_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant"."reservations" ADD CONSTRAINT "reservations_sitting_id_sittings_id_fk" FOREIGN KEY ("sitting_id") REFERENCES "restaurant"."sittings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant"."restaurant_translations" ADD CONSTRAINT "restaurant_translations_entity_id_restaurants_id_fk" FOREIGN KEY ("entity_id") REFERENCES "restaurant"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant"."sitting_loads" ADD CONSTRAINT "sitting_loads_sitting_id_sittings_id_fk" FOREIGN KEY ("sitting_id") REFERENCES "restaurant"."sittings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant"."sittings" ADD CONSTRAINT "sittings_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "restaurant"."restaurants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "closures_restaurant_idx" ON "restaurant"."closures" USING btree ("restaurant_id","on_date");--> statement-breakpoint
CREATE INDEX "reservation_transitions_idx" ON "restaurant"."reservation_transitions" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reservations_day_idx" ON "restaurant"."reservations" USING btree ("tenant_id","property_id","service_date");--> statement-breakpoint
CREATE INDEX "reservations_stay_idx" ON "restaurant"."reservations" USING btree ("tenant_id","stay_id","restaurant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "restaurants_code_uq" ON "restaurant"."restaurants" USING btree ("tenant_id","property_id","code");--> statement-breakpoint
CREATE INDEX "sittings_restaurant_idx" ON "restaurant"."sittings" USING btree ("restaurant_id","weekday");
--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, row-level security as in migration 0006, and append-only
-- reservation transitions (rule 10). Translations follow their restaurant (cascade) and carry no tenant of their own.
ALTER TABLE "restaurant"."restaurants" ADD CONSTRAINT "restaurants_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."restaurants" ADD CONSTRAINT "restaurants_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."sittings" ADD CONSTRAINT "sittings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."sittings" ADD CONSTRAINT "sittings_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."closures" ADD CONSTRAINT "closures_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."closures" ADD CONSTRAINT "closures_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."sitting_loads" ADD CONSTRAINT "sitting_loads_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."sitting_loads" ADD CONSTRAINT "sitting_loads_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."reservations" ADD CONSTRAINT "reservations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."reservations" ADD CONSTRAINT "reservations_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."reservation_transitions" ADD CONSTRAINT "reservation_transitions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "restaurant"."reservation_transitions" ADD CONSTRAINT "reservation_transitions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE TRIGGER "reservation_transitions_no_update" BEFORE UPDATE OR DELETE ON "restaurant"."reservation_transitions" FOR EACH ROW EXECUTE FUNCTION "platform"."reject_history_mutation"();
--> statement-breakpoint
ALTER TABLE "restaurant"."restaurants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "restaurant"."restaurants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restaurant"."restaurants" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "restaurant"."sittings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "restaurant"."sittings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restaurant"."sittings" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "restaurant"."closures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "restaurant"."closures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restaurant"."closures" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "restaurant"."sitting_loads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "restaurant"."sitting_loads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restaurant"."sitting_loads" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "restaurant"."reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "restaurant"."reservations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restaurant"."reservations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "restaurant"."reservation_transitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "restaurant"."reservation_transitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "restaurant"."reservation_transitions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
