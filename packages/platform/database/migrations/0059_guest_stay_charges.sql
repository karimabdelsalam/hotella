ALTER TYPE "ai"."twin_kind" ADD VALUE 'POS_CHECK';--> statement-breakpoint
ALTER TYPE "integration"."mapping_type" ADD VALUE 'OUTLET';--> statement-breakpoint
CREATE TABLE "guest"."stay_charges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"room_id" uuid,
	"source_event_id" uuid NOT NULL,
	"outlet_category" varchar(16) NOT NULL,
	"settlement" varchar(16) NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"covers" integer,
	"closed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stay_charges_source_uq" UNIQUE("tenant_id","source_event_id")
);
--> statement-breakpoint
ALTER TABLE "guest"."stay_charges" ADD CONSTRAINT "stay_charges_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stay_charges_stay_idx" ON "guest"."stay_charges" USING btree ("tenant_id","stay_id","closed_at");;--> statement-breakpoint
ALTER TABLE "guest"."stay_charges" ADD CONSTRAINT "stay_charges_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "guest"."stay_charges" ADD CONSTRAINT "stay_charges_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "guest"."stay_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "guest"."stay_charges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."stay_charges" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
