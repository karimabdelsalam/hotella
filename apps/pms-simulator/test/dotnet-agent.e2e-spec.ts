import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadScenario, runScenario, SimulatedPms } from '../src';
import { agentBinaries, DotnetAgent, type DotnetAgentError } from './dotnet-agent';
import { CAPABILITIES, type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

/**
 * Cross-language conformance (BUILD_PLAN 10.1, ADR-0017): the production .NET hotel agent speaks the link to the real
 * agent gateway — enrollment, mutual TLS, ordered delivery through chaos, heartbeats, signed commands, renewal, HTTPS
 * batches and revocation — exactly like the TypeScript reference agent in `link.e2e-spec.ts`. CI builds the agent and
 * sets TEST_DOTNET_AGENT; without it (no .NET SDK on this machine) the suite is skipped.
 */
const artifacts = readTestInfra().dotnetAgent;
const skip = needsInfra() || !artifacts;
const reason = needsInfra() ? infraSkipReason() : 'TEST_DOTNET_AGENT not set';
const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(skip)(`.NET hotel agent ↔ agent gateway (${skip ? reason : 'dotnet'})`, () => {
  let h: GatewayHarness;
  let agent: DotnetAgent;
  let pms: SimulatedPms;
  let dll: string;
  let host: string;

  beforeAll(async () => {
    ({ conformance: dll, host } = agentBinaries(artifacts!));
    h = await startGatewayHarness(readTestInfra().databaseUrl!, `dn-${stamp}`);
    agent = new DotnetAgent(dll);
  });
  afterAll(async () => {
    await agent?.quit();
    await h?.app.close();
  });

  it('enrolls once with a single-use token (key and CSR made on the hotel machine)', async () => {
    const token = await h.enrollmentToken();
    expect(await agent.enroll(h.gatewayUrl, token, h.caPem)).toBe(h.instanceId);
    const second = new DotnetAgent(dll);
    try {
      const refused = await second.enroll(h.gatewayUrl, token, h.caPem).then(
        () => null,
        (e: DotnetAgentError) => e,
      );
      expect(refused).toMatchObject({ status: 401, code: 'integration.agent.enrollment_invalid' });
    } finally {
      await second.quit();
    }
  });

  it('connects over mutual TLS, reports capabilities and delivers a scenario exactly once despite chaos', async () => {
    await agent.start(
      'SIM_PMS',
      CAPABILITIES.filter((c) => c !== 'GUEST_READ'),
      ['RESYNC_IN_HOUSE'],
    );
    await until(async () => (await agent.state()).connected);
    const instance = await h
      .http()
      .get(`${h.base}/integrations/${h.instanceId}`)
      .set('X-Test-Actor', h.gm)
      .expect(200);
    expect(instance.body.effectiveCapabilities).not.toContain('GUEST_READ');
    expect(instance.body.effectiveCapabilities).toContain('CHECKIN_EVENT');

    const scenario = loadScenario(join(process.cwd(), 'scenarios', 'basic-stay.yml'));
    pms = new SimulatedPms({
      timezone: scenario.timezone,
      faces: new Set(scenario.faces),
      emit: (m) => agent.publish(m),
    });
    await runScenario(scenario, pms, agent);
    const state = await agent.state();
    expect(state.queue_depth).toBe(0);
    expect(state.stats!.resends).toBeGreaterThanOrEqual(1);
    expect(state.stats!.connects).toBeGreaterThanOrEqual(2);

    const rows = await h.messages();
    const sequences = rows.map((m) => m.sequenceNo!).sort((a, b) => a - b);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
    expect(rows.filter((m) => m.status !== 'PROCESSED').map((m) => m.messageType)).toEqual(
      rows.filter((m) => m.messageType === 'OWS_PROFILE').map(() => 'OWS_PROFILE'),
    );

    await h.projectAll();
    const stays = await h.http().get(`${h.base}/stays`).set('X-Test-Actor', h.gm).expect(200);
    expect(stays.body).toHaveLength(1);
    const stay = await h
      .http()
      .get(`${h.base}/stays/${stays.body[0].id}`)
      .set('X-Test-Actor', h.gm)
      .expect(200);
    expect(stay.body.status).toBe('CHECKED_OUT');
    expect(
      stay.body.roomAssignments.map((a: { roomNumber: string; reason: string }) => [
        a.roomNumber,
        a.reason,
      ]),
    ).toEqual([
      ['504', 'PRE_ASSIGNMENT'],
      ['505', 'INITIAL'],
      ['506', 'ROOM_MOVE'],
    ]);

    // A message held back for the reorder chaos is not stranded when nothing follows it.
    agent.chaos.reorderNext = true;
    pms.roomStatus('504', 1, '2026-10-06T09:00:00Z');
    await agent.drained(5_000);
  });

  it('heartbeats report the queue depth', async () => {
    const health = await until(async () => {
      const r = await h
        .http()
        .get(`${h.base}/integrations/${h.instanceId}`)
        .set('X-Test-Actor', h.gm)
        .expect(200);
      return r.body.health?.queueDepth !== null ? r.body.health : undefined;
    });
    expect(health.queueDepth).toBe(0);
  });

  it('verifies signed commands, runs each once and reports the result', async () => {
    agent.onCommand = (c) => {
      if (c.command_type === 'RESYNC_IN_HOUSE') pms.resyncInHouse();
    };
    const before = (await h.messages()).length;
    const command = await h.api.requestCommand({
      tenantId: h.tenant,
      integrationInstanceId: h.instanceId,
      commandType: 'RESYNC_IN_HOUSE',
      payload: {},
      idempotencyKey: `resync-${stamp}`,
      requestedBy: { type: 'SYSTEM', id: null },
    });
    const done = await until(async () => {
      const c = await h.api.getCommand(h.tenant, command.id);
      return c?.status === 'ACKNOWLEDGED' ? c : undefined;
    });
    expect(done.attempts).toBe(1);
    expect(agent.commands.map((c) => c.command_type)).toEqual(['RESYNC_IN_HOUSE']);
    // The welcome carried a licence the agent verified against the pinned key.
    expect((await agent.state()).licence).toMatchObject({
      state: 'VALID',
      capabilities: expect.arrayContaining(['CHECKIN_EVENT', 'RECONCILIATION_READ']),
    });
    const state = await agent.state();
    expect(state.stats).toMatchObject({ commands: 1, rejected_commands: 0 });
    // The resync the command asked for (database-sync start) came back through the link.
    await agent.drained();
    expect((await h.messages()).length).toBeGreaterThan(before);
  });

  it('offline past its licence grace it refuses commands; a fresh licence lifts that', async () => {
    const ask = (key: string) =>
      h.api.requestCommand({
        tenantId: h.tenant,
        integrationInstanceId: h.instanceId,
        commandType: 'RESYNC_IN_HOUSE',
        payload: {},
        idempotencyKey: `${key}-${stamp}`,
        requestedBy: { type: 'SYSTEM', id: null },
      });
    const settled = (commandId: string) =>
      until(async () => {
        const c = await h.api.getCommand(h.tenant, commandId);
        return c && c.status !== 'PENDING' && c.status !== 'SENT' ? c : undefined;
      });
    await agent.licenceClock(45);
    expect((await agent.state()).licence!.state).toBe('EXPIRED');
    const refused = await settled((await ask('expired')).id);
    expect(refused).toMatchObject({ status: 'FAILED' });
    expect(refused.error).toMatch(/licence expired/);
    await agent.licenceClock(0);
    const accepted = await settled((await ask('licensed')).id);
    expect(accepted.status).toBe('ACKNOWLEDGED');
  });

  it('renews its certificate with a fresh key, authenticated by the current one', async () => {
    const certificate = await agent.renew();
    expect(certificate).toMatch(/BEGIN CERTIFICATE/);
  });

  it('uploads HTTPS batches for large resyncs, in order and idempotently', async () => {
    await agent.stop();
    await until(async () => !(await agent.state()).connected);
    pms.reserve({
      id: `B-${stamp}`,
      guest: { first: 'Batch' },
      arrival: '2026-11-01',
      departure: '2026-11-02',
    });
    pms.reserve({
      id: `B2-${stamp}`,
      guest: { first: 'Batch2' },
      arrival: '2026-11-03',
      departure: '2026-11-04',
    });
    await until(async () => (await agent.state()).queue_depth === 2);
    const before = (await h.messages()).length;
    const res = await agent.batch();
    expect(res.resend_from).toBeNull();
    expect((await agent.state()).queue_depth).toBe(0);
    expect((await h.messages()).length).toBe(before + 2);
  });

  it('stops at once when its certificate is revoked', async () => {
    await agent.start('SIM_PMS', CAPABILITIES, ['RESYNC_IN_HOUSE']);
    await until(async () => (await agent.state()).connected);
    await h
      .http()
      .post(`${h.base}/integrations/${h.instanceId}/agent/revoke`)
      .set('X-Test-Actor', h.gm)
      .send({ reason: 'decommissioned test agent' })
      .expect(200);
    await until(async () => (await agent.state()).revoked, 10_000);
    expect((await agent.state()).connected).toBe(false);
    const refused = await agent.batch().then(
      () => null,
      (e: DotnetAgentError) => e.status,
    );
    expect(refused).toBe(401);
    const audit = await h.db.execute<{ action: string }>(
      sql`select action from audit.audit_log where entity_id = ${h.instanceId} order by occurred_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['integration.agent.enroll', 'integration.agent.revoke']),
    );
  });

  it('the hotella-agent service: enroll from a token file, status, run until the platform sees it linked', async () => {
    const instance = (
      await h
        .http()
        .post(`${h.base}/integrations`)
        .set('X-Test-Actor', h.gm)
        .send({ connectorCode: 'SIM_PMS', name: 'Service', capabilities: CAPABILITIES })
        .expect(201)
    ).body.id as string;
    await h
      .http()
      .patch(`${h.base}/integrations/${instance}`)
      .set('X-Test-Actor', h.gm)
      .send({ version: 1, status: 'ACTIVE' })
      .expect(200);
    const token = (
      await h
        .http()
        .post(`${h.base}/integrations/${instance}/enrollment-tokens`)
        .set('X-Test-Actor', h.gm)
        .expect(201)
    ).body.token as string;
    const dir = mkdtempSync(join(tmpdir(), 'hotella-agent-'));
    try {
      writeFileSync(join(dir, 'token'), token);
      writeFileSync(join(dir, 'ca.pem'), h.caPem);
      const settings = [
        `--Agent:Gateway=${h.gatewayUrl}`,
        `--Agent:DataDirectory=${join(dir, 'data')}`,
        '--Agent:ConnectorCode=SIM_PMS',
        ...CAPABILITIES.map((c, i) => `--Agent:Capabilities:${i}=${c}`),
      ];
      const enrolled = await exec(host, [
        'enroll',
        '--token-file',
        join(dir, 'token'),
        '--ca',
        join(dir, 'ca.pem'),
        ...settings,
      ]);
      expect(enrolled).toMatchObject({ code: 0 });
      expect(enrolled.out).toContain(`enrolled as instance ${instance}`);
      const again = await exec(host, [
        'enroll',
        '--token-file',
        join(dir, 'token'),
        '--ca',
        join(dir, 'ca.pem'),
        ...settings,
      ]);
      expect(again.code).toBe(1); // already enrolled: --replace is explicit

      const status = await exec(host, ['status', ...settings]);
      expect(status).toMatchObject({ code: 0 });
      expect(status.out).toContain(`instance:     ${instance}`);
      expect(status.out).not.toContain(token);

      const service = spawn('dotnet', [host, 'run', ...settings], { stdio: 'ignore' });
      try {
        await until(async () => {
          const r = await h
            .http()
            .get(`${h.base}/integrations/${instance}/agent`)
            .set('X-Test-Actor', h.gm)
            .expect(200);
          return r.body.connected === true;
        }, 30_000);
      } finally {
        const exited = new Promise((r) => service.once('exit', r));
        service.kill('SIGTERM');
        await exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function exec(dll: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('dotnet', [dll, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}
