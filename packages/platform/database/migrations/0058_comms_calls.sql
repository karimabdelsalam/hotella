CREATE TYPE "comms"."call_status" AS ENUM('ANSWERED', 'TRANSFERRED', 'ENDED');--> statement-breakpoint
CREATE TABLE "comms"."calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider_call_id" varchar(64) NOT NULL,
	"from_identity_id" uuid,
	"conversation_id" uuid,
	"stay_id" uuid,
	"status" "comms"."call_status" NOT NULL,
	"transfer_reason" varchar(32),
	"transfer_extension" varchar(16),
	"started_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"transferred_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_s" integer,
	"resume_reply" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "calls_provider_uq" UNIQUE("channel_id","provider_call_id")
);
--> statement-breakpoint
ALTER TABLE "comms"."calls" ADD CONSTRAINT "calls_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "comms"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."calls" ADD CONSTRAINT "calls_from_identity_id_channel_identities_id_fk" FOREIGN KEY ("from_identity_id") REFERENCES "comms"."channel_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "comms"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_property_idx" ON "comms"."calls" USING btree ("tenant_id","property_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_live_conversation_uq" ON "comms"."calls" USING btree ("conversation_id") WHERE "comms"."calls"."status" = 'ANSWERED' AND "comms"."calls"."conversation_id" IS NOT NULL;;--> statement-breakpoint
ALTER TABLE "comms"."calls" ADD CONSTRAINT "calls_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "comms"."calls" ADD CONSTRAINT "calls_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "comms"."calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comms"."calls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."calls" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
