import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type ConnectorCapability, profileCoverage } from '@hotella/contracts-connectors';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { ConnectorRegistry } from '../connectors/registry';
import {
  COMMISSIONING_REQUIREMENTS,
  readiness,
  type ReadinessInstance,
  requirement,
  type RunCheck,
  runStatus,
  SHEET_STATUSES,
  type SheetStatus,
} from '../domain/commissioning';
import { CommissioningRepositories } from '../infrastructure/commissioning-repositories';
import { ProfileRepositories } from '../infrastructure/profile-repositories';
import { IntegrationRepositories } from '../infrastructure/repositories';
import { AgentQueryService } from './agent-query.service';
import { CapabilityRegistry } from './capability-registry';

export const sheetEntrySchema = z.object({
  status: z.enum(SHEET_STATUSES),
  /** What the hotel's sheet or system says (an interface setting, never guest data). */
  hotelValue: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
});
export const commissioningRunSchema = z.object({
  instanceId: z.uuid(),
  /** Known test records to look up (OWS/DB), e.g. the hotel's test reservation. */
  sample: z
    .object({
      confirmationNumber: z.string().trim().min(1).max(64).optional(),
      profileId: z.string().trim().min(1).max(128).optional(),
    })
    .optional(),
});

/** How long each verification read may wait for the hotel's agent. */
const RUN_QUERY_DEADLINE_MS = 15_000;

/**
 * Commissioning of a property's PMS integration (ADR-0019; guide §16, §20; BUILD_PLAN 10.9): the Interface Sheet
 * compared with the standard, verification runs against the hotel's agents, and the readiness checklist computed from
 * the registry, the sheet, the runs, the open exceptions and the last reconciliation. Installer/control-plane work;
 * every change is audited; only counts and reasons are kept, never guest data.
 */
@Injectable()
export class CommissioningService {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly repo: IntegrationRepositories,
    private readonly records: CommissioningRepositories,
    private readonly profiles: ProfileRepositories,
    private readonly connectors: ConnectorRegistry,
    private readonly agentQueries: AgentQueryService,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
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
          const [facts, sheet, runs, openExceptions, lastReconciliation] = await Promise.all([
            this.registry.facts(scope),
            this.records.currentSheet(scope),
            this.records.lastRuns(scope),
            this.records.openExceptions(scope),
            this.records.lastReconciliation(scope),
          ]);
          const runBy = new Map(runs.map((r) => [r.instanceId, r]));
          const sheetBy = new Map(sheet.map((r) => [r.requirement, r]));
          const instances = await Promise.all(
            facts.instances.map(async (i) => {
              const unverified = (i.manifest?.capabilities ?? []).filter(
                (c: ConnectorCapability) => {
                  const f = this.registry.factsFor(facts, i, c);
                  return f.supported && f.enabled && f.reported !== false && !f.verified;
                },
              );
              const profile = i.manifest?.profile;
              const coverage = profile
                ? profileCoverage(
                    profile,
                    (await this.profiles.forInstance(scope, i.row.id))
                      .filter((r) => r.profileCode === profile.code)
                      .map((r) => ({
                        record: r.record,
                        received: r.received,
                        fields: r.fields as Record<string, number>,
                        missingMandatory: r.missingMandatory,
                      })),
                  )
                : null;
              const run = runBy.get(i.row.id);
              return {
                id: i.row.id,
                connectorCode: i.row.connectorCode,
                name: i.row.name,
                status: i.row.status,
                health: i.health,
                licensed: i.licensed,
                commissionedAt: i.row.commissionedAt,
                unverified,
                lastRun: run
                  ? {
                      id: run.id,
                      status: run.status,
                      startedAt: run.startedAt,
                      checks: run.checks as RunCheck[],
                    }
                  : null,
                profileGaps: coverage
                  ? coverage
                      .filter((c) => !c.optional)
                      .map((c) => ({
                        record: c.record,
                        received: c.received,
                        gaps: c.gaps,
                        missingMandatory: c.missingMandatory,
                      }))
                  : null,
              };
            }),
          );
          const checklist = readiness({
            instances: instances.map((i): ReadinessInstance => ({
              connectorCode: i.connectorCode,
              active: i.status === 'ACTIVE',
              health: i.health,
              licensed: i.licensed,
              commissioned: Boolean(i.commissionedAt),
              unverified: i.unverified,
              lastRun: i.lastRun?.status ?? null,
            })),
            sheet: new Map(sheet.map((r) => [r.requirement, r.status as SheetStatus])),
            openExceptions,
            lastReconciliation,
          });
          return {
            ready: checklist.ready,
            checklist: checklist.items,
            sheet: COMMISSIONING_REQUIREMENTS.map((r) => {
              const current = sheetBy.get(r.code);
              return {
                requirement: r.code,
                scope: r.scope,
                required: r.required,
                capabilities: r.capabilities,
                current: current
                  ? {
                      status: current.status,
                      hotelValue: current.hotelValue,
                      note: current.note,
                      recordedAt: current.createdAt,
                    }
                  : null,
              };
            }),
            instances,
            openExceptions,
            lastReconciliation,
          };
        }),
    );
  }

  /** States one row of the Interface Sheet (appended: earlier statements stay as history). */
  recordSheet(scope: PropertyScope, code: string, input: z.infer<typeof sheetEntrySchema>) {
    return this.gate.execute(
      {
        action: 'integration.capability.verify',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          if (!requirement(code))
            throw AppError.notFound('integration.commissioning.unknown_requirement', {
              requirement: code,
            });
          const actor = this.actors.require();
          const row = await this.records.appendSheetRow({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            requirement: code,
            status: input.status,
            hotelValue: input.hotelValue || null,
            note: input.note || null,
            recordedByType: actor.type,
            recordedById: actor.id,
          });
          await this.audit.record({
            action: 'integration.commissioning.sheet',
            entityType: 'commissioning_sheet_row',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { requirement: code, status: input.status },
          });
          return {
            id: row.id,
            requirement: row.requirement,
            status: row.status,
            hotelValue: row.hotelValue,
            note: row.note,
            recordedAt: row.createdAt,
          };
        }),
    );
  }

  sheetHistory(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.records.sheetHistory(scope, 500)),
    );
  }

  runs(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.records.recentRuns(scope, 100)),
    );
  }

  /**
   * Verifies one connector instance against the hotel's agent (guide §16.3–§16.4): the predefined checks of its
   * connector, deterministic, each PASS / FAIL / SKIPPED with counts and reason codes. Reads run outside any
   * transaction (they wait for the agent); only the result is written.
   */
  run(scope: PropertyScope, input: z.infer<typeof commissioningRunSchema>) {
    return this.gate.execute(
      {
        action: 'integration.capability.verify',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      async () => {
        const actor = this.actors.require();
        const { instance, facts, reachable } = await this.tx.read(async () => {
          const row = isUuid(input.instanceId)
            ? await this.repo.instance(scope, input.instanceId)
            : undefined;
          if (!row || row.propertyId !== scope.propertyId)
            throw AppError.notFound('integration.instance.not_found');
          const all = await this.registry.facts(scope);
          return {
            instance: row,
            facts: all.instances.find((i) => i.row.id === row.id)!,
            reachable: await this.agentQueries.reachable(scope, row.id),
          };
        });
        const startedAt = new Date();
        const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
        const checks: RunCheck[] = [
          {
            code: 'AGENT_LINK',
            outcome: reachable ? 'PASS' : 'FAIL',
            detail: { reachable },
          },
          {
            code: 'HEALTH',
            outcome: facts.health === 'HEALTHY' ? 'PASS' : 'FAIL',
            detail: { health: facts.health },
          },
        ];
        const ask = async (
          code: string,
          queryType: string,
          params: Record<string, unknown>,
          expect: 'ANY' | 'SOME' | 'ONE',
        ) => {
          if (!this.registry.servesQuery(instance.connectorCode, queryType)) return;
          if (!reachable) {
            checks.push({ code, outcome: 'SKIPPED', detail: { reason: 'AGENT_UNREACHABLE' } });
            return;
          }
          const outcome = await this.agentQueries.run({
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: instance.id,
            connectorCode: instance.connectorCode,
            queryType,
            params,
            deadlineMs: RUN_QUERY_DEADLINE_MS,
            requestedBy: { type: actor.type, id: actor.id },
            routing: { commissioning: true },
          });
          if (outcome.status !== 'OK') {
            checks.push({ code, outcome: 'FAIL', detail: { status: outcome.status } });
            return;
          }
          // Rows are counted and dropped: a run keeps no guest data.
          const rows = outcome.rows.length;
          const pass = expect === 'ANY' || (expect === 'SOME' ? rows > 0 : rows === 1);
          checks.push({
            code,
            outcome: pass ? 'PASS' : 'FAIL',
            detail: { rows, ...(pass ? {} : { reason: rows === 0 ? 'NO_ROWS' : 'NOT_ONE' }) },
          });
        };
        const tomorrow = localDate(property?.timezone ?? 'UTC', 1);
        await ask('ROOM_INVENTORY', 'ROOM_INVENTORY', {}, 'SOME');
        await ask('ARRIVALS_TOMORROW', 'LIST_ARRIVALS', { from: tomorrow, to: tomorrow }, 'ANY');
        await ask('IN_HOUSE', 'IN_HOUSE', {}, 'ANY');
        if (input.sample?.confirmationNumber)
          await ask(
            'SAMPLE_RESERVATION',
            'LOOKUP_RESERVATION',
            { confirmation_number: input.sample.confirmationNumber },
            'ONE',
          );
        if (input.sample?.profileId)
          await ask(
            'SAMPLE_PROFILE',
            'LOOKUP_PROFILE',
            { profile_id: input.sample.profileId },
            'ONE',
          );
        const profile = facts.manifest?.profile;
        if (profile) {
          const coverage = profileCoverage(
            profile,
            (await this.tx.read(() => this.profiles.forInstance(scope, instance.id)))
              .filter((r) => r.profileCode === profile.code)
              .map((r) => ({
                record: r.record,
                received: r.received,
                fields: r.fields as Record<string, number>,
                missingMandatory: r.missingMandatory,
              })),
          );
          const guestRecords = coverage.filter((c) => ['GI', 'GO'].includes(c.record));
          const refused = coverage.reduce((n, c) => n + c.missingMandatory, 0);
          const missing = guestRecords.filter((c) => c.received === 0).map((c) => c.record);
          checks.push({
            code: 'PROFILE_COVERAGE',
            outcome: missing.length === 0 && refused === 0 ? 'PASS' : 'FAIL',
            detail: {
              records: coverage.reduce((n, c) => n + c.received, 0),
              refused,
              never_received: missing.join(',') || null,
              gaps: coverage.filter((c) => !c.optional).reduce((n, c) => n + c.gaps.length, 0),
            },
          });
        }
        const status = runStatus(checks);
        return this.tx.run(async () => {
          const row = await this.records.insertRun({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: instance.id,
            connectorCode: instance.connectorCode,
            status,
            checks,
            startedAt,
            finishedAt: new Date(),
            requestedByType: actor.type,
            requestedById: actor.id,
          });
          await this.audit.record({
            action: 'integration.commissioning.run',
            entityType: 'integration_instance',
            entityId: instance.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { connector: instance.connectorCode, status, run_id: row.id },
          });
          return {
            id: row.id,
            instanceId: instance.id,
            connectorCode: instance.connectorCode,
            status,
            checks,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
          };
        });
      },
    );
  }
}

/** The property's local calendar date, `days` from today (`YYYY-MM-DD`). */
export function localDate(timezone: string, days = 0, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now.getTime() + days * 86_400_000));
}
