import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  type ConnectorCapability,
  type ConnectorManifest,
  type IntegrationHealthState,
  isConnectorCapability,
  isWriteCapability,
} from '@hotella/contracts-connectors';
import { IntegrationCapabilityChanged } from '@hotella/contracts-events';
import { ENTITLEMENT_API, type EntitlementPublicApi } from '@hotella/domain-licensing/public';
import type { PropertyScope, TenantScope } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { ConnectorRegistry } from '../connectors/registry';
import {
  type CapabilityFacts,
  type CapabilityStatus,
  type IneffectiveReason,
  ineffectiveReasons,
  PMS_OPERATION_CODES,
  PMS_OPERATIONS,
  type PmsOperation,
  route,
  type RoutingDecision,
  statusFromHealth,
} from '../domain/capabilities';
import { CapabilityRepositories } from '../infrastructure/capability-repositories';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type {
  IntegrationInstanceRow,
  PropertyCapabilityRow,
  RoutingOverrideRow,
} from '../infrastructure/schema';

export interface InstanceFacts {
  readonly row: IntegrationInstanceRow;
  readonly manifest: ConnectorManifest | undefined;
  readonly health: IntegrationHealthState | null;
  readonly status: CapabilityStatus;
  readonly licensed: boolean;
}

/** Everything the rule needs about one property, read once. */
export interface PropertyFacts {
  readonly scope: PropertyScope;
  readonly instances: readonly InstanceFacts[];
  readonly verifications: ReadonlyMap<string, PropertyCapabilityRow>;
  readonly overrides: ReadonlyMap<string, RoutingOverrideRow>;
}

export interface ConnectorView {
  readonly instanceId: string;
  readonly connectorCode: string;
  readonly name: string;
  readonly effective: boolean;
  readonly reasons: readonly IneffectiveReason[];
  readonly status: CapabilityStatus;
  readonly verifiedAt: Date | null;
  readonly verificationRef: string | null;
}

export interface CapabilityView {
  readonly capability: ConnectorCapability;
  readonly write: boolean;
  readonly effective: boolean;
  readonly connectors: readonly ConnectorView[];
}

const key = (instanceId: string, capability: string) => `${instanceId}:${capability}`;

/**
 * The per-property capability registry (ADR-0019; guide §5): the only answer to "may the platform do X with this
 * hotel's PMS now, and through which connector?" — for `PMS_API`, the action gate's connector stage, the apps and the
 * AI tools. Facts come from their owners (manifest, instance, agent report, licence, health); only commissioning
 * verification is stored here. Calls join the ambient unit of work.
 */
@Injectable()
export class CapabilityRegistry {
  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly caps: CapabilityRepositories,
    private readonly connectors: ConnectorRegistry,
    private readonly events: EventPublisher,
    @Optional() @Inject(ENTITLEMENT_API) private readonly entitlements?: EntitlementPublicApi,
  ) {}

  async facts(scope: PropertyScope): Promise<PropertyFacts> {
    const [instances, health, verifications, overrides] = await Promise.all([
      this.repo.listInstances(scope),
      this.caps.healthOf(scope),
      this.caps.verifications(scope),
      this.caps.overrides(scope),
    ]);
    const healthBy = new Map(health.map((h) => [h.instanceId, h.status]));
    const licence = new Map<string, Promise<boolean>>();
    const licensed = (code: string | undefined) => {
      if (!code || !this.entitlements) return Promise.resolve(true);
      if (!licence.has(code))
        licence.set(code, this.entitlements.can(scope.tenantId, scope.propertyId, code));
      return licence.get(code)!;
    };
    const ordered = [...instances].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    return {
      scope,
      instances: await Promise.all(
        ordered.map(async (row) => {
          const manifest = this.connectors.get(row.connectorCode)?.manifest;
          const h = healthBy.get(row.id) ?? null;
          return {
            row,
            manifest,
            health: h,
            status: statusFromHealth(h),
            licensed: await licensed(manifest?.entitlement),
          };
        }),
      ),
      verifications: new Map(verifications.map((v) => [key(v.instanceId, v.capability), v])),
      overrides: new Map(overrides.map((o) => [o.operation, o])),
    };
  }

  factsFor(p: PropertyFacts, i: InstanceFacts, capability: ConnectorCapability): CapabilityFacts {
    const v = p.verifications.get(key(i.row.id, capability));
    return {
      instanceId: i.row.id,
      connectorCode: i.row.connectorCode,
      instanceActive: i.row.status === 'ACTIVE',
      supported: Boolean(i.manifest?.capabilities.includes(capability)),
      enabled: i.row.enabledCapabilities.includes(capability),
      reported: i.row.reportedCapabilities ? i.row.reportedCapabilities.includes(capability) : null,
      licensed: i.licensed,
      verified: Boolean(v?.verifiedAt),
      commissioned: Boolean(i.row.commissionedAt),
      status: i.status,
    };
  }

  /** Every capability any connector of the property declares, with each connector's verdict. */
  view(p: PropertyFacts): CapabilityView[] {
    const all = new Set<ConnectorCapability>();
    for (const i of p.instances) for (const c of i.manifest?.capabilities ?? []) all.add(c);
    return [...all].sort().map((capability) => {
      const connectors = p.instances
        .filter((i) => i.manifest?.capabilities.includes(capability))
        .map((i) => {
          const reasons = ineffectiveReasons(capability, this.factsFor(p, i, capability));
          const v = p.verifications.get(key(i.row.id, capability));
          return {
            instanceId: i.row.id,
            connectorCode: i.row.connectorCode,
            name: i.row.name,
            effective: reasons.length === 0,
            reasons,
            status: i.status,
            verifiedAt: v?.verifiedAt ?? null,
            verificationRef: v?.verificationRef ?? null,
          };
        });
      return {
        capability,
        write: isWriteCapability(capability),
        effective: connectors.some((c) => c.effective),
        connectors,
      };
    });
  }

  decide(p: PropertyFacts, operation: PmsOperation): RoutingDecision {
    const capability: ConnectorCapability = PMS_OPERATIONS[operation].capability;
    return route(
      operation,
      p.instances.map((i) => ({
        instanceId: i.row.id,
        connectorCode: i.row.connectorCode,
        readOnly: Boolean(i.manifest?.readOnly),
        reasons: ineffectiveReasons(capability, this.factsFor(p, i, capability)),
        status: i.status,
      })),
      p.overrides.get(operation)?.connectors ?? null,
    );
  }

  routing(p: PropertyFacts): RoutingDecision[] {
    return PMS_OPERATION_CODES.map((op) => this.decide(p, op));
  }

  /** Does the connector answer this predefined read (link protocol 2)? */
  servesQuery(connectorCode: string, queryType: string): boolean {
    return Boolean(
      this.connectors.get(connectorCode)?.manifest.queries?.some((q) => q.code === queryType),
    );
  }

  /** `PMS_API.can` (guide §5.3): does any connector of the property serve the capability effectively now? */
  async can(scope: PropertyScope, capability: string): Promise<boolean> {
    if (!isConnectorCapability(capability)) return false;
    const p = await this.facts(scope);
    return p.instances.some(
      (i) => ineffectiveReasons(capability, this.factsFor(p, i, capability)).length === 0,
    );
  }

  /**
   * Recomputes the property's effective capabilities and announces each change once
   * (`integration.capability.changed.v1`). Run inside the transaction of whatever changed a fact.
   */
  async refresh(scope: PropertyScope): Promise<number> {
    const p = await this.facts(scope);
    const now = new Map(
      this.view(p).map((v) => [
        v.capability as string,
        {
          effective: v.effective,
          connectors: [
            ...new Set(v.connectors.filter((c) => c.effective).map((c) => c.connectorCode)),
          ],
        },
      ]),
    );
    const before = new Map((await this.caps.states(scope)).map((s) => [s.capability, s]));
    // A capability no connector declares any more becomes ineffective.
    for (const [capability, s] of before)
      if (!now.has(capability) && s.effective)
        now.set(capability, { effective: false, connectors: [] });
    let changed = 0;
    for (const [capability, state] of now) {
      const prev = before.get(capability);
      const same =
        prev &&
        prev.effective === state.effective &&
        prev.connectors.join(',') === state.connectors.join(',');
      if (same) continue;
      await this.caps.saveState({
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        capability,
        effective: state.effective,
        connectors: state.connectors,
      });
      // The first sighting of a capability that is not effective is not news.
      if (!prev && !state.effective) continue;
      changed++;
      await this.events.publish(IntegrationCapabilityChanged, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'integration',
        aggregate: { type: 'property_capability', id: scope.propertyId },
        payload: { capability, effective: state.effective, connectors: state.connectors },
      });
    }
    return changed;
  }

  /** Licence changes reach every property of the tenant that has integrations (or one property). */
  async refreshTenant(scope: TenantScope, propertyId: string | null): Promise<number> {
    let changed = 0;
    for (const id of await this.caps.propertiesWithInstances(scope, propertyId))
      changed += await this.refresh({ tenantId: scope.tenantId, propertyId: id });
    return changed;
  }
}
