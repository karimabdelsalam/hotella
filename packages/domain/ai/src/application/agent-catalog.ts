import { Inject, Injectable, Optional } from '@nestjs/common';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import {
  BUILT_IN_AGENTS,
  type BuiltInAgent,
  type ContextProviderCode,
  type HandoffReason,
  type PromptLayer,
} from '../domain/agents';
import type { AutonomyPolicy } from '../domain/policy';
import { currentTrial, inCanary, type Trial } from '../domain/release';
import { EvaluationRepositories } from '../infrastructure/evaluation-repositories';
import { AiRepositories } from '../infrastructure/repositories';
import type { AgentVersionRow } from '../infrastructure/schema';
import type { Capability } from '../public';

/** The published version of an agent, as stored (what an execution runs). */
export interface PublishedAgent {
  readonly code: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly capability: Capability;
  readonly layers: readonly PromptLayer[];
  readonly tools: readonly string[];
  readonly context: {
    readonly providers: readonly ContextProviderCode[];
    readonly recentMessages: number;
  };
  readonly autonomy: AutonomyPolicy;
  readonly output: {
    readonly maxReplyChars: number;
    readonly handoffReasons: readonly HandoffReason[];
    readonly runtimeTools: readonly string[];
  };
  readonly maxSteps: number;
}

/** The agent definitions a deployment carries (tests add their own). */
export const AGENT_DEFINITIONS = Symbol.for('hotella.domain.ai.agent-definitions');

/** How long a process trusts its copy of the published version (a release elsewhere is seen within this). */
const CACHE_MS = 30_000;

/**
 * Agents and prompts (Spec §29–§30). Built-in definitions arrive with a deployment: an agent's first version is
 * published at once; a later version is kept as a **candidate** (DRAFT) and the published one keeps running until the
 * candidate passes its regression evaluation and is released (BUILD_PLAN 12.1). Published rows never change (trigger).
 * What runs is always read back from the database, so an execution names exactly the version it used.
 */
@Injectable()
export class AgentCatalog {
  private readonly cache = new Map<string, { agent: PublishedAgent; until: number }>();
  private readonly trials = new Map<string, { trial: Trial | null; until: number }>();

  constructor(
    private readonly repo: AiRepositories,
    private readonly versions: EvaluationRepositories,
    private readonly tx: TransactionRunner,
    @Optional()
    @Inject(AGENT_DEFINITIONS)
    private readonly definitions: readonly BuiltInAgent[] = BUILT_IN_AGENTS,
  ) {}

  async published(code: string): Promise<PublishedAgent> {
    const cached = this.cache.get(code);
    if (cached && cached.until > Date.now()) return cached.agent;
    const builtIn = this.definitions.find((a) => a.code === code);
    if (!builtIn) throw AppError.notFound('ai.agent.not_found');
    const agent = await this.tx.run(() => this.ensure(builtIn));
    this.cache.set(code, { agent, until: Date.now() + CACHE_MS });
    return agent;
  }

  /**
   * The version that answers a conversation (BUILD_PLAN 12.2): the published one, or the candidate when a canary is
   * running and the conversation falls in its share; with a shadow trial, also the version to run beside it (never
   * answering).
   */
  async select(
    code: string,
    conversationKey: string,
  ): Promise<{ readonly agent: PublishedAgent; readonly shadow: PublishedAgent | null }> {
    const agent = await this.published(code);
    const trial = await this.trial(code);
    if (trial?.stage === 'CANARY' && inCanary(conversationKey, trial.percent))
      return { agent: await this.atVersion(code, trial.versionId), shadow: null };
    if (trial?.stage === 'SHADOW')
      return { agent, shadow: await this.atVersion(code, trial.versionId) };
    return { agent, shadow: null };
  }

  private async trial(code: string): Promise<Trial | null> {
    const cached = this.trials.get(code);
    if (cached && cached.until > Date.now()) return cached.trial;
    const trial = currentTrial(await this.tx.read(() => this.versions.releases(code)));
    this.trials.set(code, { trial, until: Date.now() + CACHE_MS });
    return trial;
  }

  /** Any version of an agent (a candidate under evaluation, a superseded one), as it would run. */
  async atVersion(code: string, versionId: string): Promise<PublishedAgent> {
    await this.published(code);
    const version = await this.tx.read(() => this.versions.versionById(versionId));
    const agent = await this.tx.read(() => this.versions.agentByCode(code));
    if (!version || !agent || version.agentId !== agent.id)
      throw AppError.notFound('ai.agent.version_not_found');
    return this.tx.read(() => this.view(code, version));
  }

  /** Forgets the cached published versions (after a release in this process; they are re-read on next use). */
  invalidate(_code?: string): void {
    this.cache.clear();
    this.trials.clear();
  }

  /** The agent's definition as deployed (its kind decides how it is evaluated). */
  definition(code: string): BuiltInAgent | undefined {
    return this.definitions.find((a) => a.code === code);
  }

  list() {
    return this.tx.read(() => this.repo.listAgents());
  }

  private async ensure(def: BuiltInAgent): Promise<PublishedAgent> {
    const agentId = await this.repo.ensureAgent(def.code);
    if (!(await this.repo.agentVersion(agentId, def.versionNo))) {
      const promptId = await this.repo.ensurePrompt(def.code);
      if (!(await this.repo.promptVersion(promptId, def.prompt.versionNo)))
        await this.repo.publishPromptVersion({
          id: newId(),
          promptId,
          versionNo: def.prompt.versionNo,
          layers: def.prompt.layers,
        });
      const prompt = await this.repo.promptVersion(promptId, def.prompt.versionNo);
      const values = {
        id: newId(),
        agentId,
        versionNo: def.versionNo,
        capability: def.capability,
        promptVersionId: prompt!.id,
        toolCodes: [...def.tools],
        contextPolicy: def.context,
        autonomyPolicy: def.autonomy,
        outputContract: { ...def.output, runtimeTools: def.runtimeTools },
        maxSteps: def.maxSteps,
      };
      if (await this.repo.publishedAgentVersion(agentId))
        await this.versions.insertCandidate(values);
      else await this.repo.publishAgentVersion(values);
    }
    const version = await this.repo.publishedAgentVersion(agentId);
    if (!version) throw AppError.notFound('ai.agent.not_found');
    return this.view(def.code, version);
  }

  private async view(code: string, version: AgentVersionRow): Promise<PublishedAgent> {
    const prompt = await this.repo.promptVersionById(version.promptVersionId);
    return {
      code,
      versionId: version.id,
      versionNo: version.versionNo,
      capability: version.capability as Capability,
      layers: (prompt?.layers ?? []) as PromptLayer[],
      tools: version.toolCodes,
      context: version.contextPolicy as PublishedAgent['context'],
      autonomy: version.autonomyPolicy as AutonomyPolicy,
      output: version.outputContract as PublishedAgent['output'],
      maxSteps: version.maxSteps,
    };
  }
}
