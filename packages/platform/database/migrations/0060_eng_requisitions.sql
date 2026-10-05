CREATE TYPE "eng"."requisition_status" AS ENUM('PENDING_APPROVAL', 'APPROVED', 'SENT', 'CONFIRMED', 'FAILED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "eng"."requisitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"work_order_id" uuid,
	"quantity" numeric(12, 2) NOT NULL,
	"unit" varchar(16) NOT NULL,
	"needed_by" date,
	"reason" varchar(300),
	"status" "eng"."requisition_status" NOT NULL,
	"approval_id" uuid,
	"command_id" uuid,
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" uuid,
	"decided_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"failure" varchar(200),
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eng"."requisitions" ADD CONSTRAINT "requisitions_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "eng"."parts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng"."requisitions" ADD CONSTRAINT "requisitions_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "eng"."work_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requisitions_property_idx" ON "eng"."requisitions" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "requisitions_approval_uq" ON "eng"."requisitions" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requisitions_command_uq" ON "eng"."requisitions" USING btree ("command_id");;--> statement-breakpoint
ALTER TABLE "eng"."requisitions" ADD CONSTRAINT "requisitions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "eng"."requisitions" ADD CONSTRAINT "requisitions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "eng"."requisitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eng"."requisitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "eng"."requisitions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
