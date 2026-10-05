CREATE TYPE "comms"."voice_extension_kind" AS ENUM('ROOM', 'PUBLIC', 'STAFF', 'OPERATOR');--> statement-breakpoint
CREATE TABLE "comms"."voice_extensions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"extension" varchar(16) NOT NULL,
	"kind" "comms"."voice_extension_kind" NOT NULL,
	"room_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "voice_extensions_channel_uq" UNIQUE("channel_id","extension")
);
--> statement-breakpoint
ALTER TABLE "comms"."calls" ADD COLUMN "caller_kind" varchar(16) DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE "comms"."voice_extensions" ADD CONSTRAINT "voice_extensions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "comms"."channels"("id") ON DELETE no action ON UPDATE no action;;--> statement-breakpoint
ALTER TABLE "comms"."voice_extensions" ADD CONSTRAINT "voice_extensions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "comms"."voice_extensions" ADD CONSTRAINT "voice_extensions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "comms"."voice_extensions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comms"."voice_extensions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."voice_extensions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
