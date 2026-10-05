CREATE TABLE "lostfound"."vision_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"photo" varchar(80) NOT NULL,
	"object_type" varchar(80),
	"category" varchar(32),
	"description" varchar(300),
	"colours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"material" varchar(60),
	"brand" varchar(60),
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_call_id" varchar(64) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lostfound"."vision_readings" ADD CONSTRAINT "vision_readings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "lostfound"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vision_readings_photo_uq" ON "lostfound"."vision_readings" USING btree ("item_id","photo");--> statement-breakpoint
ALTER TABLE "lostfound"."vision_readings" ADD CONSTRAINT "vision_readings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "lostfound"."vision_readings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lostfound"."vision_readings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lostfound"."vision_readings" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
