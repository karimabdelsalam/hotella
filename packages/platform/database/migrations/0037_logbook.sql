CREATE SCHEMA "logbook";
--> statement-breakpoint
CREATE TYPE "logbook"."entry_kind" AS ENUM('NOTE', 'INCIDENT', 'HANDOVER_ITEM');--> statement-breakpoint
CREATE TYPE "logbook"."handover_source" AS ENUM('AI', 'WRITTEN');--> statement-breakpoint
CREATE TYPE "logbook"."handover_status" AS ENUM('DRAFT', 'ACKNOWLEDGED');--> statement-breakpoint
CREATE TYPE "logbook"."shift" AS ENUM('MORNING', 'EVENING', 'NIGHT');--> statement-breakpoint
CREATE TABLE "logbook"."entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"department_code" varchar(32) NOT NULL,
	"shift_date" date NOT NULL,
	"shift" "logbook"."shift" NOT NULL,
	"kind" "logbook"."entry_kind" NOT NULL,
	"text" text NOT NULL,
	"room_id" uuid,
	"corrects_entry_id" uuid,
	"author_type" varchar(16) NOT NULL,
	"author_id" uuid
);
--> statement-breakpoint
CREATE TABLE "logbook"."handovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"department_code" varchar(32) NOT NULL,
	"shift_date" date NOT NULL,
	"shift" "logbook"."shift" NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"facts" jsonb NOT NULL,
	"source" "logbook"."handover_source" NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"execution_id" uuid,
	"status" "logbook"."handover_status" DEFAULT 'DRAFT' NOT NULL,
	"drafted_by_type" varchar(16) NOT NULL,
	"drafted_by_id" uuid,
	"acknowledged_by_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledgement_note" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "entries_shift_idx" ON "logbook"."entries" USING btree ("tenant_id","property_id","department_code","shift_date","shift");--> statement-breakpoint
CREATE UNIQUE INDEX "handovers_shift_uq" ON "logbook"."handovers" USING btree ("property_id","department_code","shift_date","shift");
--> statement-breakpoint
ALTER TABLE "logbook"."entries" ADD CONSTRAINT "entries_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "logbook"."handovers" ADD CONSTRAINT "handovers_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "logbook"."entries" ADD CONSTRAINT "entries_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "logbook"."handovers" ADD CONSTRAINT "handovers_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "logbook"."entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "logbook"."entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "logbook"."entries" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "logbook"."handovers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "logbook"."handovers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "logbook"."handovers" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "logbook"."entries" ADD CONSTRAINT "entries_corrects_fk" FOREIGN KEY ("corrects_entry_id") REFERENCES "logbook"."entries"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE FUNCTION "logbook"."append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Logbook entries are kept as written; a correction is a new entry (Spec §14, rule 10).
  RAISE EXCEPTION 'logbook.% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "entries_append_only" BEFORE UPDATE OR DELETE ON "logbook"."entries" FOR EACH ROW EXECUTE FUNCTION "logbook"."append_only"();
--> statement-breakpoint
CREATE FUNCTION "logbook"."keep_acknowledged"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An acknowledged handover is the record of who took the shift over on what facts; it never changes.
  IF OLD.status = 'ACKNOWLEDGED' THEN
    RAISE EXCEPTION 'logbook.handovers: an acknowledged handover never changes';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "handovers_keep_acknowledged" BEFORE UPDATE OR DELETE ON "logbook"."handovers" FOR EACH ROW EXECUTE FUNCTION "logbook"."keep_acknowledged"();
