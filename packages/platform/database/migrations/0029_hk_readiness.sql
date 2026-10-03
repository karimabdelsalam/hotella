ALTER TABLE "hk"."room_states" ADD COLUMN "ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hk"."room_states" ADD COLUMN "ready_since" timestamp with time zone;