import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AuditWriter } from '@hotella/platform-audit';
import {
  ActionGate,
  ActorStore,
  PROPERTY_SCOPE_VERIFIER,
  type PropertyScopeVerifier,
  type RequestActor,
} from '@hotella/platform-auth';
import { isUuid, newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { missingForDelegation } from '../domain/access';
import { sha256Hex } from '../domain/tokens';
import { MembershipPermissionResolver } from '../auth/permission-resolver';
import { IdentityRepositories } from '../infrastructure/repositories';
import type { ApiClientRow } from '../infrastructure/schema';

export const createApiClientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  propertyId: z.uuid().nullish(),
  scopes: z
    .array(z.string().regex(/^[a-z][a-z0-9_.]{2,127}$/))
    .min(1)
    .max(100),
  expiresAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .nullish(),
});
export type CreateApiClientInput = z.infer<typeof createApiClientSchema>;
export const revokeApiClientSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/** Permissions an API client may never hold, whatever its creator holds: people management and support access. */
const NEVER_FOR_MACHINES = /^(iam\.|support\.|license\.)/;

/**
 * Developer platform v1 (Spec §75, BUILD_PLAN 11.5): a tenant's API clients. A key is shown once; the platform keeps
 * its prefix and SHA-256 digest only. Scopes are a subset of what the creator holds at the client's scope (no
 * escalation, as for roles); the client acts as an INTEGRATION actor, gated by API_ACCESS and its modules'
 * entitlements, and every authenticated call is metered as API_CALLS.
 */
@Injectable()
export class ApiClientService {
  constructor(
    private readonly repo: IdentityRepositories,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly resolver: MembershipPermissionResolver,
    @Optional()
    @Inject(PROPERTY_SCOPE_VERIFIER)
    private readonly properties?: PropertyScopeVerifier | null,
  ) {}

  list(scope: TenantScope) {
    return this.gate.execute(
      { action: 'iam.api_client.manage', tenantId: scope.tenantId, entitlement: 'API_ACCESS' },
      () => this.tx.read(async () => (await this.repo.apiClients(scope)).map(view)),
    );
  }

  create(scope: TenantScope, input: CreateApiClientInput) {
    const propertyId = input.propertyId ?? null;
    return this.gate.execute(
      {
        action: 'iam.api_client.manage',
        tenantId: scope.tenantId,
        propertyId,
        entitlement: 'API_ACCESS',
      },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          if (
            propertyId &&
            this.properties &&
            !(await this.properties.propertyBelongsToTenant(propertyId, scope.tenantId))
          )
            throw AppError.notFound('org.property.not_found');
          const scopes = [...new Set(input.scopes)].sort();
          const forbidden = scopes.filter((p) => NEVER_FOR_MACHINES.test(p));
          if (forbidden.length)
            throw AppError.forbidden('iam.api_client.scope_not_allowed', {
              permission: forbidden.join(', '),
            });
          await this.assertGrantable(scopes, scope, propertyId, actor);
          const prefix = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);
          const secret = randomBytes(32).toString('base64url');
          const row = await this.repo.insertApiClient({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId,
            name: input.name,
            keyPrefix: prefix,
            secretHash: sha256Hex(secret),
            scopes,
            expiresAt: input.expiresAt ?? null,
            createdBy: isUuid(actor.id) ? actor.id : null,
          });
          await this.audit.record({
            action: 'iam.api_client.create',
            entityType: 'api_client',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId,
            after: { name: row.name, scopes, expires_at: row.expiresAt?.toISOString() ?? null },
          });
          // The key exists only in this response.
          return { client: view(row), key: `hk_${prefix}_${secret}` };
        }),
    );
  }

  revoke(scope: TenantScope, id: string, reason: string) {
    return this.gate.execute({ action: 'iam.api_client.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const actor = this.actors.require();
        const row = isUuid(id)
          ? await this.repo.revokeApiClient(scope, id, isUuid(actor.id) ? actor.id : null, reason)
          : undefined;
        if (!row) throw AppError.notFound('iam.api_client.not_found');
        await this.audit.record({
          action: 'iam.api_client.revoke',
          entityType: 'api_client',
          entityId: id,
          tenantId: scope.tenantId,
          propertyId: row.propertyId,
          reason,
          after: { status: 'REVOKED' },
        });
        return view(row);
      }),
    );
  }

  private async assertGrantable(
    scopes: readonly string[],
    scope: TenantScope,
    propertyId: string | null,
    actor: RequestActor,
  ): Promise<void> {
    const catalog = new Set((await this.repo.listPermissions()).map((p) => p.code));
    const unknown = scopes.filter((p) => !catalog.has(p));
    if (unknown.length)
      throw new AppError('iam.role.unknown_permission', HttpStatus.UNPROCESSABLE_ENTITY, {
        code: unknown.join(', '),
      });
    if (actor.isPlatformAdmin) return;
    const held = new Set(
      await this.resolver.permissionsFor(actor, { tenantId: scope.tenantId, propertyId }),
    );
    const lacking = missingForDelegation(held, scopes);
    if (lacking.length)
      throw AppError.forbidden('iam.role.cannot_delegate', { permission: lacking.join(', ') });
  }
}

export function view(row: ApiClientRow) {
  return {
    id: row.id,
    name: row.name,
    propertyId: row.propertyId,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    status: row.status,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}
