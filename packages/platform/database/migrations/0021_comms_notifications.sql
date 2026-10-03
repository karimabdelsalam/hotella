ALTER TABLE "comms"."messages" ADD COLUMN "recipient_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "comms"."messages" ADD COLUMN "template" jsonb;--> statement-breakpoint
ALTER TABLE "comms"."messages" ADD CONSTRAINT "messages_recipient_identity_fk" FOREIGN KEY ("recipient_identity_id") REFERENCES "comms"."channel_identities"("id") ON DELETE set null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "comms"."messages_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Conversation history (CLAUDE.md rule 10): never deleted; only delivery fields move, and the text/media of a
  -- message may be cleared when its guest is anonymized (Spec §69). A notification's template may be cleared the same
  -- way, and its recipient becomes NULL when that channel identity is removed (anonymization).
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'comms.messages is append-only';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.conversation_id, NEW.channel_type, NEW.direction, NEW.sender_type, NEW.sender_ref,
      NEW.type, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.conversation_id, OLD.channel_type, OLD.direction, OLD.sender_type, OLD.sender_ref,
      OLD.type, OLD.created_at)
     OR (NEW.body IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body)
     OR (NEW.media_ref IS NOT NULL AND NEW.media_ref IS DISTINCT FROM OLD.media_ref)
     OR (NEW.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
     OR (NEW.recipient_identity_id IS NOT NULL AND NEW.recipient_identity_id IS DISTINCT FROM OLD.recipient_identity_id) THEN
    RAISE EXCEPTION 'comms.messages is append-only';
  END IF;
  RETURN NEW;
END $$;
