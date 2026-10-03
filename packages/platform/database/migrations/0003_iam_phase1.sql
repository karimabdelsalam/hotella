CREATE SCHEMA "iam";
--> statement-breakpoint
CREATE TYPE "iam"."membership_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "iam"."risk_level" AS ENUM('READ', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "iam"."user_status" AS ENUM('INVITED', 'ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TABLE "iam"."membership_roles" (
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	CONSTRAINT "membership_roles_pk" PRIMARY KEY("membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "iam"."memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"property_id" uuid,
	"status" "iam"."membership_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "memberships_scope_uq" UNIQUE NULLS NOT DISTINCT("user_id","tenant_id","organization_id","property_id")
);
--> statement-breakpoint
CREATE TABLE "iam"."permissions" (
	"code" varchar(128) PRIMARY KEY NOT NULL,
	"module" varchar(32) NOT NULL,
	"risk" "iam"."risk_level" NOT NULL,
	"description_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."persons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"given_name" text NOT NULL,
	"family_name" text,
	"email" varchar(320),
	"phone" varchar(32),
	"locale_pref" varchar(16),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"replaced_by_id" uuid,
	CONSTRAINT "refresh_tokens_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "iam"."role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_code" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pk" PRIMARY KEY("role_id","permission_code")
);
--> statement-breakpoint
CREATE TABLE "iam"."role_translations" (
	"entity_id" uuid NOT NULL,
	"locale" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "role_translations_entity_locale_uq" UNIQUE("entity_id","locale")
);
--> statement-breakpoint
CREATE TABLE "iam"."roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"code" varchar(64) NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "roles_tenant_code_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "iam"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid NOT NULL,
	"ip" varchar(64),
	"user_agent" text,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "iam"."support_access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid,
	"granted_to_user_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"scopes" text[] NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."user_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_by" uuid,
	CONSTRAINT "user_invitations_token_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "iam"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid,
	"person_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text,
	"status" "iam"."user_status" DEFAULT 'INVITED' NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret_enc" text,
	"mfa_last_step" integer,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "users_tenant_email_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","email")
);
--> statement-breakpoint
ALTER TABLE "iam"."membership_roles" ADD CONSTRAINT "membership_roles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "iam"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."membership_roles" ADD CONSTRAINT "membership_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "iam"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "iam"."refresh_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "iam"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "iam"."permissions"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."role_translations" ADD CONSTRAINT "role_translations_entity_id_roles_id_fk" FOREIGN KEY ("entity_id") REFERENCES "iam"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."support_access_grants" ADD CONSTRAINT "support_access_grants_granted_to_user_id_users_id_fk" FOREIGN KEY ("granted_to_user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."user_invitations" ADD CONSTRAINT "user_invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iam"."users" ADD CONSTRAINT "users_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "iam"."persons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_roles_role_idx" ON "iam"."membership_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "iam"."memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "memberships_property_idx" ON "iam"."memberships" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "persons_tenant_idx" ON "iam"."persons" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "iam"."refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "iam"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_access_grants_tenant_idx" ON "iam"."support_access_grants" USING btree ("tenant_id","granted_to_user_id");--> statement-breakpoint
CREATE INDEX "user_invitations_user_idx" ON "iam"."user_invitations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_person_idx" ON "iam"."users" USING btree ("person_id");--> statement-breakpoint
-- Hand-written (reviewed): cross-context referential integrity. iam never imports org's schema module, but the
-- database still guarantees every tenant/property reference is real (CLAUDE.md rule 1). Not part of drizzle snapshots.
ALTER TABLE "iam"."persons" ADD CONSTRAINT "persons_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "iam"."users" ADD CONSTRAINT "users_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "iam"."user_invitations" ADD CONSTRAINT "user_invitations_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "iam"."roles" ADD CONSTRAINT "roles_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "org"."organizations"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "iam"."support_access_grants" ADD CONSTRAINT "support_access_grants_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "org"."tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "iam"."support_access_grants" ADD CONSTRAINT "support_access_grants_property_fk" FOREIGN KEY ("property_id") REFERENCES "org"."properties"("id") ON DELETE cascade;
