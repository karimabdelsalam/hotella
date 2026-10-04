import { timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  ENTITLEMENT_API,
  type EntitlementPublicApi,
  USAGE_API,
  type UsagePublicApi,
} from '@hotella/domain-licensing/public';
import { AppError } from '@hotella/platform-i18n';
import type { RequestActor } from '@hotella/platform-auth';
import { newId } from '@hotella/platform-database';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { sha256Hex } from '../domain/tokens';
import { IdentityRepositories } from '../infrastructure/repositories';
import type { ApiClientRow } from '../infrastructure/schema';

const KEY_RE = /^hk_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const LAST_USED_EVERY_MS = 60_000;
const API_ACCESS = 'API_ACCESS';

/**
 * API keys (Spec §75): `hk_<prefix>_<secret>` → an INTEGRATION actor with the client's scopes, or null (unknown,
 * wrong secret, revoked, expired). The secret is compared by digest in constant time. A valid key of a tenant without
 * API_ACCESS is refused (403). Every authenticated call is metered as API_CALLS; bookkeeping never fails the request.
 */
@Injectable()
export class ApiKeyAuthenticator {
  private readonly lastUsed = new Map<string, number>();

  constructor(
    private readonly repo: IdentityRepositories,
    private readonly ctx: RequestContext,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(USAGE_API) private readonly usage?: UsagePublicApi,
    @Optional() @Inject(ENTITLEMENT_API) private readonly entitlements?: EntitlementPublicApi,
  ) {}

  static looksLikeKey(token: string): boolean {
    return token.startsWith('hk_');
  }

  async authenticate(key: string): Promise<RequestActor | null> {
    const m = KEY_RE.exec(key);
    if (!m) return null;
    const row = await this.repo.apiClientByPrefix(m[1]!);
    if (!row || row.status !== 'ACTIVE' || (row.expiresAt && row.expiresAt <= new Date()))
      return null;
    const expected = Buffer.from(row.secretHash, 'hex');
    const given = Buffer.from(sha256Hex(m[2]!), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    // Reads do not pass the action gate, so the key itself stops working while the tenant lacks API_ACCESS.
    if (
      this.entitlements &&
      !(await this.entitlements.can(row.tenantId, row.propertyId, API_ACCESS))
    )
      throw new AppError('license.not_entitled', HttpStatus.FORBIDDEN, { capability: API_ACCESS });
    await this.touch(row);
    return {
      type: 'INTEGRATION',
      id: row.id,
      tenantId: row.tenantId,
      isPlatformAdmin: false,
      apiClient: { scopes: row.scopes, propertyId: row.propertyId },
    };
  }

  private async touch(row: ApiClientRow): Promise<void> {
    try {
      const now = Date.now();
      if (now - (this.lastUsed.get(row.id) ?? 0) > LAST_USED_EVERY_MS) {
        this.lastUsed.set(row.id, now);
        await this.repo.markApiClientUsed(row.id, new Date(now));
      }
      await this.usage?.record({
        tenantId: row.tenantId,
        propertyId: row.propertyId,
        metric: 'API_CALLS',
        quantity: 1,
        source: 'iam.api_client',
        idempotencyKey: `api-call:${row.id}:${this.ctx.correlationId ?? newId()}`,
      });
    } catch (err) {
      this.logger.warn({ err, api_client_id: row.id }, 'api client bookkeeping failed');
    }
  }
}
