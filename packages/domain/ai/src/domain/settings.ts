import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';

/** Settings of the AI context (ADR-0018); registered by AiModule. External providers and spend are off by default. */
export const AI_EXTERNAL_PROVIDERS_ALLOWED = defineSetting<string[]>({
  key: 'ai.external_providers.allowed',
  scopes: ['PLATFORM'],
  schema: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)).max(20),
  default: [],
  descriptionKey: 'ai.setting.external_providers_allowed',
});
export const AI_EXTERNAL_PROVIDERS_ENABLED = defineSetting({
  key: 'ai.external_providers.enabled',
  scopes: ['PLATFORM', 'TENANT'],
  schema: z.boolean(),
  default: false,
  descriptionKey: 'ai.setting.external_providers_enabled',
});
/**
 * Monthly limit of external model spend per hotel, in minor units of the models' currency (0: no external spend). The
 * product owner set 100 USD per hotel per month (ADR-0018, Q8); a tenant or a property may set its own.
 */
export const AI_BUDGET_MONTHLY_LIMIT_MINOR = defineSetting({
  key: 'ai.budget.monthly_limit_minor',
  scopes: ['PLATFORM', 'TENANT', 'PROPERTY'],
  schema: z.number().int().min(0).max(100_000_000),
  default: 10_000,
  descriptionKey: 'ai.setting.budget_monthly_limit_minor',
});

/**
 * The share of an evaluation set's cases a candidate agent version must pass to be released (every critical case must
 * pass regardless, BUILD_PLAN 12.B). Platform-wide: agent versions are the platform's.
 */
export const AI_EVALUATION_MIN_PASS_RATE = defineSetting({
  key: 'ai.evaluation.min_pass_rate',
  scopes: ['PLATFORM'],
  schema: z.number().min(0.5).max(1),
  default: 0.9,
  descriptionKey: 'ai.setting.evaluation_min_pass_rate',
});

export const AI_SETTINGS = [
  AI_EXTERNAL_PROVIDERS_ALLOWED,
  AI_EXTERNAL_PROVIDERS_ENABLED,
  AI_BUDGET_MONTHLY_LIMIT_MINOR,
  AI_EVALUATION_MIN_PASS_RATE,
];

/** Kill switches (Spec §42) are feature flags: a flag set to on stops that path. */
export const killSwitch = {
  provider: (code: string) => `ai.kill.provider.${code.toLowerCase()}`,
  model: (code: string) => `ai.kill.model.${code.toLowerCase()}`,
  agent: (code: string) => `ai.kill.agent.${code.toLowerCase()}`,
  tool: (code: string) => `ai.kill.tool.${code.toLowerCase()}`,
  autoActions: 'ai.kill.auto_actions',
  guestAi: 'ai.kill.guest_ai',
};
