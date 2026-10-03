import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { FeatureFlagService } from '@hotella/platform-flags';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { SecretResolver } from '@hotella/platform-secrets';
import { SettingsReader } from '@hotella/platform-settings';
import { applyEgress, type EgressPolicy, maskIdentifiers, mayReceive } from '../domain/egress';
import { estimateCostMinor, pickRule } from '../domain/routing';
import {
  AI_BUDGET_MONTHLY_LIMIT_MINOR,
  AI_EXTERNAL_PROVIDERS_ALLOWED,
  AI_EXTERNAL_PROVIDERS_ENABLED,
  killSwitch,
} from '../domain/settings';
import { AiRepositories } from '../infrastructure/repositories';
import type { ModelRow, ProviderRow } from '../infrastructure/schema';
import type {
  ClassifiedText,
  GatewayCompletion,
  GatewayCompletionInput,
  GatewayMessage,
  ModelGatewayApi,
} from '../public';
import { ModelProviderRegistry } from './provider-registry';
import {
  type ChatMessage,
  type CompletionResult,
  ModelProviderError,
  type ProviderContext,
} from './providers/types';

interface Candidate {
  readonly model: ModelRow;
  readonly provider: ProviderRow;
  readonly policy: EgressPolicy;
}

/**
 * The Model Gateway (Spec §28, ADR-0018). Resolves a capability to the ordered models of the most specific routing
 * rule, skips what kill switches, egress settings or the budget forbid, applies the egress policy to the content,
 * calls the provider and falls back on retryable failures. Every attempt is recorded in `ai.model_calls`.
 */
@Injectable()
export class ModelGatewayService implements ModelGatewayApi {
  constructor(
    private readonly repo: AiRepositories,
    private readonly providers: ModelProviderRegistry,
    private readonly flags: FeatureFlagService,
    private readonly settings: SettingsReader,
    private readonly tx: TransactionRunner,
    private readonly ctx: RequestContext,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(SecretResolver) private readonly secrets?: SecretResolver,
  ) {}

  async complete(input: GatewayCompletionInput): Promise<GatewayCompletion> {
    const candidates = await this.candidates(
      input.tenantId,
      input.propertyId ?? null,
      input.capability,
    );
    let previous: string | null = null;
    let lastError: ModelProviderError | null = null;
    for (const c of candidates) {
      const adapter = this.providers.get(c.provider.kind);
      if (!adapter) continue;
      const { messages, dropped } = this.prepare(c.policy, input.system, input.messages);
      const started = Date.now();
      try {
        const result = await adapter.complete(this.context(c.provider), {
          model: c.model.code,
          messages,
          tools: input.tools,
          jsonSchema: input.jsonSchema ?? null,
          maxTokens: input.maxTokens,
        });
        const callId = await this.record(
          input,
          c,
          result,
          Date.now() - started,
          'OK',
          previous,
          dropped,
        );
        return {
          content: result.content,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
          provider: c.provider.code,
          model: c.model.code,
          modelCallId: callId,
          costMinor: cost(c.model, result.usage),
          fallbackFrom: previous,
        };
      } catch (e) {
        const err =
          e instanceof ModelProviderError ? e : new ModelProviderError('UNAVAILABLE', true);
        await this.record(input, c, null, Date.now() - started, err.code, previous, dropped);
        this.logger.warn(
          { provider: c.provider.code, model: c.model.code, code: err.code },
          'model call failed',
        );
        lastError = err;
        previous = c.model.code;
        if (!err.retryable && err.code !== 'AUTH_FAILED') break;
      }
    }
    throw new AppError('ai.gateway.unavailable', HttpStatus.SERVICE_UNAVAILABLE, {
      reason: lastError?.code ?? 'NO_ROUTE',
    });
  }

  async embed(input: {
    tenantId: string;
    propertyId?: string | null;
    texts: readonly ClassifiedText[];
  }): Promise<{ vectors: readonly (readonly number[])[]; model: string }> {
    const candidates = await this.candidates(input.tenantId, input.propertyId ?? null, 'EMBEDDING');
    for (const c of candidates) {
      const adapter = this.providers.get(c.provider.kind);
      if (!adapter?.embed) continue;
      // Every text must be allowed: an embedding cannot leave a part out.
      if (!input.texts.every((t) => mayReceive(c.policy, t.dataClass))) continue;
      const texts = input.texts.map((t) =>
        c.policy.egress === 'EXTERNAL' ? maskIdentifiers(t.text) : t.text,
      );
      const started = Date.now();
      try {
        const result = await adapter.embed(this.context(c.provider), {
          model: c.model.code,
          inputs: texts,
        });
        await this.record(
          { tenantId: input.tenantId, propertyId: input.propertyId, capability: 'EMBEDDING' },
          c,
          { content: null, toolCalls: [], finishReason: 'stop', usage: result.usage },
          Date.now() - started,
          'OK',
          null,
          0,
        );
        return { vectors: result.vectors, model: c.model.code };
      } catch (e) {
        const code = e instanceof ModelProviderError ? e.code : 'UNAVAILABLE';
        await this.record(
          { tenantId: input.tenantId, propertyId: input.propertyId, capability: 'EMBEDDING' },
          c,
          null,
          Date.now() - started,
          code,
          null,
          0,
        );
      }
    }
    throw new AppError('ai.gateway.unavailable', HttpStatus.SERVICE_UNAVAILABLE, {
      reason: 'NO_ROUTE',
    });
  }

  /** The routed models that may be used now, in order. */
  private async candidates(
    tenantId: string,
    propertyId: string | null,
    capability: string,
  ): Promise<Candidate[]> {
    const rule = pickRule(
      await this.tx.read(() => this.repo.rulesFor(tenantId, propertyId)),
      capability,
      {
        tenantId,
        propertyId,
      },
    );
    if (!rule) return [];
    const rows = await this.tx.read(() => this.repo.modelsWithProviders(rule.modelIds));
    const at = { tenantId, propertyId };
    let externalOk: boolean | null = null;
    const out: Candidate[] = [];
    for (const id of rule.modelIds) {
      const row = rows.find((r) => r.model.id === id);
      if (!row) continue;
      const { model, provider } = row;
      if (model.status !== 'ACTIVE' || provider.status !== 'ACTIVE') continue;
      if (!model.capabilities.includes(capability)) continue;
      if (
        (await this.flags.isEnabled(killSwitch.provider(provider.code), at)) ||
        (await this.flags.isEnabled(killSwitch.model(model.code), at))
      )
        continue;
      if (provider.egress === 'EXTERNAL') {
        externalOk ??= await this.externalAllowed(tenantId, propertyId);
        if (!externalOk) continue;
        const allowed = await this.settings.value(AI_EXTERNAL_PROVIDERS_ALLOWED, {});
        if (!allowed.includes(provider.code)) continue;
      }
      out.push({
        model,
        provider,
        policy: { egress: provider.egress, maxDataClass: provider.maxDataClass },
      });
    }
    return out;
  }

  /**
   * External providers need the tenant's opt-in and budget left this month (ADR-0018). The budget is per hotel: a call
   * for a property counts that property's spend against its limit; a call without one counts the tenant's.
   */
  private async externalAllowed(tenantId: string, propertyId: string | null): Promise<boolean> {
    if (!(await this.settings.value(AI_EXTERNAL_PROVIDERS_ENABLED, { tenantId }))) return false;
    const limit = await this.settings.value(AI_BUDGET_MONTHLY_LIMIT_MINOR, {
      tenantId,
      propertyId,
    });
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const spent = await this.tx.read(() =>
      this.repo.externalSpendSince({ tenantId }, month, propertyId),
    );
    if (spent < limit) return true;
    if (limit > 0 && propertyId)
      await this.ops
        .raiseAlert({
          tenantId,
          propertyId,
          type: 'AI_BUDGET_EXHAUSTED',
          severity: 'WARNING',
          dedupeKey: `ai-budget:${propertyId}:${month.toISOString().slice(0, 7)}`,
          evidence: { limit_minor: limit, spent_minor: spent },
        })
        .catch(() => undefined);
    return false;
  }

  /** The conversation as this provider may see it (ADR-0018). */
  private prepare(
    policy: EgressPolicy,
    system: readonly ClassifiedText[],
    messages: readonly GatewayMessage[],
  ): { messages: ChatMessage[]; dropped: number } {
    const parts = applyEgress(policy, system);
    let dropped = parts.dropped;
    const text = (content: string, dataClass: GatewayMessage['dataClass']) => {
      if (!mayReceive(policy, dataClass)) {
        dropped++;
        return '[withheld]';
      }
      return policy.egress === 'EXTERNAL' ? maskIdentifiers(content) : content;
    };
    const out: ChatMessage[] = [];
    if (parts.kept.length) out.push({ role: 'system', content: parts.kept.join('\n\n') });
    for (const m of messages) {
      if (m.role === 'user') out.push({ role: 'user', content: text(m.content, m.dataClass) });
      else if (m.role === 'tool')
        out.push({ role: 'tool', toolCallId: m.toolCallId, content: text(m.content, m.dataClass) });
      else
        out.push({
          role: 'assistant',
          content: m.content === null ? null : text(m.content, m.dataClass),
          ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
        });
    }
    return { messages: out, dropped };
  }

  private context(provider: ProviderRow): ProviderContext {
    const ref = provider.credentialRef;
    return {
      providerCode: provider.code,
      baseUrl: provider.baseUrl,
      credential: async () => (ref && this.secrets ? this.secrets.resolve(ref) : null),
    };
  }

  private async record(
    input: Pick<
      GatewayCompletionInput,
      'tenantId' | 'propertyId' | 'capability' | 'executionId' | 'agentCode'
    >,
    c: Candidate,
    result: CompletionResult | null,
    latencyMs: number,
    outcome: string,
    fallbackFrom: string | null,
    dropped: number,
  ): Promise<string> {
    const id = newId();
    const usage = result?.usage ?? { input: 0, output: 0, cached: 0 };
    await this.tx.run(() =>
      this.repo.insertCall({
        id,
        tenantId: input.tenantId,
        propertyId: input.propertyId ?? null,
        executionId: input.executionId ?? null,
        agentCode: input.agentCode ?? null,
        capability: input.capability,
        providerCode: c.provider.code,
        modelCode: c.model.code,
        egress: c.provider.egress,
        tokensIn: usage.input,
        tokensOut: usage.output,
        tokensCached: usage.cached,
        latencyMs,
        costMinor: cost(c.model, usage),
        currency: c.model.currency,
        fallbackFrom,
        outcome,
        droppedParts: dropped,
        correlationId: this.ctx.correlationId ?? null,
      }),
    );
    return id;
  }
}

function cost(model: ModelRow, usage: { input: number; output: number; cached: number }): number {
  return estimateCostMinor(usage, {
    inputPerMillionMinor: model.inputPerMillionMinor,
    outputPerMillionMinor: model.outputPerMillionMinor,
    cachedPerMillionMinor: model.cachedPerMillionMinor,
  });
}
