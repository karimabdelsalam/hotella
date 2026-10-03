CREATE SCHEMA "integration";
--> statement-breakpoint
CREATE TYPE "integration"."command_status" AS ENUM('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "integration"."connector_category" AS ENUM('PMS', 'POS', 'ERP', 'BMS', 'PBX', 'LOCK', 'PAYMENT', 'CRM', 'IOT', 'WIFI', 'OTHER');--> statement-breakpoint
CREATE TYPE "integration"."exception_kind" AS ENUM('UNKNOWN_MAPPING', 'PARSE_ERROR', 'UNSUPPORTED_MESSAGE', 'CONFLICT');--> statement-breakpoint
CREATE TYPE "integration"."exception_status" AS ENUM('OPEN', 'RESOLVED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "integration"."health_status" AS ENUM('HEALTHY', 'DEGRADED', 'OFFLINE', 'MISCONFIGURED', 'AUTH_FAILED');--> statement-breakpoint
CREATE TYPE "integration"."instance_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "integration"."mapping_type" AS ENUM('ROOM', 'ROOM_TYPE', 'RATE', 'MARKET', 'VIP', 'ROOM_STATUS');--> statement-breakpoint
CREATE TYPE "integration"."message_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "integration"."message_status" AS ENUM('RECEIVED', 'PROCESSED', 'PENDING_MAPPING', 'HELD', 'FAILED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "integration"."connector_definitions" (
	"code" varchar(48) PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"category" "integration"."connector_category" NOT NULL,
	"description" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"message_types" jsonb NOT NULL,
	"commands" jsonb NOT NULL,
	"config_schema" jsonb NOT NULL,
	"credential_schema" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."external_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_instance_id" uuid NOT NULL,
	"internal_entity_type" varchar(64) NOT NULL,
	"internal_entity_id" uuid NOT NULL,
	"external_entity_type" varchar(64) NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_references_external_uq" UNIQUE("integration_instance_id","external_entity_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "integration"."integration_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"command_type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"status" "integration"."command_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error" text,
	"correlation_id" varchar(128),
	"requested_by_type" varchar(16) NOT NULL,
	"requested_by_id" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "integration_commands_idempotency_uq" UNIQUE("instance_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "integration"."integration_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"message_id" uuid,
	"kind" "integration"."exception_kind" NOT NULL,
	"mapping_type" "integration"."mapping_type",
	"external_code" varchar(64),
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "integration"."exception_status" DEFAULT 'OPEN' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."integration_health" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"status" "integration"."health_status" DEFAULT 'OFFLINE' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"latency_ms_p95" integer,
	"queue_depth" integer,
	"error_rate_permille" integer DEFAULT 0 NOT NULL,
	"recent_total" integer DEFAULT 0 NOT NULL,
	"recent_failed" integer DEFAULT 0 NOT NULL,
	"agent_last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration"."integration_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"connector_code" varchar(48) NOT NULL,
	"name" text NOT NULL,
	"status" "integration"."instance_status" DEFAULT 'DRAFT' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_capabilities" text[] NOT NULL,
	"reported_capabilities" text[],
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "integration_instances_property_name_uq" UNIQUE("property_id","name")
);
--> statement-breakpoint
CREATE TABLE "integration"."integration_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"mapping_type" "integration"."mapping_type" NOT NULL,
	"external_code" varchar(64) NOT NULL,
	"internal_value" varchar(128) NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "integration_mappings_code_uq" UNIQUE("instance_id","mapping_type","external_code")
);
--> statement-breakpoint
CREATE TABLE "integration"."integration_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"direction" "integration"."message_direction" DEFAULT 'INBOUND' NOT NULL,
	"message_type" varchar(64) NOT NULL,
	"source_message_id" varchar(200) NOT NULL,
	"sequence_no" bigint,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"status" "integration"."message_status" DEFAULT 'RECEIVED' NOT NULL,
	"ordering_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"canonical_event_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"error" text,
	CONSTRAINT "integration_messages_source_uq" UNIQUE("instance_id","source_message_id")
);
--> statement-breakpoint
ALTER TABLE "integration"."external_references" ADD CONSTRAINT "external_references_integration_instance_id_integration_instances_id_fk" FOREIGN KEY ("integration_instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."integration_commands" ADD CONSTRAINT "integration_commands_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."integration_exceptions" ADD CONSTRAINT "integration_exceptions_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."integration_exceptions" ADD CONSTRAINT "integration_exceptions_message_id_integration_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "integration"."integration_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."integration_health" ADD CONSTRAINT "integration_health_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."integration_instances" ADD CONSTRAINT "integration_instances_connector_code_connector_definitions_code_fk" FOREIGN KEY ("connector_code") REFERENCES "integration"."connector_definitions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."integration_mappings" ADD CONSTRAINT "integration_mappings_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration"."integration_messages" ADD CONSTRAINT "integration_messages_instance_id_integration_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "integration"."integration_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_references_internal_idx" ON "integration"."external_references" USING btree ("tenant_id","internal_entity_type","internal_entity_id");--> statement-breakpoint
CREATE INDEX "integration_commands_pending_idx" ON "integration"."integration_commands" USING btree ("instance_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_exceptions_open_code_uq" ON "integration"."integration_exceptions" USING btree ("instance_id","mapping_type","external_code") WHERE "integration"."integration_exceptions"."status" = 'OPEN' AND "integration"."integration_exceptions"."kind" = 'UNKNOWN_MAPPING';--> statement-breakpoint
CREATE INDEX "integration_exceptions_status_idx" ON "integration"."integration_exceptions" USING btree ("tenant_id","property_id","status");--> statement-breakpoint
CREATE INDEX "integration_instances_tenant_idx" ON "integration"."integration_instances" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "integration_messages_status_idx" ON "integration"."integration_messages" USING btree ("instance_id","status");--> statement-breakpoint
CREATE INDEX "integration_messages_ordering_idx" ON "integration"."integration_messages" USING gin ("ordering_keys");--> statement-breakpoint
-- Hand-written (reviewed): tenant/property integrity across contexts (a context never imports another context's schema
-- module; the database still enforces the references) and row-level security as in migration 0006.
ALTER TABLE "integration"."external_references" ADD CONSTRAINT "external_references_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_commands" ADD CONSTRAINT "integration_commands_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_exceptions" ADD CONSTRAINT "integration_exceptions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_health" ADD CONSTRAINT "integration_health_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_instances" ADD CONSTRAINT "integration_instances_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_mappings" ADD CONSTRAINT "integration_mappings_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_messages" ADD CONSTRAINT "integration_messages_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_commands" ADD CONSTRAINT "integration_commands_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_exceptions" ADD CONSTRAINT "integration_exceptions_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_health" ADD CONSTRAINT "integration_health_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_instances" ADD CONSTRAINT "integration_instances_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_mappings" ADD CONSTRAINT "integration_mappings_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."integration_messages" ADD CONSTRAINT "integration_messages_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "integration"."external_references" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."external_references" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."external_references" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."integration_commands" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."integration_commands" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."integration_commands" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."integration_exceptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."integration_exceptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."integration_exceptions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."integration_health" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."integration_health" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."integration_health" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."integration_instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."integration_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."integration_instances" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."integration_mappings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."integration_mappings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."integration_mappings" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "integration"."integration_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration"."integration_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integration"."integration_messages" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
