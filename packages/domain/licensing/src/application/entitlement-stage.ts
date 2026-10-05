import { HttpStatus } from '@nestjs/common';
import type { ActionRequest, GateStage, RequestActor } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import type { ManifestRegistry } from '@hotella/platform-manifest';
import { CORE } from '../domain/catalog';
import type { EntitlementEngine } from './entitlement-engine';

/** The add-on that lets a tenant use the API with its own clients (Spec §75). */
export const API_ACCESS = 'API_ACCESS';

/** Who is never stopped by a missing entitlement (BUILD_PLAN 11.B). */
export function entitlementApplies(request: ActionRequest, actor: RequestActor): boolean {
  // Platform-level actions (no tenant) and platform administrators onboarding a tenant are not customer use.
  if (!request.tenantId || actor.isPlatformAdmin) return false;
  // A tenant's API client is customer use like any person (Spec §75).
  if (actor.apiClient) return true;
  // PMS truth, checkout revocations, timers and retention keep running when a subscription lapses: integrity and
  // security before commerce. People, guests, AI agents and support engineers are gated.
  return actor.type !== 'SYSTEM' && actor.type !== 'INTEGRATION';
}

/** The capability an action needs: the request's own, else the gate entitlement of the module owning the permission. */
export function requiredEntitlement(request: ActionRequest, manifests: ManifestRegistry): string {
  return request.entitlement ?? manifests.ownerOfPermission(request.action)?.entitlement ?? CORE;
}

/** Action-gate stage 2 (Spec §60): did the customer get the capability? Replaces the Phase 1 pass-through. */
export class EntitlementStage implements GateStage {
  readonly name = 'entitlement';
  constructor(
    private readonly engine: EntitlementEngine,
    private readonly manifests: ManifestRegistry,
  ) {}

  async check(request: ActionRequest, actor: RequestActor): Promise<void> {
    if (!entitlementApplies(request, actor)) return;
    // A tenant can always read its own licence, also when it has lapsed.
    if (this.manifests.ownerOfPermission(request.action)?.code === 'license') return;
    // A hotel-site installation cut off from the control plane past its grace (ADR-0021).
    if (await this.engine.offlineExpired(request.tenantId!))
      throw new AppError('license.offline_expired', HttpStatus.FORBIDDEN);
    const code = requiredEntitlement(request, this.manifests);
    const property = request.propertyId ?? null;
    for (const needed of actor.apiClient ? [API_ACCESS, code] : [code])
      if (!(await this.engine.can(request.tenantId!, property, needed)))
        throw new AppError('license.not_entitled', HttpStatus.FORBIDDEN, { capability: needed });
  }
}
