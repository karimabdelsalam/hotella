CREATE TYPE "comms"."otp_channel" AS ENUM('WHATSAPP', 'SMS', 'VOICE', 'STAFF');--> statement-breakpoint
CREATE TYPE "comms"."qr_status" AS ENUM('ACTIVE', 'ROTATED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "comms"."verification_delivery_status" AS ENUM('SENT', 'DELIVERED', 'READ', 'FAILED');--> statement-breakpoint
CREATE TYPE "comms"."verification_trigger" AS ENUM('INITIAL', 'AUTO_FALLBACK', 'MANUAL_FALLBACK', 'STAFF_ASSIST');--> statement-breakpoint
CREATE TABLE "comms"."activation_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"guest_id" uuid,
	"token_hash" varchar(64) NOT NULL,
	"purpose" varchar(32) DEFAULT 'GUEST_ACTIVATION' NOT NULL,
	"delivered_via" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_type" varchar(16) NOT NULL,
	"created_by_id" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "comms"."room_qr_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"status" "comms"."qr_status" DEFAULT 'ACTIVE' NOT NULL,
	"rotated_from_id" uuid,
	"status_changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comms"."verification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"channel" "comms"."otp_channel" NOT NULL,
	"channel_id" uuid,
	"provider_code" varchar(64),
	"trigger" "comms"."verification_trigger" NOT NULL,
	"status" "comms"."verification_delivery_status" NOT NULL,
	"provider_ref" varchar(128),
	"error_code" varchar(32),
	"sent_at" timestamp with time zone NOT NULL,
	"status_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms"."verification_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"room_id" uuid,
	"guest_id" uuid NOT NULL,
	"activation_token_id" uuid,
	"room_qr_code_id" uuid,
	"phone_normalized" varchar(20) NOT NULL,
	"otp_seed" varchar(64) NOT NULL,
	"handle_hash" varchar(64) NOT NULL,
	"locale" varchar(16) NOT NULL,
	"reference" varchar(8) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_via" "comms"."otp_channel",
	"locked_at" timestamp with time zone,
	"assisted_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comms"."verification_deliveries" ADD CONSTRAINT "verification_deliveries_session_id_verification_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "comms"."verification_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."verification_deliveries" ADD CONSTRAINT "verification_deliveries_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "comms"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_activation_token_id_activation_tokens_id_fk" FOREIGN KEY ("activation_token_id") REFERENCES "comms"."activation_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_tokens_hash_uq" ON "comms"."activation_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "activation_tokens_stay_idx" ON "comms"."activation_tokens" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_qr_codes_hash_uq" ON "comms"."room_qr_codes" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "room_qr_codes_active_uq" ON "comms"."room_qr_codes" USING btree ("room_id") WHERE "comms"."room_qr_codes"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "room_qr_codes_property_idx" ON "comms"."room_qr_codes" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "verification_deliveries_session_idx" ON "comms"."verification_deliveries" USING btree ("session_id","sent_at");--> statement-breakpoint
CREATE INDEX "verification_deliveries_provider_idx" ON "comms"."verification_deliveries" USING btree ("channel_id","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_sessions_handle_uq" ON "comms"."verification_sessions" USING btree ("handle_hash");--> statement-breakpoint
CREATE INDEX "verification_sessions_phone_idx" ON "comms"."verification_sessions" USING btree ("tenant_id","phone_normalized","created_at");--> statement-breakpoint
CREATE INDEX "verification_sessions_open_idx" ON "comms"."verification_sessions" USING btree ("expires_at") WHERE "comms"."verification_sessions"."verified_at" IS NULL AND "comms"."verification_sessions"."locked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "verification_sessions_reference_idx" ON "comms"."verification_sessions" USING btree ("property_id","reference");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property/stay/guest/room integrity, counters and row-level security as in 0006.
ALTER TABLE "comms"."activation_tokens" ADD CONSTRAINT "activation_tokens_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_deliveries" ADD CONSTRAINT "verification_deliveries_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."room_qr_codes" ADD CONSTRAINT "room_qr_codes_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."activation_tokens" ADD CONSTRAINT "activation_tokens_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."room_qr_codes" ADD CONSTRAINT "room_qr_codes_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."activation_tokens" ADD CONSTRAINT "activation_tokens_stay_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."activation_tokens" ADD CONSTRAINT "activation_tokens_guest_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_stay_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_guest_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_qr_fk" FOREIGN KEY ("room_qr_code_id") REFERENCES "comms"."room_qr_codes"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_attempts_ck" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts");
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ADD CONSTRAINT "verification_sessions_origin_ck" CHECK (("activation_token_id" IS NULL) <> ("room_qr_code_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "comms"."room_qr_codes" ADD CONSTRAINT "room_qr_codes_room_fk" FOREIGN KEY ("room_id") REFERENCES "org"."rooms"("location_id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."room_qr_codes" ADD CONSTRAINT "room_qr_codes_rotated_from_fk" FOREIGN KEY ("rotated_from_id") REFERENCES "comms"."room_qr_codes"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."activation_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."activation_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."activation_tokens" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."verification_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."verification_sessions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."verification_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."verification_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."verification_deliveries" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."room_qr_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."room_qr_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."room_qr_codes" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
