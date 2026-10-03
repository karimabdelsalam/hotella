CREATE SCHEMA "relations";
--> statement-breakpoint
CREATE TYPE "relations"."candidate_status" AS ENUM('PENDING', 'CONFIRMED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "relations"."complaint_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "relations"."complaint_source" AS ENUM('STAFF', 'GUEST_WEB', 'CHAT', 'AI_CANDIDATE', 'SURVEY');--> statement-breakpoint
CREATE TYPE "relations"."complaint_status" AS ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "relations"."complaint_evidence_kind" AS ENUM('MESSAGE', 'NOTE', 'PHOTO', 'AI_REASON');--> statement-breakpoint
CREATE TYPE "relations"."complaint_link_kind" AS ENUM('ROOM', 'SERVICE_REQUEST', 'TASK', 'ASSET', 'WORK_ORDER', 'USER');--> statement-breakpoint
CREATE TYPE "relations"."recovery_kind" AS ENUM('APOLOGY', 'AMENITY', 'MEAL', 'DISCOUNT', 'REFUND', 'ROOM_MOVE', 'OTHER');--> statement-breakpoint
CREATE TYPE "relations"."recovery_status" AS ENUM('DONE', 'PENDING_APPROVAL', 'REJECTED');--> statement-breakpoint
CREATE TABLE "relations"."complaint_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"stay_id" uuid,
	"guest_id" uuid,
	"conversation_id" uuid,
	"category_code" varchar(40) NOT NULL,
	"severity" "relations"."complaint_severity" NOT NULL,
	"confidence" real NOT NULL,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"guest_words" text,
	"execution_id" uuid,
	"status" "relations"."candidate_status" DEFAULT 'PENDING' NOT NULL,
	"decided_by_type" varchar(16),
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"complaint_id" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."complaint_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"default_severity" "relations"."complaint_severity" DEFAULT 'MEDIUM' NOT NULL,
	"department_code" varchar(32),
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."complaint_category_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "complaint_category_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "relations"."complaints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"guest_id" uuid,
	"stay_id" uuid,
	"category_id" uuid NOT NULL,
	"severity" "relations"."complaint_severity" NOT NULL,
	"status" "relations"."complaint_status" DEFAULT 'OPEN' NOT NULL,
	"source" "relations"."complaint_source" NOT NULL,
	"summary" text NOT NULL,
	"description" text,
	"detected_sentiment" varchar(16),
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"opened_by_type" varchar(16) NOT NULL,
	"opened_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."complaint_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"complaint_id" uuid NOT NULL,
	"kind" "relations"."complaint_evidence_kind" NOT NULL,
	"ref" varchar(200),
	"text" text,
	"added_by_type" varchar(16) NOT NULL,
	"added_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "relations"."complaint_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"complaint_id" uuid NOT NULL,
	"kind" "relations"."complaint_link_kind" NOT NULL,
	"ref" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."recovery_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"complaint_id" uuid NOT NULL,
	"kind" "relations"."recovery_kind" NOT NULL,
	"amount_minor" bigint,
	"currency" varchar(3),
	"note" text,
	"status" "relations"."recovery_status" NOT NULL,
	"approval_id" uuid,
	"created_by_type" varchar(16) NOT NULL,
	"created_by_id" uuid,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."complaint_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"complaint_id" uuid NOT NULL,
	"from_status" "relations"."complaint_status",
	"to_status" "relations"."complaint_status" NOT NULL,
	"note" text,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid
);
--> statement-breakpoint
ALTER TABLE "relations"."complaint_candidates" ADD CONSTRAINT "complaint_candidates_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "relations"."complaints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."complaint_category_translations" ADD CONSTRAINT "complaint_category_translations_entity_id_complaint_categories_id_fk" FOREIGN KEY ("entity_id") REFERENCES "relations"."complaint_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."complaints" ADD CONSTRAINT "complaints_category_id_complaint_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "relations"."complaint_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."complaint_evidence" ADD CONSTRAINT "complaint_evidence_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "relations"."complaints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."complaint_links" ADD CONSTRAINT "complaint_links_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "relations"."complaints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."recovery_actions" ADD CONSTRAINT "recovery_actions_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "relations"."complaints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."complaint_status_history" ADD CONSTRAINT "complaint_status_history_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "relations"."complaints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "complaint_candidates_status_idx" ON "relations"."complaint_candidates" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "complaint_candidates_pending_uq" ON "relations"."complaint_candidates" USING btree ("stay_id","category_code") WHERE status = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "complaint_categories_code_uq" ON "relations"."complaint_categories" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "complaints_number_uq" ON "relations"."complaints" USING btree ("property_id","number");--> statement-breakpoint
CREATE INDEX "complaints_status_idx" ON "relations"."complaints" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE INDEX "complaints_stay_idx" ON "relations"."complaints" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE INDEX "complaint_evidence_idx" ON "relations"."complaint_evidence" USING btree ("complaint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "complaint_links_uq" ON "relations"."complaint_links" USING btree ("complaint_id","kind","ref");--> statement-breakpoint
CREATE INDEX "recovery_actions_complaint_idx" ON "relations"."recovery_actions" USING btree ("complaint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_actions_approval_uq" ON "relations"."recovery_actions" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "complaint_status_history_idx" ON "relations"."complaint_status_history" USING btree ("complaint_id");
--> statement-breakpoint
ALTER TABLE "relations"."complaint_categories" ADD CONSTRAINT "complaint_categories_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaints" ADD CONSTRAINT "complaints_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_status_history" ADD CONSTRAINT "complaint_status_history_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_links" ADD CONSTRAINT "complaint_links_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_evidence" ADD CONSTRAINT "complaint_evidence_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_candidates" ADD CONSTRAINT "complaint_candidates_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."recovery_actions" ADD CONSTRAINT "recovery_actions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaints" ADD CONSTRAINT "complaints_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_candidates" ADD CONSTRAINT "complaint_candidates_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."recovery_actions" ADD CONSTRAINT "recovery_actions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations"."complaint_categories" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "relations"."complaints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations"."complaints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations"."complaints" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "relations"."complaint_status_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_status_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations"."complaint_status_history" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "relations"."complaint_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations"."complaint_links" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "relations"."complaint_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations"."complaint_evidence" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "relations"."complaint_candidates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations"."complaint_candidates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations"."complaint_candidates" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "relations"."recovery_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "relations"."recovery_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "relations"."recovery_actions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
CREATE FUNCTION "relations"."append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Complaint evidence and status history are kept exactly as recorded (rule 10).
  RAISE EXCEPTION 'relations.% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "complaint_evidence_append_only" BEFORE UPDATE OR DELETE ON "relations"."complaint_evidence" FOR EACH ROW EXECUTE FUNCTION "relations"."append_only"();
--> statement-breakpoint
CREATE TRIGGER "complaint_status_history_append_only" BEFORE UPDATE OR DELETE ON "relations"."complaint_status_history" FOR EACH ROW EXECUTE FUNCTION "relations"."append_only"();
