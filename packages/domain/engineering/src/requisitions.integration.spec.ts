import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { ErpService } from '@hotella/domain-integrations';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequisitionService } from './application/requisition.service';
import {
  createHotel,
  type EngHarness,
  type Hotel,
  staff,
  startEngineeringApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

/**
 * Part requisitions (BUILD_PLAN 13.5): a person approves every one; an approved requisition goes to the ERP as a
 * command only when a connector serves it and the part has an ERP item code; the ERP's answer settles it.
 */
describe.skipIf(needsInfra())(`Part requisitions (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const techId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'eng.work_order.read',
    'eng.parts.manage',
    'eng.requisition.request',
    'approval.read',
    'approval.decide',
    'integration.read',
    'integration.configure',
  ];
  let h: EngHarness;
  let hotel: Hotel;
  let other: Hotel;
  let filter: { id: string };
  let belt: { id: string };
  const gm = (tenantId = hotel.tenantId) => staff(gmId, tenantId);
  const tech = () => staff(techId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}/eng`;
  const rows = async <T>(q: ReturnType<typeof sql>) =>
    (await h.db.execute(q)).rows as unknown as T[];
  const requisition = async (id: string) =>
    (
      (await h.http().get(`${base()}/requisitions`).set('X-Test-Actor', gm()).expect(200))
        .body as Array<{ id: string; status: string; failure: string | null }>
    ).find((r) => r.id === id)!;
  const ask = async (partId: string, quantity: number) =>
    (
      await h
        .http()
        .post(`${base()}/requisitions`)
        .set('X-Test-Actor', tech())
        .send({ partId, quantity, reason: 'stock for the chiller service' })
        .expect(201)
    ).body as { id: string; status: string; approvalId: string };
  const decide = (approvalId: string, decision: 'APPROVE' | 'REJECT') =>
    h
      .http()
      .post(`/properties/${hotel.propertyId}/approvals/${approvalId}/decision`)
      .set('X-Test-Actor', gm())
      .send({ decision, ...(decision === 'REJECT' ? { reason: 'not this month' } : {}) })
      .expect(200);
  const part = async (partNumber: string) =>
    (
      await h
        .http()
        .post(`${base()}/parts`)
        .set('X-Test-Actor', gm())
        .send({ partNumber, name: partNumber, unit: 'EA' })
        .expect(201)
    ).body as { id: string };

  beforeAll(async () => {
    h = await startEngineeringApp(url, 'hotella_app_eng_requisitions', {
      [gmId]: STAFF,
      [techId]: ['eng.work_order.read', 'eng.requisition.request'],
    });
    hotel = await createHotel(h, `engr-a-${stamp}`, gmId);
    other = await createHotel(h, `engr-b-${stamp}`, gmId, ['900']);
    filter = await part(`FLT-${stamp}`);
    belt = await part(`BLT-${stamp}`);
  });
  afterAll(() => h?.app.close());

  it('without an ERP connector an approved requisition waits for a manual purchase', async () => {
    const asked = await ask(filter.id, 4);
    expect(asked.status).toBe('PENDING_APPROVAL');
    const [approval] = await rows<{
      kind: string;
      risk_level: string;
      payload: { quantity: number };
    }>(
      sql`select kind, risk_level, payload from ops.approval_requests where id = ${asked.approvalId}`,
    );
    expect(approval).toMatchObject({ kind: 'ENG_REQUISITION', risk_level: 'MEDIUM' });
    expect(approval!.payload.quantity).toBe(4);
    await decide(asked.approvalId, 'APPROVE');
    expect(await requisition(asked.id)).toMatchObject({
      status: 'APPROVED',
      failure: 'NO_CONNECTOR',
    });
    // Linking an item needs an ERP connector.
    const refused = await h
      .http()
      .post(`${base()}/parts/${filter.id}/erp-item`)
      .set('X-Test-Actor', gm())
      .send({ itemCode: 'ERP-FLT-20' })
      .expect(409);
    expect(refused.body.code).toBe('integration.erp.unavailable');
  });

  it('with an ERP: the approved requisition is sent as a command and the answer settles it', async () => {
    const integrations = `/properties/${hotel.propertyId}/integrations`;
    const instanceId = (
      await h
        .http()
        .post(integrations)
        .set('X-Test-Actor', gm())
        .send({
          connectorCode: 'ERP_STANDARD',
          name: 'ERP',
          capabilities: ['STOCK_READ', 'REQUISITION_CREATE'],
        })
        .expect(201)
    ).body.id as string;
    await h
      .http()
      .patch(`${integrations}/${instanceId}`)
      .set('X-Test-Actor', gm())
      .send({ version: 1, status: 'ACTIVE' })
      .expect(200);
    await h
      .http()
      .post(`${base()}/parts/${filter.id}/erp-item`)
      .set('X-Test-Actor', gm())
      .send({ itemCode: `ERP-FLT-${stamp}` })
      .expect(200);
    // One item code, one part.
    const taken = await h
      .http()
      .post(`${base()}/parts/${belt.id}/erp-item`)
      .set('X-Test-Actor', gm())
      .send({ itemCode: `ERP-FLT-${stamp}` })
      .expect(409);
    expect(taken.body.code).toBe('integration.erp.item_taken');

    const asked = await ask(filter.id, 6);
    await decide(asked.approvalId, 'APPROVE');
    const [command] = await rows<{ id: string; command_type: string; payload: unknown }>(
      sql`select id, command_type, payload from integration.integration_commands where idempotency_key = ${`requisition:${asked.id}`}`,
    );
    expect(command).toMatchObject({
      command_type: 'REQUISITION_CREATE',
      payload: {
        requisition_ref: asked.id,
        lines: [{ item_code: `ERP-FLT-${stamp}`, quantity: 6, unit: 'EA' }],
      },
    });
    expect(await requisition(asked.id)).toMatchObject({ status: 'SENT' });

    // The ERP answers over the link; the worker applies the announcement.
    await h.app
      .get(TransactionRunner)
      .run(() =>
        h.app
          .get(ErpService)
          .onCommandResult({ tenantId: hotel.tenantId }, command!.id, 'ACKNOWLEDGED', null),
      );
    const [settled] = await rows<{ envelope: EventEnvelope }>(
      sql`select envelope from platform.outbox where aggregate_id = ${command!.id} and event_type = 'integration.requisition.settled'`,
    );
    const apply = (e: EventEnvelope) =>
      h.app.get(TransactionRunner).run(() => h.app.get(RequisitionService).apply(e));
    await apply(settled!.envelope);
    await apply(settled!.envelope);
    expect(await requisition(asked.id)).toMatchObject({ status: 'CONFIRMED' });

    // Without a connected agent, the stock read is honest about it.
    const stock = await h
      .http()
      .get(`${base()}/parts/${filter.id}/stock`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(stock.body).toMatchObject({
      partId: filter.id,
      erpItemCode: `ERP-FLT-${stamp}`,
      erp: { outcome: 'FAILED', reason: 'UNREACHABLE', levels: [] },
    });
  });

  it('a rejected requisition is kept as REJECTED; only the right people may ask', async () => {
    const asked = await ask(belt.id, 1);
    await decide(asked.approvalId, 'REJECT');
    const service = h.app.get(RequisitionService);
    await service.settleApproval(hotel.tenantId, asked.approvalId, 'REJECTED');
    await service.settleApproval(hotel.tenantId, asked.approvalId, 'REJECTED');
    expect(await requisition(asked.id)).toMatchObject({ status: 'REJECTED', failure: 'REJECTED' });
    await h
      .http()
      .post(`${base()}/parts/${belt.id}/erp-item`)
      .set('X-Test-Actor', tech())
      .send({ itemCode: 'X' })
      .expect(403);
  });

  it('another hotel sees none of it', async () => {
    await h
      .http()
      .get(`${base()}/requisitions`)
      .set('X-Test-Actor', gm(other.tenantId))
      .expect(404);
    const theirs = await h
      .http()
      .get(`/properties/${other.propertyId}/eng/requisitions`)
      .set('X-Test-Actor', gm(other.tenantId))
      .expect(200);
    expect(theirs.body).toEqual([]);
    await h
      .http()
      .post(`/properties/${other.propertyId}/eng/requisitions`)
      .set('X-Test-Actor', gm(other.tenantId))
      .send({ partId: filter.id, quantity: 1 })
      .expect(404);
  });
});
