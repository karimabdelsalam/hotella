#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { enroll, loadIdentity, saveIdentity } from './agent/identity';
import { AgentLinkClient } from './agent/link-client';
import { DurableQueue } from './agent/queue';
import { type Face, SimulatedPms } from './pms/hotel';
import { loadScenario, runScenario } from './scenario';

const AGENT_VERSION = 'hotella-sim/1';
const ALL_CAPABILITIES = [
  'CHECKIN_EVENT',
  'CHECKOUT_EVENT',
  'ROOM_MOVE_EVENT',
  'PROFILE_EVENT',
  'ROOM_STATUS_READ',
  'ROOM_STATUS_WRITE',
  'RESERVATION_READ',
  'GUEST_READ',
  'RECONCILIATION_READ',
];

const out = (line: string) => process.stdout.write(`${line}\n`);

/**
 * hotella-sim enroll --gateway <url> --ca <ca.pem> --token <token> --state <dir>
 * hotella-sim run    --gateway <url> --state <dir> --scenario <file.yml> [--faces FIAS,OWS] [--keep-running]
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
    },
  });
  const state = values.state!;
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
