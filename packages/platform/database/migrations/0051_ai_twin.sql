CREATE TYPE "ai"."twin_kind" AS ENUM('LOCATION', 'STAY', 'GUEST', 'ASSET', 'WORK_ITEM', 'WORK_ORDER', 'SERVICE_REQUEST', 'COMPLAINT', 'CONVERSATION', 'INSPECTION', 'LOST_ITEM', 'STAFF');--> statement-breakpoint
CREATE TABLE "ai"."twin_edges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"from_node" uuid NOT NULL,
	"relation" varchar(32) NOT NULL,
	"to_node" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai"."twin_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "ai"."twin_kind" NOT NULL,
	"ref_id" uuid NOT NULL,
	"state" varchar(32),
	"state_at" timestamp with time zone,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai"."twin_edges" ADD CONSTRAINT "twin_edges_from_node_twin_nodes_id_fk" FOREIGN KEY ("from_node") REFERENCES "ai"."twin_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai"."twin_edges" ADD CONSTRAINT "twin_edges_to_node_twin_nodes_id_fk" FOREIGN KEY ("to_node") REFERENCES "ai"."twin_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "twin_edges_open_uq" ON "ai"."twin_edges" USING btree ("from_node","relation","to_node") WHERE "ai"."twin_edges"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "twin_edges_from_idx" ON "ai"."twin_edges" USING btree ("from_node","valid_from");--> statement-breakpoint
CREATE INDEX "twin_edges_to_idx" ON "ai"."twin_edges" USING btree ("to_node","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "twin_nodes_ref_uq" ON "ai"."twin_nodes" USING btree ("tenant_id","kind","ref_id");--> statement-breakpoint
-- Tenant and property FKs and row-level security (the twin is tenant data).
ALTER TABLE "ai"."twin_nodes" ADD CONSTRAINT "twin_nodes_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."twin_edges" ADD CONSTRAINT "twin_edges_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "ai"."twin_nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."twin_nodes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."twin_nodes" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
ALTER TABLE "ai"."twin_edges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."twin_edges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai"."twin_edges" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());--> statement-breakpoint
-- Connections end, they never disappear (rule 10): an edge may only get its end time once.
CREATE FUNCTION "ai"."twin_edges_end_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai.twin_edges are never deleted';
  END IF;
  IF OLD.valid_to IS NOT NULL OR NEW.from_node <> OLD.from_node OR NEW.to_node <> OLD.to_node
     OR NEW.relation <> OLD.relation OR NEW.valid_from <> OLD.valid_from THEN
    RAISE EXCEPTION 'an ai.twin_edges row may only be ended';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "twin_edges_end_only" BEFORE UPDATE OR DELETE ON "ai"."twin_edges" FOR EACH ROW EXECUTE FUNCTION "ai"."twin_edges_end_only"();
