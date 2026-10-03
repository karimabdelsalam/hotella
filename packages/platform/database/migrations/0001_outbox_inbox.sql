CREATE TABLE "platform"."inbox" (
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_event_id_consumer_pk" PRIMARY KEY("event_id","consumer")
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"tenant_id" uuid,
	"property_id" uuid,
	"aggregate_type" text,
	"aggregate_id" text,
	"delivery_queue" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"correlation_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "platform"."outbox" USING btree ("available_at","created_at") WHERE "platform"."outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "platform"."outbox" USING btree ("aggregate_type","aggregate_id");