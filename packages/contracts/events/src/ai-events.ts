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

const insightSeverity = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const insightStatus = z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED', 'EXPIRED']);

export const AiInsightRaised = defineEvent({
  type: 'ai.insight.raised',
  version: 1,
  description:
    'A deterministic detector raised a new insight at a property (BUILD_PLAN 12.4): detector, severity and confidence only.',
  payload: z.object({
    insight_id: z.uuid(),
    detector: z.string(),
    severity: insightSeverity,
    confidence: z.number().min(0).max(1),
  }),
});

export const AiInsightStatusChanged = defineEvent({
  type: 'ai.insight.status_changed',
  version: 1,
  description:
    'An insight was acknowledged, resolved, dismissed or expired (who acted is in the audit log).',
  payload: z.object({
    insight_id: z.uuid(),
    detector: z.string(),
    from: insightStatus,
    to: insightStatus,
  }),
});
