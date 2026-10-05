CREATE TYPE "iam"."device_platform" AS ENUM('ANDROID', 'IOS');--> statement-breakpoint
CREATE TABLE "iam"."staff_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"platform" "iam"."device_platform" NOT NULL,
	"push_token" text NOT NULL,
	"app_version" varchar(32),
	"locale" varchar(10),
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(32)
);
--> statement-breakpoint
ALTER TABLE "iam"."staff_devices" ADD CONSTRAINT "staff_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."staff_devices" ADD CONSTRAINT "staff_devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "iam"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_devices_user_idx" ON "iam"."staff_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_devices_session_idx" ON "iam"."staff_devices" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_devices_token_live_uq" ON "iam"."staff_devices" USING btree ("tenant_id","push_token") WHERE "iam"."staff_devices"."revoked_at" IS NULL;--> statement-breakpoint
-- Hand-written (reviewed): the tenant reference (contexts never import org's schema module) and tenant isolation.
ALTER TABLE "iam"."staff_devices" ADD CONSTRAINT "staff_devices_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "iam"."staff_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."staff_devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."staff_devices" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
