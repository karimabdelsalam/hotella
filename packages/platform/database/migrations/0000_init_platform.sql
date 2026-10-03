CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TYPE "platform"."feature_flag_scope" AS ENUM('PLATFORM', 'TENANT', 'PROPERTY');--> statement-breakpoint
CREATE TABLE "platform"."feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" varchar(128) NOT NULL,
	"scope" "platform"."feature_flag_scope" DEFAULT 'PLATFORM' NOT NULL,
	"scope_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text,
	CONSTRAINT "feature_flags_key_scope_uq" UNIQUE NULLS NOT DISTINCT("key","scope","scope_id")
);
