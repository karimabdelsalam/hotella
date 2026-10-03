CREATE TYPE "comms"."ai_mode" AS ENUM('OFF', 'ASSIST', 'AUTO');--> statement-breakpoint
CREATE TYPE "comms"."conversation_status" AS ENUM('OPEN', 'WAITING_GUEST', 'WAITING_STAFF', 'HANDED_OFF', 'CLOSED');--> statement-breakpoint
CREATE TYPE "comms"."conversation_subject" AS ENUM('GUEST', 'STAFF_INTERNAL');--> statement-breakpoint
CREATE TYPE "comms"."delivery_status" AS ENUM('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');--> statement-breakpoint
CREATE TYPE "comms"."inbound_status" AS ENUM('RECEIVED', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "comms"."message_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "comms"."message_type" AS ENUM('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'INTERACTIVE', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "comms"."participant_type" AS ENUM('GUEST', 'STAFF', 'AI', 'SYSTEM', 'EXTERNAL');--> statement-breakpoint
CREATE TABLE "comms"."conversation_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"participant_type" "comms"."participant_type" NOT NULL,
	"participant_ref" varchar(64),
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comms"."conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"subject_type" "comms"."conversation_subject" DEFAULT 'GUEST' NOT NULL,
	"guest_id" uuid,
	"stay_id" uuid,
	"channel_identity_id" uuid,
	"reply_channel_id" uuid,
	"reply_channel_type" "comms"."channel_type" NOT NULL,
	"status" "comms"."conversation_status" DEFAULT 'WAITING_STAFF' NOT NULL,
	"assigned_user_id" uuid,
	"ai_mode" "comms"."ai_mode" DEFAULT 'OFF' NOT NULL,
	"handoff_reason" varchar(200),
	"last_message_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"activation_prompted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms"."inbound_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider_event_id" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" "comms"."inbound_status" DEFAULT 'RECEIVED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"error_code" varchar(32),
	CONSTRAINT "inbound_events_provider_uq" UNIQUE("channel_id","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "comms"."message_delivery_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"status" "comms"."delivery_status" NOT NULL,
	"error_code" varchar(32),
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms"."messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid,
	"channel_type" "comms"."channel_type" NOT NULL,
	"direction" "comms"."message_direction" NOT NULL,
	"sender_participant_id" uuid,
	"sender_type" "comms"."participant_type" NOT NULL,
	"sender_ref" varchar(64),
	"type" "comms"."message_type" NOT NULL,
	"body" text,
	"media_ref" varchar(256),
	"media_asset_id" uuid,
	"locale_detected" varchar(16),
	"provider_message_id" varchar(160),
	"reply_to_message_id" uuid,
	"delivery_status" "comms"."delivery_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_code" varchar(32),
	"guest_visible" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comms"."conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "comms"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."conversations" ADD CONSTRAINT "conversations_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "comms"."channel_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."conversations" ADD CONSTRAINT "conversations_reply_channel_id_channels_id_fk" FOREIGN KEY ("reply_channel_id") REFERENCES "comms"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."inbound_events" ADD CONSTRAINT "inbound_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "comms"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."message_delivery_events" ADD CONSTRAINT "message_delivery_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "comms"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "comms"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "comms"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms"."messages" ADD CONSTRAINT "messages_sender_participant_id_conversation_participants_id_fk" FOREIGN KEY ("sender_participant_id") REFERENCES "comms"."conversation_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_participants_conversation_idx" ON "comms"."conversation_participants" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_stay_uq" ON "comms"."conversations" USING btree ("stay_id") WHERE "comms"."conversations"."status" <> 'CLOSED' AND "comms"."conversations"."stay_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_open_identity_uq" ON "comms"."conversations" USING btree ("channel_identity_id") WHERE "comms"."conversations"."status" <> 'CLOSED' AND "comms"."conversations"."stay_id" IS NULL;--> statement-breakpoint
CREATE INDEX "conversations_inbox_idx" ON "comms"."conversations" USING btree ("tenant_id","property_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "inbound_events_pending_idx" ON "comms"."inbound_events" USING btree ("received_at") WHERE "comms"."inbound_events"."status" = 'RECEIVED';--> statement-breakpoint
CREATE INDEX "message_delivery_events_message_idx" ON "comms"."message_delivery_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "comms"."messages" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_uq" ON "comms"."messages" USING btree ("channel_id","provider_message_id") WHERE "comms"."messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_outbox_idx" ON "comms"."messages" USING btree ("next_attempt_at") WHERE "comms"."messages"."delivery_status" = 'QUEUED';--> statement-breakpoint
-- Hand-written (reviewed): tenant/property/guest/stay integrity, append-only message history and row-level security.
ALTER TABLE "comms"."inbound_events" ADD CONSTRAINT "inbound_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."conversations" ADD CONSTRAINT "conversations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."conversation_participants" ADD CONSTRAINT "conversation_participants_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."messages" ADD CONSTRAINT "messages_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."message_delivery_events" ADD CONSTRAINT "message_delivery_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."inbound_events" ADD CONSTRAINT "inbound_events_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."conversations" ADD CONSTRAINT "conversations_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."conversations" ADD CONSTRAINT "conversations_guest_fk" FOREIGN KEY ("guest_id") REFERENCES "guest"."guests"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."conversations" ADD CONSTRAINT "conversations_stay_fk" FOREIGN KEY ("stay_id") REFERENCES "guest"."stays"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."messages" ADD CONSTRAINT "messages_reply_to_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "comms"."messages"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE FUNCTION "comms"."messages_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Conversation history (CLAUDE.md rule 10): never deleted; only delivery fields move, and the text/media of a
  -- message may be cleared when its guest is anonymized (Spec §69).
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'comms.messages is append-only';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.conversation_id, NEW.channel_type, NEW.direction, NEW.sender_type, NEW.sender_ref,
      NEW.type, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.conversation_id, OLD.channel_type, OLD.direction, OLD.sender_type, OLD.sender_ref,
      OLD.type, OLD.created_at)
     OR (NEW.body IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body)
     OR (NEW.media_ref IS NOT NULL AND NEW.media_ref IS DISTINCT FROM OLD.media_ref) THEN
    RAISE EXCEPTION 'comms.messages is append-only';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "messages_append_only" BEFORE UPDATE OR DELETE ON "comms"."messages" FOR EACH ROW EXECUTE FUNCTION "comms"."messages_append_only"();
--> statement-breakpoint
ALTER TABLE "comms"."inbound_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."inbound_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."inbound_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."conversations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."conversation_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."conversation_participants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."conversation_participants" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."messages" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "comms"."message_delivery_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."message_delivery_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."message_delivery_events" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
