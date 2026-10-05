CREATE TABLE "ai"."quality_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"agent_code" varchar(64) NOT NULL,
	"agent_version_id" uuid,
	"day" date NOT NULL,
	"metric" varchar(48) NOT NULL,
	"value" numeric(14, 4) NOT NULL,
	"samples" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_daily_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","property_id","agent_code","agent_version_id","day","metric")
);
--> statement-breakpoint
ALTER TABLE "ai"."quality_daily" ADD CONSTRAINT "quality_daily_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."quality_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."quality_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."quality_daily" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
