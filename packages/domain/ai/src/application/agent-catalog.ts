import { Injectable } from '@nestjs/common';
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
import { AiRepositories } from '../infrastructure/repositories';
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

/**
 * Agents and prompts (Spec §29–§30). Built-in definitions are published on first use: a version number not yet in the
 * database becomes the new published version and supersedes the previous one; published rows never change (trigger).
 * What runs is always read back from the database, so an execution names exactly the version it used.
 */
@Injectable()
export class AgentCatalog {
  private readonly cache = new Map<string, PublishedAgent>();

  constructor(
    private readonly repo: AiRepositories,
    private readonly tx: TransactionRunner,
  ) {}

  async published(code: string): Promise<PublishedAgent> {
    const cached = this.cache.get(code);
    if (cached) return cached;
    const builtIn = BUILT_IN_AGENTS.find((a) => a.code === code);
    if (!builtIn) throw AppError.notFound('ai.agent.not_found');
    const agent = await this.tx.run(() => this.ensure(builtIn));
    this.cache.set(code, agent);
    return agent;
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
      await this.repo.publishAgentVersion({
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
      });
    }
    const version = await this.repo.publishedAgentVersion(agentId);
    if (!version) throw AppError.notFound('ai.agent.not_found');
    const prompt = await this.repo.promptVersionById(version.promptVersionId);
    return {
      code: def.code,
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
