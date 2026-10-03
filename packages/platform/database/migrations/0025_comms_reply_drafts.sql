CREATE TYPE "comms"."draft_status" AS ENUM('PENDING', 'USED', 'DISCARDED', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE "comms"."reply_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_code" varchar(64) NOT NULL,
	"execution_id" uuid,
	"body" text,
	"status" "comms"."draft_status" DEFAULT 'PENDING' NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_id" uuid,
	"edit_distance" integer,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comms"."reply_drafts" ADD CONSTRAINT "reply_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "comms"."conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reply_drafts_pending_uq" ON "comms"."reply_drafts" USING btree ("conversation_id") WHERE "comms"."reply_drafts"."status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "comms"."reply_drafts" ADD CONSTRAINT "reply_drafts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."reply_drafts" ADD CONSTRAINT "reply_drafts_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "comms"."reply_drafts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "comms"."reply_drafts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comms"."reply_drafts" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
