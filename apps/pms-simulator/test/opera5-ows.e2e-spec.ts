import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  infraSkipReason,
  needsDotnetAgent,
  needsInfra,
  readTestInfra,
} from '@hotella/platform-testing';
import { EXTERNAL_ENTITY, PMS_API, type PmsPublicApi } from '@hotella/domain-integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwsSoapFace, SimulatedPms } from '../src';
import { agentBinaries, DotnetAgent } from './dotnet-agent';
import { type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

/**
 * OPERA 5 through OPERA Web Services (BUILD_PLAN 10.3, ADR-0014): the .NET agent's OWS poller asks the simulator's
 * SOAP face for the arrival window and forwards only what changed — future reservations with ETA and sharers, then a
 * change and a cancellation — through the link to an `OPERA5_OWS` instance, where they become expected stays. The
 * standard OWS connector v1 (10.8) also answers `PMS_API` reads and adds a guest's contact to the OPERA profile once
 * verified, exactly once. The OWS password lives in the agent's protected store. Skipped without a built agent
 * (TEST_DOTNET_AGENT).
 */
const artifacts = readTestInfra().dotnetAgent;
const skip = needsDotnetAgent();
const reason = needsInfra() ? infraSkipReason() : 'TEST_DOTNET_AGENT not set';
const stamp = Date.now().toString(36).toUpperCase();
const CAPABILITIES = [
  'RESERVATION_READ',
  'RESERVATION_LOOKUP',
  'ARRIVALS_READ',
  'GUEST_READ',
  'PROFILE_LOOKUP',
  'PROFILE_EVENT',
  'PROFILE_WRITE',
];
const ADMIN = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const OWS_USER = 'HOTELLA';
const OWS_PASSWORD = `ows-${stamp}`;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

interface StayRow {
  id: string;
  status: string;
  expectedDeparture: string;
  eta: string | null;
  adults: number;
}

describe.skipIf(skip)(
  `OPERA5_OWS: OWS SOAP ↔ .NET agent ↔ gateway (${skip ? reason : 'dotnet'})`,
  () => {
    let h: GatewayHarness;
    let agent: DotnetAgent;
    let pms: SimulatedPms;
    let ows: OwsSoapFace;
    const id = (x: string) => `OWS-${x}-${stamp}`;
    const forwarded = async () => (await agent.state()).ows?.forwarded ?? 0;
    const stays = async () => {
      await h.projectAll();
      return (await h.http().get(`${h.base}/stays`).set('X-Test-Actor', h.gm).expect(200))
        .body as StayRow[];
    };

    beforeAll(async () => {
      h = await startGatewayHarness(readTestInfra().databaseUrl!, `ows-${stamp}`, {
        connectorCode: 'OPERA5_OWS',
        capabilities: CAPABILITIES,
      });
      // The PMS's own interfaces are not used here: the agent asks OWS.
      pms = new SimulatedPms({ timezone: 'Africa/Cairo', faces: new Set(), emit: () => undefined });
      ows = new OwsSoapFace(pms, { user: OWS_USER, password: OWS_PASSWORD });
      agent = new DotnetAgent(agentBinaries(artifacts).conformance);
      await agent.enroll(h.gatewayUrl, await h.enrollmentToken(), h.caPem);
    });
    afterAll(async () => {
      await agent?.quit();
      await ows?.close();
      await h?.app.close();
    });

    it('forwards future reservations with ETA and sharers; they become expected stays', async () => {
      const url = await ows.listen();
      pms.reserve({
        id: id('A'),
        guest: { profileId: `P-${stamp}`, first: 'Amira', last: 'Nile', language: 'ar', vip: 'V1' },
        sharers: [{ first: 'Omar', last: 'Nile' }],
        arrival: inDays(3),
        departure: inDays(6),
        eta: `${inDays(3)}T14:30:00+03:00`,
        adults: 2,
        room: '504',
      });
      pms.reserve({
        id: id('B'),
        guest: { first: 'Karim' },
        arrival: inDays(5),
        departure: inDays(7),
      });
      pms.reserve({
        id: id('FAR'),
        guest: { first: 'Later' },
        arrival: inDays(40),
        departure: inDays(42),
      });
      await agent.start('OPERA5_OWS', CAPABILITIES, [], {
        ows: { url, user: OWS_USER, password: OWS_PASSWORD, poll_seconds: 1 },
      });
      await until(async () => (await agent.state()).connected);
      await until(async () => (await forwarded()) >= 2, 20_000);
      await agent.drained();
      // Polling again changes nothing: only differences are forwarded.
      const polls = (await agent.state()).ows!.polls;
      await until(async () => (await agent.state()).ows!.polls >= polls + 2);
      expect(await forwarded()).toBe(2);

      const rows = await h.messages();
      expect(rows.map((r) => r.messageType)).toEqual(['OWS_RESERVATION', 'OWS_RESERVATION']);
      expect(rows.every((r) => r.status === 'PROCESSED')).toBe(true);
      const list = await stays();
      expect(list.map((s) => s.status)).toEqual(['EXPECTED', 'EXPECTED']);
      const a = list.find((s) => s.adults === 2)!;
      expect(a.eta).not.toBeNull();
      const detail = await h
        .http()
        .get(`${h.base}/stays/${a.id}`)
        .set('X-Test-Actor', h.gm)
        .expect(200);
      expect(
        detail.body.party.map((m: { role: string; guest: { givenName: string } }) => [
          m.role,
          m.guest.givenName,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['PRIMARY', 'Amira'],
          ['ACCOMPANYING', 'Omar'],
        ]),
      );
    });

    it('a change and a cancellation in OPERA arrive at the next poll, once each', async () => {
      pms.modify(id('A'), { departure: inDays(7) });
      pms.cancel(id('B'));
      await until(async () => (await forwarded()) >= 4, 20_000);
      await agent.drained();
      const actions = (await h.messages()).map((r) => (r.payload as { action: string }).action);
      expect(actions).toEqual(['NEW', 'NEW', 'CHANGE', 'CANCEL']);
      const list = await stays();
      expect(list.map((s) => s.status).sort()).toEqual(['CANCELLED', 'EXPECTED']);
      expect(list.find((s) => s.status === 'EXPECTED')!.expectedDeparture).toBe(inDays(7));
      expect((await agent.state()).ows!.failures).toBe(0);
    });

    it('answers the standard reads through PMS_API: FetchBooking, FutureBookingSummary, FetchProfile', async () => {
      const api = h.app.get<PmsPublicApi>(PMS_API);
      const ctx = {
        tenantId: h.tenant,
        propertyId: h.property,
        requestedBy: { type: 'SYSTEM', id: null },
      };
      expect(await api.lookupReservation({ ...ctx, reservationId: id('A') })).toMatchObject({
        outcome: 'OK',
        connectorCode: 'OPERA5_OWS',
        rows: [
          {
            reservation_id: id('A'),
            status: 'RESERVED',
            eta: '14:30',
            room_number: '504',
            adults: 2,
            profile_id: `P-${stamp}`,
          },
        ],
      });
      const confirmation = pms.reservations.get(id('A'))!.confirmation;
      const byConfirmation = await api.lookupReservation({
        ...ctx,
        confirmationNumber: confirmation,
      });
      expect(
        byConfirmation.outcome === 'OK' && byConfirmation.rows.map((r) => r.reservation_id),
      ).toEqual([id('A')]);
      expect(await api.lookupReservation({ ...ctx, confirmationNumber: 'NONE' })).toMatchObject({
        outcome: 'OK',
        rows: [],
      });
      // B was cancelled: an arrivals list leaves it out; FAR is outside the window.
      const arrivals = await api.listArrivals({ ...ctx, from: inDays(0), to: inDays(10) });
      expect(arrivals.outcome === 'OK' && arrivals.rows.map((r) => r.reservation_id)).toEqual([
        id('A'),
      ]);
      expect(await api.lookupProfile({ ...ctx, profileId: `P-${stamp}` })).toMatchObject({
        outcome: 'OK',
        rows: [{ first_name: 'Amira', last_name: 'Nile', language: 'AR', vip_code: 'V1' }],
      });
      expect(ows.operations).toEqual(
        expect.arrayContaining(['Reservation.FetchBooking', 'Name.FetchProfile']),
      );
    });

    it('adds a contact to the OPERA profile only once verified, and a repeat inserts nothing twice', async () => {
      const api = h.app.get<PmsPublicApi>(PMS_API);
      const guestId = (await h.api.resolveReference(
        h.tenant,
        h.instanceId,
        EXTERNAL_ENTITY.PROFILE,
        `P-${stamp}`,
      ))!;
      expect(guestId).toBeTruthy();
      const write = (key: string, subjectId = guestId) =>
        api.updateProfileContact({
          tenantId: h.tenant,
          propertyId: h.property,
          idempotencyKey: `${key}-${stamp}`,
          requestedBy: { type: 'SYSTEM', id: null },
          subject: { entityType: 'guest.guest', id: subjectId },
          email: 'amira@new.example',
          phone: '+20 100 000 0000',
        });
      // A write is never offered before the hotel's OWS was verified for it (guide §16.5).
      expect(await write('before')).toEqual({
        outcome: 'UNAVAILABLE',
        capability: 'PROFILE_WRITE',
      });
      await h
        .http()
        .post(`${h.base}/integration/capabilities/PROFILE_WRITE/verify`)
        .set('X-Test-Actor', ADMIN)
        .send({
          instanceId: h.instanceId,
          evidenceRef: 'COMM-OWS-1: contact insert checked in OPERA',
        })
        .expect(200);
      const acknowledged = async (outcome: Awaited<ReturnType<typeof write>>) => {
        expect(outcome).toMatchObject({ outcome: 'QUEUED', connectorCode: 'OPERA5_OWS' });
        const commandId = (outcome as { commandId: string }).commandId;
        return until(async () => {
          const c = await h.api.getCommand(h.tenant, commandId);
          return c && c.status !== 'PENDING' && c.status !== 'SENT' ? c : undefined;
        });
      };
      expect(await acknowledged(await write('first'))).toMatchObject({ status: 'ACKNOWLEDGED' });
      expect(pms.contacts(`P-${stamp}`)).toEqual({
        emails: ['amira@new.example'],
        phones: ['+20 100 000 0000'],
      });
      // The same change asked again (a new key, as after a timeout): read first, nothing inserted twice.
      expect(await acknowledged(await write('again'))).toMatchObject({ status: 'ACKNOWLEDGED' });
      expect(pms.addedContacts.get(`P-${stamp}`)).toEqual({
        emails: ['amira@new.example'],
        phones: ['+20 100 000 0000'],
      });
      expect(ows.operations.filter((o) => o.startsWith('Name.Insert'))).toEqual([
        'Name.InsertEmail',
        'Name.InsertPhone',
      ]);
      // A guest the PMS never told us about has no OPERA profile to update.
      expect(await write('unknown', '01900000-0000-7000-8000-000000000000')).toEqual({
        outcome: 'NOT_LINKED',
        capability: 'PROFILE_WRITE',
      });
    });

    it('the OWS password is set from stdin into the protected store and never shown', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hotella-agent-'));
      try {
        const host = agentBinaries(artifacts).host;
        const data = `--Agent:DataDirectory=${join(dir, 'data')}`;
        const set = await run(host, ['secret', 'set', 'ows.password', data], `${OWS_PASSWORD}\n`);
        expect(set).toMatchObject({ code: 0 });
        const list = await run(host, ['secret', 'list', data]);
        expect(list.out.trim()).toBe('ows.password');
        const status = await run(host, [
          'status',
          data,
          '--Agent:ConnectorCode=OPERA5_OWS',
          `--Ows:Url=${'http://127.0.0.1:9/OWS/'}`,
          '--Ows:Username=HOTELLA',
        ]);
        expect(status.out).toContain('secrets:      ows.password');
        expect(status.out).not.toContain(OWS_PASSWORD);
        expect(status.out).not.toContain('secret ows.password is not set');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

function run(
  dll: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('dotnet', [dll, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(stdin ?? '');
  });
}
