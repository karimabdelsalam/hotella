import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { ERP_API, type ErpPublicApi } from '@hotella/domain-integrations/public';
import { DATABASE, type Database, newId, TransactionRunner } from '@hotella/platform-database';
import { eventsSchema } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentLinkClient, DurableQueue, enroll, SimulatedErp } from '../src';
import { type GatewayHarness, startGatewayHarness, until } from './gateway-harness';

const stamp = Date.now().toString(36).toUpperCase();

/**
 * The ERP over the real link (BUILD_PLAN 13.5): an ERP agent enrolls; the platform reads stock with a signed `ERP_STOCK`
 * query and sends an approved requisition as a signed `REQUISITION_CREATE` command, whose answer is announced as
 * `integration.requisition.settled`. Engineering names parts; the item codes stay in the integration context.
 */
describe.skipIf(needsInfra())(
  `stock and requisitions through an ERP agent (${infraSkipReason()})`,
  () => {
    let h: GatewayHarness;
    let client: AgentLinkClient;
    let erp: ErpPublicApi;
    const stores = new SimulatedErp({
      [`FLT-${stamp}`]: [
        { onHand: 12, unit: 'EA', warehouse: 'MAIN' },
        { onHand: 3, unit: 'EA', warehouse: 'ENG' },
      ],
    });
    const filter = newId();
    const belt = newId();
    const run = <T>(fn: () => Promise<T>) => h.app.get(TransactionRunner).run(fn);

    beforeAll(async () => {
      const capabilities = ['STOCK_READ', 'REQUISITION_CREATE'];
      h = await startGatewayHarness(readTestInfra().databaseUrl!, `erp-${stamp}`, {
        connectorCode: 'ERP_STANDARD',
        capabilities,
      });
      erp = h.app.get(ERP_API);
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
        connectorCode: 'ERP_STANDARD',
        capabilities,
        agentVersion: 'test',
        onCommand: stores.onCommand,
        onQuery: stores.onQuery,
      });
      client.start();
      await run(() =>
        erp.linkItem({
          tenantId: h.tenant,
          propertyId: h.property,
          partId: filter,
          itemCode: `FLT-${stamp}`,
        }),
      );
    });
    afterAll(async () => {
      client?.stop();
      await h?.app.close();
    });

    it('reads stock by part over the link; a part without an item code is reported, not guessed', async () => {
      const stock = await until(async () => {
        const s = await erp.stock({
          tenantId: h.tenant,
          propertyId: h.property,
          partIds: [filter, belt],
          requestedBy: { type: 'SYSTEM', id: null },
        });
        return s.outcome === 'OK' ? s : undefined;
      });
      expect(stock.levels).toEqual([
        { partId: filter, onHand: 12, unit: 'EA', warehouse: 'MAIN' },
        { partId: filter, onHand: 3, unit: 'EA', warehouse: 'ENG' },
      ]);
      expect(stock.unlinked).toEqual([belt]);
    });

    it('sends a requisition as a command; the ERP acknowledges and the answer is announced', async () => {
      const requisitionId = newId();
      const sent = await run(() =>
        erp.requestRequisition({
          tenantId: h.tenant,
          propertyId: h.property,
          requisitionId,
          lines: [{ partId: filter, quantity: 4, unit: 'EA' }],
          neededBy: null,
          requestedBy: { type: 'SYSTEM', id: null },
        }),
      );
      expect(sent.status).toBe('SENT');
      const unlinked = await run(() =>
        erp.requestRequisition({
          tenantId: h.tenant,
          propertyId: h.property,
          requisitionId: newId(),
          lines: [{ partId: belt, quantity: 1, unit: 'EA' }],
          neededBy: null,
          requestedBy: { type: 'SYSTEM', id: null },
        }),
      );
      expect(unlinked).toEqual({ status: 'UNAVAILABLE', reason: 'UNLINKED_ITEM' });

      const db = h.app.get<Database>(DATABASE);
      const settled = await until(async () => {
        const [row] = await db
          .select()
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.tenantId, h.tenant),
              eq(eventsSchema.outbox.eventType, 'integration.requisition.settled'),
            ),
          );
        return row;
      });
      expect((settled.envelope as { payload: unknown }).payload).toMatchObject({
        requisition_id: requisitionId,
        status: 'ACKNOWLEDGED',
      });
      expect(stores.requisitions).toEqual([
        { ref: requisitionId, lines: [{ item_code: `FLT-${stamp}`, quantity: 4, unit: 'EA' }] },
      ]);
    });
  },
);
