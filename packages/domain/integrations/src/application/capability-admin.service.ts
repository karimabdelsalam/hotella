import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CONNECTOR_CAPABILITIES, type ConnectorCapability } from '@hotella/contracts-connectors';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { ConnectorRegistry } from '../connectors/registry';
import { isPmsOperation, overrideProblem, PMS_OPERATIONS } from '../domain/capabilities';
import { CapabilityRepositories } from '../infrastructure/capability-repositories';
import { IntegrationRepositories } from '../infrastructure/repositories';
import { CapabilityRegistry } from './capability-registry';

export const verifyCapabilitySchema = z.object({
  instanceId: z.uuid(),
  /** Where the proof is: commissioning record, ticket, test log (guide §16.5). */
  evidenceRef: z.string().trim().min(3).max(300),
});
export const unverifyCapabilitySchema = z.object({
  instanceId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});
export const routingOverrideSchema = z.object({
  /** Connector codes in the order to try; empty = back to the standard order. */
  connectors: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/)).max(8),
});
export const commissionSchema = z.object({ evidenceRef: z.string().trim().min(3).max(300) });
export const capabilityCodeSchema = z.enum(CONNECTOR_CAPABILITIES);

/**
 * Commissioning and routing of the per-property capability registry (ADR-0019; guide §5, §16.5): verify or un-verify
 * a capability of one connector instance with evidence, sign the instance off, and reorder an operation's connectors
 * within what the standard allows. Installer/control-plane work: staff never see it. Every change is audited, kept in
 * the capability history and re-announced through `integration.capability.changed.v1`.
 */
@Injectable()
export class CapabilityAdminService {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly caps: CapabilityRepositories,
    private readonly repo: IntegrationRepositories,
    private readonly connectors: ConnectorRegistry,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  view(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const facts = await this.registry.facts(scope);
          return {
            capabilities: this.registry.view(facts),
            routing: this.registry.routing(facts).map((d) => ({
              operation: d.operation,
              kind: PMS_OPERATIONS[d.operation].kind,
              capability: PMS_OPERATIONS[d.operation].capability,
              standardOrder: PMS_OPERATIONS[d.operation].connectors,
              override: facts.overrides.get(d.operation)?.connectors ?? null,
              route: d.route,
              skipped: d.skipped,
            })),
            instances: facts.instances.map((i) => ({
              id: i.row.id,
              connectorCode: i.row.connectorCode,
              name: i.row.name,
              status: i.row.status,
              health: i.health,
              licensed: i.licensed,
              commissionedAt: i.row.commissionedAt,
            })),
          };
        }),
    );
  }

  history(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.caps.historyOf(scope, 200)),
    );
  }

  verify(
    scope: PropertyScope,
    capability: ConnectorCapability,
    input: z.infer<typeof verifyCapabilitySchema>,
  ) {
    return this.gate.execute(
      {
        action: 'integration.capability.verify',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const instance = await this.instanceSupporting(scope, input.instanceId, capability);
          const at = new Date();
          await this.caps.upsertVerification({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: instance.id,
            connectorCode: instance.connectorCode,
            capability,
            verifiedAt: at,
            verifiedBy: isUuid(actor.id) ? actor.id : null,
            verificationRef: input.evidenceRef,
          });
          await this.caps.history({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: instance.id,
            capability,
            action: 'VERIFIED',
            actorType: actor.type,
            actorId: actor.id,
            reference: input.evidenceRef,
          });
          await this.audit.record({
            action: 'integration.capability.verify',
            entityType: 'integration_instance',
            entityId: instance.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: {
              capability,
              connector: instance.connectorCode,
              evidence_ref: input.evidenceRef,
            },
          });
          await this.registry.refresh(scope);
          return this.verdict(scope, capability);
        }),
    );
  }

  unverify(
    scope: PropertyScope,
    capability: ConnectorCapability,
    input: z.infer<typeof unverifyCapabilitySchema>,
  ) {
    return this.gate.execute(
      {
        action: 'integration.capability.verify',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const current = await this.caps.verification(scope, input.instanceId, capability);
          if (!current?.verifiedAt)
            throw AppError.notFound('integration.capability.not_verified', { capability });
          await this.caps.upsertVerification({
            id: current.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: current.instanceId,
            connectorCode: current.connectorCode,
            capability,
            verifiedAt: null,
            verifiedBy: null,
            verificationRef: null,
          });
          await this.caps.history({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: current.instanceId,
            capability,
            action: 'UNVERIFIED',
            actorType: actor.type,
            actorId: actor.id,
            reason: input.reason,
          });
          await this.audit.record({
            action: 'integration.capability.unverify',
            entityType: 'integration_instance',
            entityId: current.instanceId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            reason: input.reason,
            before: { capability, evidence_ref: current.verificationRef },
          });
          await this.registry.refresh(scope);
          return this.verdict(scope, capability);
        }),
    );
  }

  /**
   * Commissioning sign-off of one instance (guide §16.5): from now on its capabilities count only once verified,
   * reads and events included. Signing off cannot be undone; a new commissioning means a new instance.
   */
  commission(scope: PropertyScope, instanceId: string, input: z.infer<typeof commissionSchema>) {
    return this.gate.execute(
      {
        action: 'integration.capability.verify',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const instance = await this.instance(scope, instanceId);
          if (instance.commissionedAt)
            throw AppError.conflict('integration.instance.already_commissioned');
          await this.caps.commission(
            scope,
            [instance.id],
            isUuid(actor.id) ? actor.id : null,
            new Date(),
          );
          await this.caps.history({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: instance.id,
            action: 'COMMISSIONED',
            actorType: actor.type,
            actorId: actor.id,
            reference: input.evidenceRef,
          });
          await this.audit.record({
            action: 'integration.instance.commission',
            entityType: 'integration_instance',
            entityId: instance.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { connector: instance.connectorCode, evidence_ref: input.evidenceRef },
          });
          await this.registry.refresh(scope);
          return { instanceId: instance.id, commissioned: true };
        }),
    );
  }

  setRouting(
    scope: PropertyScope,
    operation: string,
    input: z.infer<typeof routingOverrideSchema>,
  ) {
    return this.gate.execute(
      {
        action: 'integration.capability.manage',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          if (!isPmsOperation(operation))
            throw AppError.notFound('integration.routing.unknown_operation', { operation });
          const actor = this.actors.require();
          if (input.connectors.length === 0) {
            await this.caps.clearOverride(scope, operation);
          } else {
            const problem = overrideProblem(operation, input.connectors, (code) =>
              Boolean(this.connectors.get(code)?.manifest.readOnly),
            );
            if (problem)
              throw new AppError(
                `integration.routing.${problem.toLowerCase()}`,
                HttpStatus.UNPROCESSABLE_ENTITY,
                { operation },
              );
            await this.caps.setOverride({
              id: newId(),
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              operation,
              connectors: [...input.connectors],
              updatedBy: isUuid(actor.id) ? actor.id : null,
            });
          }
          await this.caps.history({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            action: 'ROUTING_CHANGED',
            actorType: actor.type,
            actorId: actor.id,
            reference: `${operation}:${input.connectors.join(',') || 'STANDARD'}`,
          });
          await this.audit.record({
            action: 'integration.routing.change',
            entityType: 'property',
            entityId: scope.propertyId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { operation, connectors: input.connectors },
          });
          const decision = this.registry.decide(await this.registry.facts(scope), operation);
          return {
            operation,
            override: input.connectors.length ? input.connectors : null,
            route: decision.route,
          };
        }),
    );
  }

  private async verdict(scope: PropertyScope, capability: ConnectorCapability) {
    const facts = await this.registry.facts(scope);
    return this.registry.view(facts).find((v) => v.capability === capability)!;
  }

  private async instance(scope: PropertyScope, id: string) {
    const row = isUuid(id) ? await this.repo.instance(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('integration.instance.not_found');
    return row;
  }

  private async instanceSupporting(
    scope: PropertyScope,
    id: string,
    capability: ConnectorCapability,
  ) {
    const row = await this.instance(scope, id);
    if (!this.connectors.get(row.connectorCode)?.manifest.capabilities.includes(capability))
      throw new AppError(
        'integration.instance.capability_unsupported',
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          capabilities: capability,
        },
      );
    return row;
  }
}
