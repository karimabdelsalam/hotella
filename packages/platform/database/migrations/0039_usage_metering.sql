CREATE TABLE "license"."limit_notices" (
	"tenant_id" uuid NOT NULL,
	"property_key" uuid NOT NULL,
	"metric_code" varchar(64) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"enforcement" "license"."enforcement" NOT NULL,
	"limit_value" bigint NOT NULL,
	"used" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_notices_pk" PRIMARY KEY("tenant_id","property_key","metric_code","period_start")
);
--> statement-breakpoint
ALTER TABLE "license"."limit_notices" ADD CONSTRAINT "limit_notices_metric_code_metrics_code_fk" FOREIGN KEY ("metric_code") REFERENCES "license"."metrics"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Hand-written (reviewed): tenant integrity, append-only notices and row-level security as in migration 0006.
ALTER TABLE "license"."limit_notices" ADD CONSTRAINT "limit_notices_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE TRIGGER "limit_notices_append_only" BEFORE UPDATE OR DELETE ON "license"."limit_notices" FOR EACH ROW EXECUTE FUNCTION "license"."append_only"();
--> statement-breakpoint
ALTER TABLE "license"."limit_notices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "license"."limit_notices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "license"."limit_notices" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
