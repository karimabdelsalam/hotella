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

/** Detector thresholds (BUILD_PLAN 12.4): a hotel may tune them; the detectors stay deterministic code. */
const days = z.number().int().min(1).max(90);
export const AI_INSIGHTS_RECURRING_FAILURE = defineSetting({
  key: 'ai.insights.recurring_failure',
  scopes: ['PLATFORM', 'TENANT', 'PROPERTY'],
  schema: z.object({ windowDays: days, minFailures: z.number().int().min(2).max(20) }),
  default: { windowDays: 30, minFailures: 3 },
  descriptionKey: 'ai.setting.insights_recurring_failure',
});
export const AI_INSIGHTS_SLA_CLUSTER = defineSetting({
  key: 'ai.insights.sla_cluster',
  scopes: ['PLATFORM', 'TENANT', 'PROPERTY'],
  schema: z.object({
    recentDays: days,
    baselineDays: days,
    minBreaches: z.number().int().min(1).max(100),
    factor: z.number().min(1).max(10),
  }),
  default: { recentDays: 7, baselineDays: 28, minBreaches: 3, factor: 2 },
  descriptionKey: 'ai.setting.insights_sla_cluster',
});
export const AI_INSIGHTS_REPEAT_COMPLAINT = defineSetting({
  key: 'ai.insights.repeat_complaint',
  scopes: ['PLATFORM', 'TENANT', 'PROPERTY'],
  schema: z.object({
    windowDays: days,
    minPerRoom: z.number().int().min(2).max(20),
    minPerCategory: z.number().int().min(2).max(50),
  }),
  default: { windowDays: 14, minPerRoom: 2, minPerCategory: 3 },
  descriptionKey: 'ai.setting.insights_repeat_complaint',
});
export const AI_INSIGHTS_SLOW_TURNAROUND = defineSetting({
  key: 'ai.insights.slow_turnaround',
  scopes: ['PLATFORM', 'TENANT', 'PROPERTY'],
  schema: z.object({
    windowDays: days,
    minSamples: z.number().int().min(2).max(100),
    factor: z.number().min(1).max(10),
  }),
  default: { windowDays: 14, minSamples: 5, factor: 1.5 },
  descriptionKey: 'ai.setting.insights_slow_turnaround',
});

/**
 * Cloud speech for a hotel (ADR-0025, owner decision Q22): guest voice audio is processed on Planova-operated
 * infrastructure only, unless the hotel approved an external speech provider — recorded here with who approved it and
 * when. Per property only; the external provider must also pass the platform allowlist and the tenant's opt-in.
 */
export const AI_SPEECH_EXTERNAL = defineSetting<
  | { enabled: false }
  | { enabled: true; approvedBy: string; approvedAt: string; reference?: string | undefined }
>({
  key: 'ai.speech.external',
  scopes: ['PROPERTY'],
  schema: z.discriminatedUnion('enabled', [
    z.object({ enabled: z.literal(false) }),
    z.object({
      enabled: z.literal(true),
      approvedBy: z.string().trim().min(2).max(120),
      approvedAt: z.iso.date(),
      reference: z.string().trim().max(120).optional(),
    }),
  ]),
  default: { enabled: false },
  descriptionKey: 'ai.setting.speech_external',
});

export const AI_SETTINGS = [
  AI_SPEECH_EXTERNAL,
  AI_EXTERNAL_PROVIDERS_ALLOWED,
  AI_EXTERNAL_PROVIDERS_ENABLED,
  AI_BUDGET_MONTHLY_LIMIT_MINOR,
  AI_EVALUATION_MIN_PASS_RATE,
  AI_INSIGHTS_RECURRING_FAILURE,
  AI_INSIGHTS_SLA_CLUSTER,
  AI_INSIGHTS_REPEAT_COMPLAINT,
  AI_INSIGHTS_SLOW_TURNAROUND,
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
