import { describe, expect, it } from 'vitest';
import { decide } from './policy';

describe('AI autonomy decisions', () => {
  const concierge = { autoMediumTools: ['operations.create_service_request'] };
  const at = (risk: Parameters<typeof decide>[0]['risk'], tool = 'x.y', killed = false) =>
    decide({ tool, risk, autonomy: concierge, autoActionsKilled: killed }).decision;

  it('reads freely, acts on low risk, needs a person for high risk, never does critical', () => {
    expect(at('READ')).toBe('AUTO');
    expect(at('LOW')).toBe('AUTO');
    expect(at('HIGH')).toBe('PROPOSE');
    expect(at('CRITICAL')).toBe('REFUSE');
  });

  it('medium risk is automatic only for tools the agent version allows', () => {
    expect(at('MEDIUM', 'operations.create_service_request')).toBe('AUTO');
    expect(at('MEDIUM', 'task.escalate')).toBe('PROPOSE');
  });

  it('the auto-actions kill switch turns every action into a proposal, reading stays', () => {
    expect(at('READ', 'x.y', true)).toBe('AUTO');
    expect(at('LOW', 'x.y', true)).toBe('PROPOSE');
    expect(at('MEDIUM', 'operations.create_service_request', true)).toBe('PROPOSE');
    expect(at('CRITICAL', 'x.y', true)).toBe('REFUSE');
  });
});
