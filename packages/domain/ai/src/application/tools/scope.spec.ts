import { describe, expect, it } from 'vitest';
import type { RequestActor } from '@hotella/platform-auth';
import {
  type AiExecutionScope,
  aiExecutionScope,
  AiPolicyStage,
  ScopedAgentAuthorizer,
} from './scope';

const agent: RequestActor = {
  type: 'AI_AGENT',
  id: 'exec-1',
  tenantId: 't1',
  isPlatformAdmin: false,
};
const scope = (over: Partial<AiExecutionScope> = {}): AiExecutionScope => ({
  executionId: 'exec-1',
  agentCode: 'guest_concierge',
  actorId: 'exec-1',
  tenantId: 't1',
  propertyId: 'p1',
  permissions: new Set(['request.create']),
  tool: 'operations.create_service_request',
  risk: 'MEDIUM',
  mode: 'AUTO',
  approvalId: null,
  ...over,
});
const request = { action: 'request.create', tenantId: 't1', propertyId: 'p1' };

describe('AI agents at the ActionGate', () => {
  const authorizer = new ScopedAgentAuthorizer();
  const stage = new AiPolicyStage();

  it('hold only the permissions of their tools, in their tenant and property, inside a tool call', async () => {
    const can = (permission: string, at = { tenantId: 't1', propertyId: 'p1' }) =>
      aiExecutionScope.run(scope(), () => authorizer.hasPermission(agent, permission, at));
    expect(await can('request.create')).toBe(true);
    expect(await can('request.manage')).toBe(false);
    expect(await can('request.create', { tenantId: 't2', propertyId: 'p1' })).toBe(false);
    expect(await can('request.create', { tenantId: 't1', propertyId: 'p2' })).toBe(false);
    // outside a tool call, or another agent's call: nothing
    expect(await authorizer.hasPermission(agent, 'request.create', request)).toBe(false);
    expect(
      await aiExecutionScope.run(scope({ actorId: 'exec-2' }), () =>
        authorizer.hasPermission(agent, 'request.create', request),
      ),
    ).toBe(false);
  });

  it('never do CRITICAL, do HIGH only once approved, never exceed the tool risk', async () => {
    const check = (s: AiExecutionScope, aiRisk?: 'LOW' | 'HIGH') =>
      aiExecutionScope.run(s, () => stage.check({ ...request, aiRisk }, agent));
    await expect(stage.check(request, agent)).rejects.toMatchObject({
      code: 'ai.policy.no_execution',
    });
    await expect(check(scope())).resolves.toBeUndefined();
    await expect(check(scope({ risk: 'CRITICAL', mode: 'APPROVED' }))).rejects.toMatchObject({
      code: 'ai.policy.critical',
    });
    await expect(check(scope({ risk: 'HIGH' }))).rejects.toMatchObject({
      code: 'ai.policy.approval_required',
    });
    await expect(check(scope({ risk: 'HIGH', mode: 'APPROVED' }))).resolves.toBeUndefined();
    await expect(check(scope({ risk: 'LOW' }), 'HIGH')).rejects.toMatchObject({
      code: 'ai.policy.risk_exceeded',
    });
  });
});
