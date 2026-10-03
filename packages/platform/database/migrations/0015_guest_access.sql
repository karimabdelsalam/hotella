CREATE TYPE "guest"."grant_event_kind" AS ENUM('GRANTED', 'WIDENED', 'NARROWED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "guest"."grant_via" AS ENUM('ACTIVATION', 'QR', 'STAFF', 'PRE_ARRIVAL');--> statement-breakpoint
CREATE TABLE "guest"."guest_access_grant_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" "guest"."grant_event_kind" NOT NULL,
	"scopes" text[] NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"reason" varchar(32) NOT NULL,
	"changed_by_type" varchar(16) NOT NULL,
	"changed_by_id" varchar(64),
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest"."guest_access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"stay_id" uuid,
	"party_role" "guest"."party_role" NOT NULL,
	"scopes" text[] NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(32),
	"granted_via" "guest"."grant_via" NOT NULL,
	"granted_by_type" varchar(16) NOT NULL,
	"granted_by_id" varchar(64),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest"."guest_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"session_token_hash" varchar(64) NOT NULL,
	"device_info" varchar(200),
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(32)
);
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grant_events" ADD CONSTRAINT "guest_access_grant_events_grant_id_guest_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "guest"."guest_access_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grants" ADD CONSTRAINT "guest_access_grants_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grants" ADD CONSTRAINT "guest_access_grants_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest"."guest_sessions" ADD CONSTRAINT "guest_sessions_grant_id_guest_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "guest"."guest_access_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_access_grant_events_grant_idx" ON "guest"."guest_access_grant_events" USING btree ("grant_id","at");--> statement-breakpoint
CREATE INDEX "guest_access_grants_stay_idx" ON "guest"."guest_access_grants" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE INDEX "guest_access_grants_guest_idx" ON "guest"."guest_access_grants" USING btree ("tenant_id","guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_sessions_token_uq" ON "guest"."guest_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "guest_sessions_grant_idx" ON "guest"."guest_sessions" USING btree ("grant_id");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity, validity and session sanity, append-only grant history
-- (CLAUDE.md rule 10) and row-level security as in migration 0006.
ALTER TABLE "guest"."guest_access_grants" ADD CONSTRAINT "guest_access_grants_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grant_events" ADD CONSTRAINT "guest_access_grant_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_sessions" ADD CONSTRAINT "guest_sessions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grants" ADD CONSTRAINT "guest_access_grants_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grants" ADD CONSTRAINT "guest_access_grants_validity_ck" CHECK ("valid_until" > "valid_from");
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grants" ADD CONSTRAINT "guest_access_grants_revoked_ck" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));
--> statement-breakpoint
ALTER TABLE "guest"."guest_sessions" ADD CONSTRAINT "guest_sessions_revoked_ck" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL));
--> statement-breakpoint
CREATE FUNCTION "guest"."guest_access_grant_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Access history (CLAUDE.md rule 10) is never rewritten or deleted; it holds no personal data.
  RAISE EXCEPTION 'guest.guest_access_grant_events is append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER "guest_access_grant_events_append_only" BEFORE UPDATE OR DELETE ON "guest"."guest_access_grant_events" FOR EACH ROW EXECUTE FUNCTION "guest"."guest_access_grant_events_append_only"();
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guest_access_grants" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grant_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guest_access_grant_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guest_access_grant_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "guest"."guest_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "guest"."guest_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guest"."guest_sessions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
