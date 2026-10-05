#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { enroll, loadIdentity, saveIdentity } from './agent/identity';
import { answerQuery } from './pms/queries';
import { AgentLinkClient } from './agent/link-client';
import { DurableQueue } from './agent/queue';
import { type Face, SimulatedPms } from './pms/hotel';
import { CHILLER_SCENARIO, inboundBody, postInbound, samplesBetween } from './bms/building';
import { SimulatedPos } from './pos/outlets';
import { loadScenario, runScenario } from './scenario';

const AGENT_VERSION = 'hotella-sim/1';
const ALL_CAPABILITIES = [
  'CHECKIN_EVENT',
  'CHECKOUT_EVENT',
  'ROOM_MOVE_EVENT',
  'PROFILE_EVENT',
  'ROOM_STATUS_READ',
  'ROOM_STATUS_WRITE',
  'OOO_WRITE',
  'RESERVATION_READ',
  'RESERVATION_LOOKUP',
  'ARRIVALS_READ',
  'IN_HOUSE_SNAPSHOT',
  'GUEST_READ',
  'PROFILE_LOOKUP',
  'ROOM_INVENTORY_READ',
  'RECONCILIATION_READ',
];

const out = (line: string) => process.stdout.write(`${line}\n`);

/**
 * hotella-sim enroll --gateway <url> --ca <ca.pem> --token <token> --state <dir>
 * hotella-sim run    --gateway <url> --state <dir> --scenario <file.yml> [--faces FIAS,OWS] [--keep-running]
 * hotella-sim bms    --api <url> --endpoint <id> --secret-file <file> [--minutes 20]
 * hotella-sim pos    --api <url> --endpoint <id> --secret-file <file> [--rooms 214,215] [--checks 12]
 */
async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      gateway: { type: 'string' },
      ca: { type: 'string' },
      token: { type: 'string' },
      state: { type: 'string', default: '.hotella-sim' },
      scenario: { type: 'string' },
      faces: { type: 'string' },
      'keep-running': { type: 'boolean', default: false },
      api: { type: 'string' },
      endpoint: { type: 'string' },
      'secret-file': { type: 'string' },
      minutes: { type: 'string', default: '20' },
      rooms: { type: 'string', default: '' },
      checks: { type: 'string', default: '12' },
    },
  });
  const state = values.state!;
  if (command === 'bms') {
    // The plant room's last N minutes, ending now, through the signed webhook ingress (BUILD_PLAN 13.2).
    if (!values.api || !values.endpoint || !values['secret-file'])
      throw new Error('bms needs --api, --endpoint and --secret-file');
    const minutes = Math.max(1, Math.min(240, Number(values.minutes)));
    const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 - minutes * 60_000);
    const secret = readFileSync(values['secret-file'], 'utf8').trim();
    const body = inboundBody(
      samplesBetween(CHILLER_SCENARIO, start, 0, minutes),
      `sim-bms-${start.getTime()}`,
    );
    out(JSON.stringify(await postInbound(values.api, values.endpoint, secret, body)));
    return;
  }
  if (command === 'pos') {
    // An evening of closed checks through the signed webhook ingress (BUILD_PLAN 13.5).
    if (!values.api || !values.endpoint || !values['secret-file'])
      throw new Error('pos needs --api, --endpoint and --secret-file');
    const rooms = values.rooms!.split(',').filter(Boolean);
    const count = Math.max(1, Math.min(200, Number(values.checks)));
    const secret = readFileSync(values['secret-file'], 'utf8').trim();
    const messages = new SimulatedPos(undefined, Date.now() % 100_000 || 1).evening(rooms, count);
    out(
      JSON.stringify(
        await postInbound(values.api, values.endpoint, secret, JSON.stringify({ messages })),
      ),
    );
    return;
  }
  if (command === 'enroll') {
    if (!values.gateway || !values.ca || !values.token)
      throw new Error('enroll needs --gateway, --ca and --token');
    const identity = await enroll({
      gatewayUrl: values.gateway,
      token: values.token,
      caCertificatePem: readFileSync(values.ca, 'utf8'),
      agentVersion: AGENT_VERSION,
    });
    saveIdentity(state, identity);
    out(`enrolled instance ${identity.instanceId}`);
    return;
  }
  if (command === 'run') {
    if (!values.gateway || !values.scenario) throw new Error('run needs --gateway and --scenario');
    const identity = loadIdentity(state);
    if (!identity) throw new Error(`no identity in ${state}: run "enroll" first`);
    const scenario = loadScenario(values.scenario);
    const faces = new Set<Face>((values.faces?.split(',') as Face[] | undefined) ?? scenario.faces);
    const queue = DurableQueue.open(join(state, 'queue'));
    const holder: { pms?: SimulatedPms } = {};
    const link = new AgentLinkClient({
      gatewayUrl: values.gateway,
      identity,
      queue,
      connectorCode: 'SIM_PMS',
      capabilities: ALL_CAPABILITIES,
      agentVersion: AGENT_VERSION,
      // Link protocol 2: the standard reads answered from the simulated hotel (ADR-0019).
      onQuery: async (query) => answerQuery(holder.pms!, query.query_type, query.params),
      onCommand: async (cmd) => {
        if (cmd.command_type === 'RESYNC_IN_HOUSE') {
          out(`command RESYNC_IN_HOUSE: ${holder.pms!.resyncInHouse()} in-house record(s)`);
          return { status: 'ACKNOWLEDGED' };
        }
        if (cmd.command_type === 'SET_ROOM_STATUS') {
          const { room_number, status } = cmd.payload as { room_number: string; status: string };
          holder.pms!.acceptRoomStatus(room_number, status);
          out(`command SET_ROOM_STATUS: room ${room_number} ${status}`);
          return { status: 'ACKNOWLEDGED' };
        }
        if (cmd.command_type === 'SET_ROOM_RESTRICTION') {
          const { room_number, kind, active } = cmd.payload as {
            room_number: string;
            kind: string;
            active: boolean;
          };
          holder.pms!.acceptRoomRestriction(room_number, active ? kind : null);
          out(`command SET_ROOM_RESTRICTION: room ${room_number} ${active ? kind : 'released'}`);
          return { status: 'ACKNOWLEDGED' };
        }
        return { status: 'FAILED', error: `unsupported command ${cmd.command_type}` };
      },
      log: (m, d) => out(`${m} ${d ? JSON.stringify(d) : ''}`),
    });
    const pms = new SimulatedPms({
      timezone: scenario.timezone,
      faces,
      emit: (m) => link.publish(m),
    });
    holder.pms = pms;
    link.start();
    // Chaos steps act on a live link; start the scenario once the gateway welcomed the agent.
    await link.ready();
    await runScenario(scenario, pms, link);
    await link.drained(60_000);
    out(`scenario "${scenario.name}" delivered (${JSON.stringify(link.stats)})`);
    if (!values['keep-running']) link.stop();
    return;
  }
  throw new Error('usage: hotella-sim <enroll|run> …');
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
