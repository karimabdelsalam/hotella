import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AiAgentReleased, AiEvaluationCompleted } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { QueueRegistry } from '@hotella/platform-queue';
import { SettingsReader } from '@hotella/platform-settings';
import { currentTrial } from '../domain/release';
import {
  caseInputSchema,
  expectationsSchema,
  grade,
  runPasses,
  toolFixturesSchema,
} from '../domain/evaluation';
import { AI_EVALUATION_MIN_PASS_RATE } from '../domain/settings';
import { EvaluationRepositories, type Viewer } from '../infrastructure/evaluation-repositories';
import { AiRepositories } from '../infrastructure/repositories';
import type {
  AgentReleaseRow,
  EvaluationCaseRow,
  EvaluationRunRow,
  EvaluationSetRow,
} from '../infrastructure/schema';
import {
  type ClassifiedText,
  type GatewayMessage,
  MODEL_GATEWAY,
  type ModelGatewayApi,
} from '../public';
import { AgentCatalog } from './agent-catalog';
import { agentKind, assistContract, conversationContract } from './agent-contracts';
import { runAgentLoop } from './agent-loop';
import { DryRunExecutor } from './tools/dry-run.executor';
import { ToolExecutor } from './tools/executor';
import { ToolRegistry } from './tools/registry';

/** The job that runs one evaluation run on `background-ai`. */
export const AI_EVALUATION_JOB = 'ai.evaluation.run';

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
export const createSetSchema = z.object({
  agentCode: code,
  code,
  name: z.string().trim().min(1).max(160),
});
export const updateSetSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});
export const createCaseSchema = z.object({
  code,
  critical: z.boolean().default(false),
  input: caseInputSchema,
  toolFixtures: toolFixturesSchema,
  expectations: expectationsSchema,
  /** Cases are synthetic: no real guest data, CONFIDENTIAL at most. */
  dataClass: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL']).default('INTERNAL'),
});
export const startEvaluationSchema = z.object({
  /** The property whose routing, budget and data region the model calls run under. */
  propertyId: z.uuid(),
  /** Default: every active set of the agent the caller can see (platform sets and the tenant's own). */
  setIds: z.array(z.uuid()).min(1).max(20).optional(),
});
export const publishSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });
export const releaseSchema = z
  .object({
    versionId: z.uuid(),
    stage: z.enum(['SHADOW', 'CANARY', 'ACTIVE']),
    /** CANARY only: the share of conversations (1–99) the candidate answers. */
    canaryPercent: z.number().int().min(1).max(99).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((r) => (r.stage === 'CANARY') === (r.canaryPercent !== undefined), {
    message: 'a canary needs its share, and only a canary has one',
    path: ['canaryPercent'],
  });
export const rollbackSchema = z.object({ reason: z.string().trim().min(1).max(500) });

/**
 * Agent evaluation and release (Spec §40, BUILD_PLAN 12.1). Evaluation sets hold synthetic cases; a run takes one set
 * through the real agent loop of one agent version with dry-run tools (nothing is written, nothing is proposed) and
 * deterministic graders. A candidate version (deployed while another is published) is released only when, for every
 * active platform set of its agent, its latest run on that exact version PASSED. Sets, runs and releases are audited;
 * cases are platform or tenant data visible to their owners only.
 */
@Injectable()
export class EvaluationService {
  constructor(
    private readonly repo: EvaluationRepositories,
    private readonly ai: AiRepositories,
    private readonly catalog: AgentCatalog,
    private readonly executor: ToolExecutor,
    private readonly registry: ToolRegistry,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly settings: SettingsReader,
    @Inject(MODEL_GATEWAY) private readonly gateway: ModelGatewayApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @InjectLogger() private readonly logger: Logger,
    @Optional() private readonly queues?: QueueRegistry,
  ) {}

  private viewer(): Viewer {
    return { tenantId: this.actors.require().tenantId };
  }

  private act<T>(action: string, tenantId: string | null, fn: () => Promise<T>, read = false) {
    return this.gate.execute({ action, tenantId }, () =>
      read ? this.tx.read(fn) : this.tx.run(fn),
    );
  }

  // ---- sets and cases ----

  listSets(agentCode?: string) {
    const viewer = this.viewer();
    return this.act(
      'ai.evaluation.read',
      viewer.tenantId,
      async () => (await this.repo.sets(viewer, agentCode)).map(setView),
      true,
    );
  }

  createSet(input: z.infer<typeof createSetSchema>) {
    const viewer = this.viewer();
    if (!this.catalog.definition(input.agentCode)) throw AppError.notFound('ai.agent.not_found');
    return this.act('ai.evaluation.manage', viewer.tenantId, async () => {
      const row = await this.repo
        .insertSet({ id: newId(), tenantId: viewer.tenantId, ...input })
        .catch((e: unknown) => {
          throw (e as { code?: string }).code === '23505' ||
            (e as { cause?: { code?: string } }).cause?.code === '23505'
            ? AppError.conflict('ai.evaluation.set_code_taken')
            : e;
        });
      await this.audit.record({
        action: 'ai.evaluation.set_create',
        entityType: 'ai_evaluation_set',
        entityId: row.id,
        tenantId: viewer.tenantId,
        after: { agentCode: row.agentCode, code: row.code },
      });
      return setView(row);
    });
  }

  getSet(id: string) {
    const viewer = this.viewer();
    return this.act(
      'ai.evaluation.read',
      viewer.tenantId,
      async () => {
        const set = await this.findSet(viewer, id);
        return { ...setView(set), cases: (await this.repo.cases(set.id)).map(caseView) };
      },
      true,
    );
  }

  updateSet(id: string, input: z.infer<typeof updateSetSchema>) {
    const viewer = this.viewer();
    return this.act('ai.evaluation.manage', viewer.tenantId, async () => {
      const set = await this.ownedSet(viewer, id);
      const row = await this.repo.updateSet(set.id, input.version, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
      });
      if (!row) throw AppError.conflict('ai.evaluation.version_conflict');
      await this.audit.record({
        action: 'ai.evaluation.set_update',
        entityType: 'ai_evaluation_set',
        entityId: set.id,
        tenantId: viewer.tenantId,
        before: { name: set.name, status: set.status },
        after: { name: row.name, status: row.status },
      });
      return setView(row);
    });
  }

  addCase(setId: string, input: z.infer<typeof createCaseSchema>) {
    const viewer = this.viewer();
    return this.act('ai.evaluation.manage', viewer.tenantId, async () => {
      const set = await this.ownedSet(viewer, setId);
      const row = await this.repo
        .insertCase({
          id: newId(),
          tenantId: set.tenantId,
          setId: set.id,
          code: input.code,
          critical: input.critical,
          input: input.input,
          toolFixtures: input.toolFixtures,
          expectations: input.expectations,
          dataClass: input.dataClass,
        })
        .catch((e: unknown) => {
          throw (e as { code?: string }).code === '23505' ||
            (e as { cause?: { code?: string } }).cause?.code === '23505'
            ? AppError.conflict('ai.evaluation.case_code_taken')
            : e;
        });
      await this.audit.record({
        action: 'ai.evaluation.case_add',
        entityType: 'ai_evaluation_set',
        entityId: set.id,
        tenantId: set.tenantId,
        after: { case: row.code, critical: row.critical },
      });
      return caseView(row);
    });
  }

  retireCase(setId: string, caseId: string) {
    const viewer = this.viewer();
    return this.act('ai.evaluation.manage', viewer.tenantId, async () => {
      const set = await this.ownedSet(viewer, setId);
      if (!isUuid(caseId) || !(await this.repo.retireCase(set.id, caseId)))
        throw AppError.notFound('ai.evaluation.case_not_found');
      await this.audit.record({
        action: 'ai.evaluation.case_retire',
        entityType: 'ai_evaluation_set',
        entityId: set.id,
        tenantId: set.tenantId,
        after: { caseId },
      });
    });
  }

  // ---- versions, runs ----

  /** An agent's versions with what runs (PUBLISHED), what waits (DRAFT: candidate) and what ran before. */
  versions(agentCode: string) {
    const viewer = this.viewer();
    return this.act(
      'ai.evaluation.read',
      viewer.tenantId,
      async () => {
        await this.catalog.published(agentCode).catch(() => {
          throw AppError.notFound('ai.agent.not_found');
        });
        const agent = await this.repo.agentByCode(agentCode);
        if (!agent) throw AppError.notFound('ai.agent.not_found');
        return (await this.repo.versionsOf(agent.id)).map((v) => ({
          id: v.id,
          versionNo: v.versionNo,
          status: v.status === 'DRAFT' ? 'CANDIDATE' : v.status,
          capability: v.capability,
          tools: v.toolCodes,
          publishedAt: v.publishedAt,
          createdAt: v.createdAt,
        }));
      },
      true,
    );
  }

  /** Starts one regression run per set on the version; each runs on `background-ai`. */
  async start(agentCode: string, versionId: string, input: z.infer<typeof startEvaluationSchema>) {
    const actor = this.actors.require();
    const tenantId = await this.org.findPropertyTenant(input.propertyId);
    if (!tenantId || (actor.tenantId !== null && actor.tenantId !== tenantId))
      throw AppError.notFound('org.property.not_found');
    if (!isUuid(versionId)) throw AppError.notFound('ai.agent.version_not_found');
    await this.catalog.atVersion(agentCode, versionId);
    const viewer = { tenantId: actor.tenantId };
    const runs = await this.gate.execute(
      { action: 'ai.evaluation.manage', tenantId, propertyId: input.propertyId },
      () =>
        this.tx.run(async () => {
          const visible = (await this.repo.sets(viewer, agentCode)).filter(
            (s) => s.status === 'ACTIVE' && (s.tenantId === null || s.tenantId === tenantId),
          );
          const sets = input.setIds
            ? input.setIds.map((id) => {
                const set = visible.find((s) => s.id === id);
                if (!set) throw AppError.notFound('ai.evaluation.set_not_found');
                return set;
              })
            : visible;
          if (sets.length === 0) throw AppError.conflict('ai.evaluation.no_sets');
          const out: EvaluationRunRow[] = [];
          for (const set of sets) {
            if ((await this.repo.cases(set.id)).length === 0)
              throw new AppError('ai.evaluation.set_empty', HttpStatus.CONFLICT, { set: set.code });
            out.push(
              await this.repo.insertRun({
                id: newId(),
                tenantId,
                propertyId: input.propertyId,
                setId: set.id,
                agentCode,
                agentVersionId: versionId,
                requestedByType: actor.type,
                requestedById: isUuid(actor.id) ? actor.id : null,
              }),
            );
          }
          await this.audit.record({
            action: 'ai.evaluation.start',
            entityType: 'ai_agent_version',
            entityId: versionId,
            tenantId,
            propertyId: input.propertyId,
            after: { agentCode, runs: out.map((r) => r.id), sets: sets.map((s) => s.code) },
          });
          return out;
        }),
    );
    for (const run of runs)
      await this.queues?.enqueue(
        'background-ai',
        AI_EVALUATION_JOB,
        { runId: run.id },
        { jobId: `evaluation-${run.id}` },
      );
    return runs.map(runView);
  }

  getRun(id: string) {
    const viewer = this.viewer();
    return this.act(
      'ai.evaluation.read',
      viewer.tenantId,
      async () => {
        const run = isUuid(id) ? await this.repo.run(viewer, id) : undefined;
        if (!run) throw AppError.notFound('ai.evaluation.run_not_found');
        const results = await this.repo.results(run.id);
        const cases = new Map(
          (await this.repo.casesByIds(results.flatMap((r) => (r.caseId ? [r.caseId] : [])))).map(
            (c) => [c.id, c],
          ),
        );
        return {
          ...runView(run),
          results: results.map((r) => ({
            case: r.caseId ? (cases.get(r.caseId)?.code ?? null) : null,
            critical: r.caseId ? (cases.get(r.caseId)?.critical ?? false) : false,
            outcome: r.outcome,
            checks: r.checks,
            executionId: r.executionId,
          })),
        };
      },
      true,
    );
  }

  /**
   * Runs every active case of the run's set through the agent version (the worker's job; idempotent: a finished run is
   * left as it is). The model calls go through the Model Gateway under the run's tenant and property.
   */
  async execute(runId: string): Promise<EvaluationRunRow['status'] | null> {
    const run = await this.tx.read(() => this.repo.run({ tenantId: null }, runId));
    if (!run || run.status !== 'RUNNING' || run.mode !== 'REGRESSION' || !run.setId)
      return run?.status ?? null;
    const setId = run.setId;
    const cases = await this.tx.read(() => this.repo.cases(setId));
    const minPassRate = await this.settings.value(AI_EVALUATION_MIN_PASS_RATE, {});
    const graded: Array<{ critical: boolean; outcome: 'PASS' | 'FAIL' | 'ERROR' }> = [];
    let cost = 0;
    for (const c of cases) {
      const result = await this.runCase(run, c);
      cost += result.costMinor;
      graded.push({ critical: c.critical, outcome: result.outcome });
      await this.tx.run(() =>
        this.repo.insertResult({
          id: newId(),
          tenantId: run.tenantId,
          runId: run.id,
          caseId: c.id,
          outcome: result.outcome,
          checks: result.checks,
          executionId: result.executionId,
        }),
      );
    }
    const count = (o: string) => graded.filter((g) => g.outcome === o).length;
    const totals = {
      cases: graded.length,
      passed: count('PASS'),
      failed: count('FAIL'),
      errored: count('ERROR'),
      critical_failed: graded.filter((g) => g.critical && g.outcome !== 'PASS').length,
      min_pass_rate: minPassRate,
    };
    const status: 'PASSED' | 'FAILED' | 'ERROR' =
      graded.length > 0 && totals.errored === graded.length
        ? 'ERROR'
        : runPasses(graded, minPassRate)
          ? 'PASSED'
          : 'FAILED';
    await this.tx.run(async () => {
      await this.repo.finishRun(run.id, { status, totals, costMinor: cost });
      await this.events.publish(AiEvaluationCompleted, {
        tenantId: run.tenantId,
        propertyId: run.propertyId,
        source: 'ai',
        aggregate: { type: 'ai_evaluation_run', id: run.id },
        payload: {
          run_id: run.id,
          set_id: setId,
          agent_code: run.agentCode,
          agent_version_id: run.agentVersionId,
          status,
          cases: totals.cases,
          passed: totals.passed,
          failed: totals.failed,
          errored: totals.errored,
        },
      });
    });
    return status;
  }

  private async runCase(
    run: EvaluationRunRow,
    c: EvaluationCaseRow,
  ): Promise<{
    outcome: 'PASS' | 'FAIL' | 'ERROR';
    checks: unknown[];
    executionId: string | null;
    costMinor: number;
  }> {
    let executionId: string | null = null;
    try {
      const input = caseInputSchema.parse(c.input);
      const expectations = expectationsSchema.parse(c.expectations);
      const fixtures = toolFixturesSchema.parse(c.toolFixtures);
      const agent = await this.catalog.atVersion(run.agentCode, run.agentVersionId);
      const kind = agentKind(run.agentCode, this.catalog.definition(run.agentCode));
      const contract =
        kind === 'ASSIST'
          ? assistContract(agent, input.locale)
          : conversationContract(agent, input.locale);
      const handle = await this.executor.start({
        tenantId: run.tenantId,
        propertyId: run.propertyId,
        agentCode: agent.code,
        agentVersionId: agent.versionId,
        tools: agent.tools,
        autonomy: agent.autonomy,
        locale: input.locale,
        guest: null,
        conversationId: null,
        trigger: 'EVALUATION',
        on: { type: run.requestedByType as 'USER', id: run.requestedById },
      });
      executionId = handle.id;
      const dataClass = c.dataClass as 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL';
      const system: ClassifiedText[] = [
        ...contract.system,
        ...input.context.map((part) => ({
          text: `<context name="${part.name}">\n${part.text}\n</context>`,
          dataClass: part.dataClass,
        })),
      ];
      const history: GatewayMessage[] = input.turns.map((t) =>
        t.from === 'person'
          ? { role: 'user', content: t.text, dataClass }
          : { role: 'assistant', content: t.text, dataClass },
      );
      // A model that could not be reached is an error of the run, not a failure of the version.
      let unavailable: string | null = null;
      const gateway: ModelGatewayApi = {
        complete: (request) =>
          this.gateway.complete(request).catch((e: unknown) => {
            unavailable = e instanceof AppError ? e.code : 'ai.gateway.unavailable';
            throw e;
          }),
        embed: (request) => this.gateway.embed(request),
        transcribe: (request) => this.gateway.transcribe(request),
        synthesize: (request) => this.gateway.synthesize(request),
      };
      const dry = new DryRunExecutor(this.executor, this.registry, fixtures);
      const answer = await runAgentLoop(
        { gateway, executor: dry, registry: this.registry },
        {
          handle,
          agent,
          system,
          history,
          output: contract.output as never,
          parse: contract.parse as never,
          describe: contract.describe as never,
        },
      );
      await this.executor.finish(handle, answer ? 'COMPLETED' : 'FAILED');
      const execution = await this.tx.read(() =>
        this.ai.execution({ tenantId: run.tenantId }, handle.id),
      );
      const costMinor = execution?.costMinor ?? 0;
      if (unavailable && !answer)
        return {
          outcome: 'ERROR',
          checks: [{ expectation: 'RUN', outcome: 'FAIL', detail: unavailable }],
          executionId,
          costMinor,
        };
      const graded = grade(expectations, {
        toolCalls: dry.calls,
        answer: answer
          ? (contract.answerOf as (a: unknown) => { text: string; handoff: string | null })(answer)
          : null,
      });
      return { outcome: graded.outcome, checks: [...graded.checks], executionId, costMinor };
    } catch (e) {
      this.logger.warn({ err: e, run_id: run.id, case: c.code }, 'evaluation case errored');
      return {
        outcome: 'ERROR',
        checks: [
          {
            expectation: 'RUN',
            outcome: 'FAIL',
            detail: e instanceof AppError ? e.code : 'ai.evaluation.case_invalid',
          },
        ],
        executionId,
        costMinor: 0,
      };
    }
  }

  // ---- releases ----

  /** Releases a candidate straight to ACTIVE (kept as the 12.1 endpoint). */
  publish(agentCode: string, versionId: string, input: z.infer<typeof publishSchema>) {
    return this.release(agentCode, { versionId, stage: 'ACTIVE', reason: input.reason });
  }

  /**
   * Releases a candidate version (BUILD_PLAN 12.B/12.2): for every active platform set of the agent the latest
   * regression run of this exact version passed. ACTIVE makes it the version that runs (the previous one is superseded,
   * never edited); SHADOW runs it beside the active version on live conversations without answering or acting; CANARY
   * answers a fixed share of conversations with it. Every release is recorded (append-only), audited and announced.
   */
  release(agentCode: string, input: z.infer<typeof releaseSchema>) {
    const actor = this.actors.require();
    return this.act('ai.agent.release', null, async () => {
      const agent = await this.repo.agentByCode(agentCode);
      const version = isUuid(input.versionId)
        ? await this.repo.versionById(input.versionId)
        : undefined;
      if (!agent || !version || version.agentId !== agent.id)
        throw AppError.notFound('ai.agent.version_not_found');
      if (version.status !== 'DRAFT') throw AppError.conflict('ai.agent.not_a_candidate');
      if (
        input.stage !== 'ACTIVE' &&
        agentKind(agentCode, this.catalog.definition(agentCode)) !== 'CONVERSATION'
      )
        throw AppError.conflict('ai.agent.trial_not_supported');
      const used = await this.passedRuns(agentCode, version.id);
      const previous = (await this.repo.versionsOf(agent.id)).find((v) => v.status === 'PUBLISHED');
      if (input.stage === 'ACTIVE') {
        const promoted = await this.repo.promote(agent.id, version.id);
        if (!promoted) throw AppError.conflict('ai.agent.not_a_candidate');
        await this.closeShadowRuns(version.id);
      }
      const release = await this.repo.insertRelease({
        id: newId(),
        tenantId: null,
        agentCode,
        agentVersionId: version.id,
        stage: input.stage,
        canaryPercent: input.stage === 'CANARY' ? (input.canaryPercent ?? null) : null,
        previousVersionId: previous?.id ?? null,
        runIds: used,
        actorType: actor.type,
        actorId: isUuid(actor.id) ? actor.id : null,
        reason: input.reason ?? null,
      });
      await this.announce(release, version.versionNo, input.reason, {
        before: { versionId: previous?.id ?? null, versionNo: previous?.versionNo ?? null },
        after: {
          versionId: version.id,
          versionNo: version.versionNo,
          stage: input.stage,
          canaryPercent: release.canaryPercent,
          runs: used,
        },
      });
      return {
        releaseId: release.id,
        agentCode,
        versionId: version.id,
        versionNo: version.versionNo,
        stage: input.stage,
        canaryPercent: release.canaryPercent,
        previousVersionId: previous?.id ?? null,
      };
    });
  }

  /**
   * Rollback (BUILD_PLAN 12.2): a shadow or canary trial in progress ends; otherwise the last ACTIVE release is undone
   * and the version it replaced runs again. Either way a ROLLED_BACK release is recorded, audited and announced.
   */
  rollback(agentCode: string, input: z.infer<typeof rollbackSchema>) {
    const actor = this.actors.require();
    return this.act('ai.agent.release', null, async () => {
      const agent = await this.repo.agentByCode(agentCode);
      if (!agent) throw AppError.notFound('ai.agent.not_found');
      const history = await this.repo.releases(agentCode);
      const versions = await this.repo.versionsOf(agent.id);
      const current = versions.find((v) => v.status === 'PUBLISHED');
      const trial = currentTrial(history);
      let rolledBack: string;
      let reinstated: string | null = null;
      if (trial) {
        rolledBack = trial.versionId;
        await this.closeShadowRuns(trial.versionId);
      } else {
        const lastActive = history.find((r) => r.stage === 'ACTIVE');
        if (!lastActive?.previousVersionId || lastActive.agentVersionId !== current?.id)
          throw AppError.conflict('ai.agent.nothing_to_roll_back');
        if (!(await this.repo.reinstate(agent.id, lastActive.previousVersionId)))
          throw AppError.conflict('ai.agent.nothing_to_roll_back');
        rolledBack = lastActive.agentVersionId;
        reinstated = lastActive.previousVersionId;
      }
      const version = versions.find((v) => v.id === rolledBack)!;
      const release = await this.repo.insertRelease({
        id: newId(),
        tenantId: null,
        agentCode,
        agentVersionId: rolledBack,
        stage: 'ROLLED_BACK',
        previousVersionId: reinstated,
        actorType: actor.type,
        actorId: isUuid(actor.id) ? actor.id : null,
        reason: input.reason,
      });
      await this.announce(release, version.versionNo, input.reason, {
        before: { versionId: current?.id ?? null, trial: trial?.stage ?? null },
        after: { versionId: reinstated ?? current?.id ?? null, rolledBack },
      });
      return {
        releaseId: release.id,
        agentCode,
        rolledBackVersionId: rolledBack,
        activeVersionId: reinstated ?? current?.id ?? null,
      };
    });
  }

  /** The passed run of each active platform set on this exact version (the release gate). */
  private async passedRuns(agentCode: string, versionId: string): Promise<string[]> {
    const sets = await this.repo.activePlatformSets(agentCode);
    if (sets.length === 0) throw AppError.conflict('ai.evaluation.no_sets');
    const runs = await this.repo.runsOfVersion(versionId);
    const used: string[] = [];
    for (const set of sets) {
      const latest = runs.find(
        (r) => r.setId === set.id && r.mode === 'REGRESSION' && r.status !== 'RUNNING',
      );
      if (latest?.status !== 'PASSED')
        throw new AppError('ai.evaluation.not_passed', HttpStatus.CONFLICT, { set: set.code });
      used.push(latest.id);
    }
    return used;
  }

  /** A trial ended: its open shadow runs close with what they found. */
  private async closeShadowRuns(versionId: string): Promise<void> {
    for (const run of await this.repo.openShadowRunsOf(versionId)) {
      const totals = run.totals as { failed?: number; errored?: number };
      await this.repo.finishRun(run.id, {
        status: (totals.failed ?? 0) + (totals.errored ?? 0) > 0 ? 'FAILED' : 'PASSED',
        totals: run.totals,
        costMinor: run.costMinor,
      });
    }
  }

  private async announce(
    release: AgentReleaseRow,
    versionNo: number,
    reason: string | undefined,
    change: { before: Record<string, unknown>; after: Record<string, unknown> },
  ): Promise<void> {
    await this.audit.record({
      action: release.stage === 'ROLLED_BACK' ? 'ai.agent.rollback' : 'ai.agent.release',
      entityType: 'ai_agent_version',
      entityId: release.agentVersionId,
      tenantId: null,
      reason,
      ...change,
    });
    await this.events.publish(AiAgentReleased, {
      tenantId: null,
      propertyId: null,
      source: 'ai',
      aggregate: { type: 'ai_agent_release', id: release.id },
      payload: {
        release_id: release.id,
        agent_code: release.agentCode,
        agent_version_id: release.agentVersionId,
        version_no: versionNo,
        stage: release.stage,
        previous_version_id: release.previousVersionId,
        canary_percent: release.canaryPercent,
      },
    });
    this.catalog.invalidate(release.agentCode);
  }

  /** The runs of a version (regression and shadow) the caller may see, newest first. */
  runsOf(agentCode: string, versionId: string) {
    const viewer = this.viewer();
    return this.act(
      'ai.evaluation.read',
      viewer.tenantId,
      async () => {
        if (!isUuid(versionId)) throw AppError.notFound('ai.agent.version_not_found');
        return (await this.repo.runsOfVersion(versionId))
          .filter(
            (r) =>
              r.agentCode === agentCode &&
              (viewer.tenantId === null || r.tenantId === viewer.tenantId),
          )
          .map(runView);
      },
      true,
    );
  }

  releases(agentCode: string) {
    const viewer = this.viewer();
    return this.act(
      'ai.evaluation.read',
      viewer.tenantId,
      async () =>
        (await this.repo.releases(agentCode)).map((r) => ({
          id: r.id,
          versionId: r.agentVersionId,
          stage: r.stage,
          canaryPercent: r.canaryPercent,
          previousVersionId: r.previousVersionId,
          runIds: r.runIds,
          reason: r.reason,
          at: r.createdAt,
        })),
      true,
    );
  }

  // ---- helpers ----

  private async findSet(viewer: Viewer, id: string): Promise<EvaluationSetRow> {
    const set = isUuid(id) ? await this.repo.set(viewer, id) : undefined;
    if (!set) throw AppError.notFound('ai.evaluation.set_not_found');
    return set;
  }

  /** A set the caller may change: their tenant's own, or a platform set for platform callers. */
  private async ownedSet(viewer: Viewer, id: string): Promise<EvaluationSetRow> {
    const set = await this.findSet(viewer, id);
    if (set.tenantId !== viewer.tenantId) throw AppError.notFound('ai.evaluation.set_not_found');
    return set;
  }
}

function setView(s: EvaluationSetRow) {
  return {
    id: s.id,
    scope: s.tenantId === null ? ('PLATFORM' as const) : ('TENANT' as const),
    agentCode: s.agentCode,
    code: s.code,
    name: s.name,
    status: s.status,
    version: s.version,
  };
}

function caseView(c: EvaluationCaseRow) {
  return {
    id: c.id,
    code: c.code,
    critical: c.critical,
    input: c.input,
    toolFixtures: c.toolFixtures,
    expectations: c.expectations,
    dataClass: c.dataClass,
    status: c.status,
  };
}

function runView(r: EvaluationRunRow) {
  return {
    id: r.id,
    setId: r.setId,
    agentCode: r.agentCode,
    agentVersionId: r.agentVersionId,
    propertyId: r.propertyId,
    mode: r.mode,
    status: r.status,
    totals: r.totals,
    costMinor: r.costMinor,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}
