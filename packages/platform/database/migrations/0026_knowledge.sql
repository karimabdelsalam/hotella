CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE SCHEMA "knowledge";
--> statement-breakpoint
CREATE TYPE "knowledge"."audience" AS ENUM('GUEST', 'STAFF', 'ALL');--> statement-breakpoint
CREATE TYPE "knowledge"."classification" AS ENUM('PUBLIC', 'INTERNAL', 'CONFIDENTIAL');--> statement-breakpoint
CREATE TYPE "knowledge"."document_kind" AS ENUM('POLICY', 'FAQ', 'MENU', 'MANUAL', 'GENERAL');--> statement-breakpoint
CREATE TYPE "knowledge"."document_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "knowledge"."version_status" AS ENUM('DRAFT', 'PUBLISHED', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE "knowledge"."chunk_embeddings" (
	"chunk_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"model_code" varchar(128) NOT NULL,
	"dims" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunk_embeddings_pk" PRIMARY KEY("chunk_id","model_code")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"text" text NOT NULL,
	"normalized" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, normalized)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_version_seq_uq" UNIQUE("version_id","seq")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "knowledge"."version_status" DEFAULT 'DRAFT' NOT NULL,
	"language" varchar(8) NOT NULL,
	"audience" "knowledge"."audience" NOT NULL,
	"classification" "knowledge"."classification" NOT NULL,
	"department_code" varchar(32),
	"effective_from" date,
	"effective_until" date,
	"body" text NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "document_versions_no_uq" UNIQUE("document_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"kind" "knowledge"."document_kind" NOT NULL,
	"title" varchar(200) NOT NULL,
	"status" "knowledge"."document_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge"."chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "knowledge"."chunks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."chunks" ADD CONSTRAINT "chunks_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "knowledge"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "knowledge"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_embeddings_model_idx" ON "knowledge"."chunk_embeddings" USING btree ("tenant_id","model_code");--> statement-breakpoint
CREATE INDEX "chunks_search_idx" ON "knowledge"."chunks" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_published_uq" ON "knowledge"."document_versions" USING btree ("document_id","language") WHERE "knowledge"."document_versions"."status" = 'PUBLISHED';--> statement-breakpoint
CREATE INDEX "documents_scope_idx" ON "knowledge"."documents" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD CONSTRAINT "documents_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "knowledge"."document_versions" ADD CONSTRAINT "document_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "knowledge"."chunks" ADD CONSTRAINT "chunks_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "knowledge"."chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD CONSTRAINT "documents_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge"."documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge"."documents" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "knowledge"."document_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge"."document_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge"."document_versions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "knowledge"."chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge"."chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge"."chunks" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "knowledge"."chunk_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "knowledge"."chunk_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge"."chunk_embeddings" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
CREATE FUNCTION "knowledge"."published_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A published knowledge version is what answers were based on (Spec §38): it never changes, except being
  -- superseded by a newer one; only drafts may be deleted.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'knowledge.document_versions: version % is % and immutable', OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED'
     AND (to_jsonb(NEW) - 'status' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'knowledge.document_versions: version % is % and immutable', OLD.id, OLD.status;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "document_versions_immutable" BEFORE UPDATE OR DELETE ON "knowledge"."document_versions" FOR EACH ROW EXECUTE FUNCTION "knowledge"."published_versions_immutable"();
