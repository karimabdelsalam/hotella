import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import {
  ChannelAdapterRegistry,
  ChannelIdentityService,
  ConversationService,
  FakeWhatsAppProvider,
} from '@hotella/domain-communications';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestLifecycle } from './application/request-lifecycle';
import {
  createHotel,
  guestSession,
  type Harness,
  type Hotel,
  seedStay,
  type SeededStay,
  staff,
  startCatalogApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const MONA_PHONE = '+201001112233';
const STAFF = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'org.department.manage',
  'catalog.read',
  'catalog.manage',
  'catalog.publish',
  'request.read',
  'request.create',
  'request.manage',
  'task.read',
  'task.accept',
  'task.complete',
  'channel.manage',
];

interface Created {
  request: { id: string; workItemId: string };
}

describe.skipIf(needsInfra())(
  `Guest notifications of service requests (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    const gmId = newId();
    const whatsapp = new FakeWhatsAppProvider();
    let h: Harness;
    let hotel: Hotel;
    let stay: SeededStay;
    let mona: string;
    let ali: string;
    let channelId: string;
    const gm = () => staff(gmId, hotel.tenantId);
    const base = () => `/properties/${hotel.propertyId}`;
    const ask = (
      token: string,
      serviceCode: string,
      fields: Record<string, unknown>,
      lang = 'ar',
    ) =>
      h
        .http()
        .post('/guest/requests')
        .set('X-Guest-Session', token)
        .set('Accept-Language', lang)
        .send({ serviceCode, fields })
        .expect(201)
        .then((r) => r.body as Created);
    /** What the worker does: deliver the work item's events to the request, then run the outbound job. */
    const work = async (created: Created, action: 'accept' | 'start' | 'complete') => {
      const item = await h.app
        .get<OperationsPublicApi>(OPERATIONS_API)
        .getWorkItem(hotel.tenantId, created.request.workItemId);
      await h
        .http()
        .post(`${base()}/tasks/${item!.tasks[0]!.id}/${action}`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(200);
      const rows = (
        await h.db
          .execute(sql`select envelope from platform.outbox where event_type = 'ops.work_item.status_changed'
        and aggregate_id = ${created.request.workItemId} order by id`)
      ).rows as Array<{ envelope: EventEnvelope }>;
      for (const r of rows) await h.app.get(RequestLifecycle).apply(r.envelope);
      await h.app.get(ConversationService).sendDue(new Date(Date.now() + 1000));
    };
    const guestThread = async (token: string) =>
      (await h.http().get('/guest/conversation').set('X-Guest-Session', token).expect(200))
        .body as {
        messages: Array<{ senderType: string; type: string; body: string; direction: string }>;
      };

    beforeAll(async () => {
      h = await startCatalogApp(url, 'hotella_app_catalog_notify', { [gmId]: STAFF });
      h.app.get(ChannelAdapterRegistry).register(whatsapp);
      hotel = await createHotel(h, `ntf-${stamp}`, gmId);
      stay = await seedStay(h.db, hotel, '504');
      mona = await guestSession(h, hotel, stay.stayId, stay.primary);
      ali = await guestSession(h, hotel, stay.stayId, stay.companion);
      await h
        .http()
        .post(`${base()}/catalog/starter`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(200);
      channelId = (
        await h
          .http()
          .post(`${base()}/channels`)
          .set('X-Test-Actor', gm())
          .send({
            type: 'WHATSAPP',
            name: 'WhatsApp',
            providerCode: 'FAKE_WHATSAPP',
            credentialRef: 'env://FAKE_SECRET',
          })
          .expect(201)
      ).body.id;
      // Mona proved her WhatsApp number at activation.
      await h.app
        .get(ChannelIdentityService)
        .verify(hotel.tenantId, 'WHATSAPP', MONA_PHONE, stay.primary);
    });
    afterAll(() => h?.app.close());
    beforeEach(() => whatsapp.reset());

    it('outside the 24-hour window the update goes out as the approved template, in the language of the request', async () => {
      const created = await ask(mona, 'EXTRA_TOWELS', { quantity: 2 });
      await work(created, 'accept');
      await work(created, 'start');
      expect(whatsapp.sent).toEqual([
        expect.objectContaining({
          channelId,
          to: MONA_PHONE,
          template: 'service_update',
          parameters: ['مناشف إضافية', 'في الطريق إليك'],
        }),
      ]);
      await work(created, 'complete');
      expect(whatsapp.sent.at(-1)).toMatchObject({
        template: 'service_update',
        parameters: ['مناشف إضافية', 'تم'],
      });
      // The same updates are in the stay conversation on the guest web, in Arabic.
      const thread = await guestThread(mona);
      const system = thread.messages.filter((m) => m.senderType === 'SYSTEM').map((m) => m.body);
      expect(system).toEqual(
        expect.arrayContaining([
          'نعمل على طلبك: مناشف إضافية.',
          'تم: مناشف إضافية. هل يمكننا مساعدتك في شيء آخر؟',
        ]),
      );
    });

    it('once the guest has written on WhatsApp, updates are plain text in the conversation', async () => {
      await h
        .http()
        .post(`/webhooks/whatsapp/${channelId}`)
        .set('content-type', 'application/json')
        .set('x-fake-signature', 'fake')
        .send({
          items: [
            {
              kind: 'MESSAGE',
              providerMessageId: `wamid.${stamp}`,
              from: MONA_PHONE,
              at: new Date().toISOString(),
              type: 'TEXT',
              text: 'شكرا',
              mediaRef: null,
              replyToProviderMessageId: null,
            },
          ],
        })
        .expect(200);
      const created = await ask(mona, 'AC_PROBLEM', { issue: 'TOO_HOT' }, 'en');
      await work(created, 'accept');
      await work(created, 'start');
      expect(whatsapp.sent).toEqual([
        expect.objectContaining({
          to: MONA_PHONE,
          text: 'We are on it: Air conditioning problem.',
        }),
      ]);
    });

    it('a guest without a verified WhatsApp number is told on the guest web only; nobody is told what they did themselves', async () => {
      const created = await ask(ali, 'WIFI_HELP', { issue: 'SLOW' }, 'en');
      await work(created, 'accept');
      await work(created, 'start');
      expect(whatsapp.sent).toEqual([]);
      const [row] = (
        await h.db.execute(sql`select channel_type, delivery_status, body from comms.messages
        where tenant_id = ${hotel.tenantId} and sender_type = 'SYSTEM' order by id desc limit 1`)
      ).rows as Array<{ channel_type: string; delivery_status: string; body: string }>;
      expect(row).toEqual({
        channel_type: 'GUEST_WEB',
        delivery_status: 'SENT',
        body: 'We are on it: Wi-Fi help.',
      });

      const room = await ask(ali, 'ROOM_CLEANING', { preferred_time: 'NOW' }, 'en');
      const before = (
        await h.db
          .execute(sql`select count(*)::int as n from comms.messages where tenant_id = ${hotel.tenantId}
        and sender_type = 'SYSTEM'`)
      ).rows as Array<{ n: number }>;
      await h
        .http()
        .post(`/guest/requests/${room.request.id}/cancel`)
        .set('X-Guest-Session', ali)
        .expect(200);
      const after = (
        await h.db
          .execute(sql`select count(*)::int as n from comms.messages where tenant_id = ${hotel.tenantId}
        and sender_type = 'SYSTEM'`)
      ).rows as Array<{ n: number }>;
      expect(after[0]!.n).toBe(before[0]!.n);
      // Staff cancelling is told.
      const lateCheckout = await ask(mona, 'LATE_CHECKOUT_REQUEST', { until: 'H14' }, 'en');
      await h
        .http()
        .post(`${base()}/service-requests/${lateCheckout.request.id}/cancel`)
        .set('X-Test-Actor', gm())
        .send({ reason: 'Fully booked tomorrow' })
        .expect(200);
      await h.app.get(ConversationService).sendDue(new Date(Date.now() + 1000));
      expect(whatsapp.sent.at(-1)).toMatchObject({
        text: 'Your request was cancelled: Late check-out.',
      });
    });
  },
);
