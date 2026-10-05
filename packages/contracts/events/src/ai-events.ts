import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * AI governance events (Spec §40, BUILD_PLAN 12.1): ids, codes and counts only — never a case's text or an answer.
 */
export const AiEvaluationCompleted = defineEvent({
  type: 'ai.evaluation.completed',
  version: 1,
  description: 'A regression evaluation of an agent version over one evaluation set finished.',
  payload: z.object({
    run_id: z.uuid(),
    set_id: z.uuid(),
    agent_code: z.string(),
    agent_version_id: z.uuid(),
    status: z.enum(['PASSED', 'FAILED', 'ERROR']),
    cases: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    errored: z.number().int().min(0),
  }),
});

export const AiAgentReleased = defineEvent({
  type: 'ai.agent.released',
  version: 1,
  description:
    'An agent version was released (active, shadow or canary) or a release was rolled back.',
  payload: z.object({
    release_id: z.uuid(),
    agent_code: z.string(),
    agent_version_id: z.uuid(),
    version_no: z.number().int().min(1),
    stage: z.enum(['SHADOW', 'CANARY', 'ACTIVE', 'ROLLED_BACK']),
    previous_version_id: z.uuid().nullable(),
    canary_percent: z.number().int().min(1).max(100).nullable(),
  }),
});
