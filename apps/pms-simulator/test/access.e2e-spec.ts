import 'reflect-metadata';
import { ACCESS_API, type AccessPublicApi } from '@hotella/domain-integrations/public';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentLinkClient, DurableQueue, enroll, SimulatedAccessSystems } from '../src';
import { type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

const stamp = Date.now().toString(36).toUpperCase();

/**
 * Stay-bound access over the real link (BUILD_PLAN 13.3): a lock agent enrolls, the platform asks it to encode and
 * revoke keys as signed commands, and its answers decide the grants. The key itself never leaves the lock system.
 */
describe.skipIf(needsInfra())(`room keys through a lock agent (${infraSkipReason()})`, () => {
  let h: GatewayHarness;
  let client: AgentLinkClient;
  const locks = new SimulatedAccessSystems();
  const stayId = newId();
  const roomId = newId();
  let access: AccessPublicApi;
  const run = <T>(fn: () => Promise<T>) => h.app.get(TransactionRunner).run(fn);
  const grant = (id: string) =>
    run(async () => (await access.listForStay(h.tenant, stayId)).find((g) => g.id === id));
  const issue = (roomNumber: string) =>
    run(() =>
      access.issue({
        tenantId: h.tenant,
        propertyId: h.property,
        stayId,
        kind: 'KEY',
        roomId,
        roomNumber,
        validUntil: new Date(Date.now() + 86_400_000),
        requestedBy: { type: 'SYSTEM', id: null },
      }),
    );

  beforeAll(async () => {
    h = await startGatewayHarness(readTestInfra().databaseUrl!, `lock-${stamp}`, {
      connectorCode: 'LOCK_STANDARD',
      capabilities: ['KEY_ENCODE', 'KEY_REVOKE'],
    });
    access = h.app.get(ACCESS_API);
    const identity = await enroll({
      gatewayUrl: h.gatewayUrl,
      token: await h.enrollmentToken(),
      caCertificatePem: h.caPem,
      agentVersion: 'test',
    });
    client = new AgentLinkClient({
      gatewayUrl: h.gatewayUrl,
      identity,
      queue: DurableQueue.memory(),
      connectorCode: 'LOCK_STANDARD',
      capabilities: ['KEY_ENCODE', 'KEY_REVOKE'],
      agentVersion: 'test',
      onCommand: locks.handle,
    });
    client.start();
  });
  afterAll(async () => {
    client?.stop();
    await h?.app.close();
  });

  it('encodes a key: the lock system acknowledges and the grant is issued', async () => {
    const asked = await issue('504');
    expect(asked).toMatchObject({ status: 'REQUESTED', connectorCode: 'LOCK_STANDARD' });
    const issued = await until(async () => {
      const g = await grant(asked.id);
      return g?.status === 'ISSUED' ? g : undefined;
    });
    expect(issued.issuedAt).not.toBeNull();
    expect(locks.live.get(asked.id)).toMatchObject({ roomNumber: '504', kind: 'KEY' });
  });

  it('a refused encode fails the grant; a revoke reaches the lock and closes it', async () => {
    locks.failingRooms.add('505');
    const refused = await issue('505');
    await until(async () => ((await grant(refused.id))?.status === 'FAILED' ? true : undefined));
    expect(locks.live.has(refused.id)).toBe(false);

    const [live] = (await run(() => access.listForStay(h.tenant, stayId))).filter(
      (g) => g.status === 'ISSUED',
    );
    const revoking = await run(() =>
      access.revoke(h.tenant, live!.id, 'STAFF', { type: 'SYSTEM', id: null }),
    );
    expect(revoking).toMatchObject({ status: 'REVOKE_REQUESTED', revokeReason: 'STAFF' });
    await until(async () => ((await grant(live!.id))?.status === 'REVOKED' ? true : undefined));
    expect(locks.live.has(live!.id)).toBe(false);
    expect(locks.log.map((l) => `${l.type}:${l.ok}`)).toEqual([
      'KEY_ENCODE:true',
      'KEY_ENCODE:false',
      'KEY_REVOKE:true',
    ]);
  });
});
