CREATE TABLE "integration"."profile_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"profile_code" varchar(64) NOT NULL,
	"profile_version" integer NOT NULL,
	"record" varchar(8) NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_mandatory" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_observations_record_uq" UNIQUE("instance_id","profile_code","record")
);
--> statement-breakpoint
ALTER TABLE "integration"."profile_observations" ADD CONSTRAINT "profile_observations_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity and row-level security as in migration 0006. Field ids and
-- counts only, never values.
ALTER TABLE "integration"."profile_observations" ADD CONSTRAINT "profile_observations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."profile_observations" ADD CONSTRAINT "profile_observations_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."profile_observations" ADD CONSTRAINT "profile_observations_counts_ck" CHECK ("received" >= 0 AND "missing_mandatory" >= 0 AND "missing_mandatory" <= "received");
--> statement-breakpoint
ALTER TABLE "integration"."profile_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."profile_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."profile_observations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
