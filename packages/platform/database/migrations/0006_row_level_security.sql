-- Hand-written (reviewed). Row-level security as defence in depth (Spec §2.2, CLAUDE.md rule 1).
-- Application authorization stays authoritative: repositories always filter by tenant. These policies add a database
-- guarantee for every transaction the API opens on behalf of a tenant: TransactionRunner sets the transaction-local
-- `app.tenant_id`, and rows of any other tenant become invisible and unwritable even if a query forgets its filter.
-- When `app.tenant_id` is not set (platform administration, background jobs, migrations) the policies do not
-- restrict. FORCE makes them apply to the table owner too; superusers always bypass RLS, so the application must
-- connect as an ordinary role in every deployed environment (runbook: pilot deployment).
CREATE FUNCTION "platform"."current_tenant"() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
--> statement-breakpoint
ALTER TABLE "org"."organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."organizations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "org"."properties" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."properties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."properties" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "org"."locations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."locations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."locations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "org"."room_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."room_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."room_types" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "org"."rooms" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."rooms" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."rooms" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "org"."brand_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."brand_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."brand_profiles" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "iam"."persons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."persons" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."persons" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "iam"."users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."users" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "iam"."user_invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."user_invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."user_invitations" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "iam"."memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."memberships" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "iam"."sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."sessions" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "iam"."support_access_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."support_access_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."support_access_grants" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "platform"."attribution_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform"."attribution_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "platform"."attribution_policies" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "iam"."roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "iam"."roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Platform-wide rows (tenant_id NULL: system roles, platform defaults) stay readable inside a tenant transaction.
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "iam"."roles" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "platform"."configuration" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform"."configuration" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Platform-wide rows (tenant_id NULL: system roles, platform defaults) stay readable inside a tenant transaction.
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "platform"."configuration" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "platform"."retention_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform"."retention_policies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Platform-wide rows (tenant_id NULL: system roles, platform defaults) stay readable inside a tenant transaction.
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "platform"."retention_policies" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "platform"."configuration_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "platform"."configuration_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Platform-wide rows (tenant_id NULL: system roles, platform defaults) stay readable inside a tenant transaction.
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "platform"."configuration_history" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "org"."tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org"."tenants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org"."tenants" USING ("platform"."current_tenant"() IS NULL OR "id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "id" = "platform"."current_tenant"());
--> statement-breakpoint
ALTER TABLE "audit"."audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit"."audit_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Platform-level security events (tenant_id NULL) may be recorded from within a tenant transaction.
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit"."audit_log" USING ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"()) WITH CHECK ("platform"."current_tenant"() IS NULL OR "tenant_id" IS NULL OR "tenant_id" = "platform"."current_tenant"());
