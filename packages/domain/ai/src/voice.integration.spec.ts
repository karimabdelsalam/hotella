import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, like, sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { CATALOG_API, type CatalogPublicApi } from '@hotella/domain-catalog/public';
import {
  COMMUNICATIONS_API,
  type CommunicationsPublicApi,
  ConversationService,
  voiceSignature,
  VoiceService,
} from '@hotella/domain-communications';
import { newId } from '@hotella/platform-database';
import { eventsSchema } from '@hotella/platform-events';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConciergeRuntime } from './application/concierge.runtime';
import { ModelGatewayService } from './application/gateway.service';
import { ModelProviderRegistry } from './application/provider-registry';
import { FakeModelProvider } from './application/providers/fake';
import {
  ADMIN,
  type AiHarness,
  createHotel,
  type Hotel,
  LICENSING,
  staff,
  startAiApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const VOICE = { signingSecret: 'voice-signing-secret-0001', apiToken: 'voice-api-token-00000001' };

/**
 * The voice channel (BUILD_PLAN 13.4): a guest calls from the room phone and asks for towels; the words are transcribed
 * through the Model Gateway (FAKE on-prem speech), the concierge creates EXTRA_TOWELS and its answer is spoken into the
 * live call. Unknown callers and hand-offs go to the operator; speech refused by the egress policy also does.
 */
describe.skipIf(needsInfra())(`Voice channel (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const fake = new FakeModelProvider();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'catalog.read',
    'catalog.manage',
    'catalog.publish',
    'request.read',
    'channel.manage',
    'inbox.read',
    'inbox.reply',
    'inbox.takeover',
    'ai.routing.manage',
    'ai.execution.read',
  ];
  let h: AiHarness;
  let hotel: Hotel;
  let other: Hotel;
  let channelId: string;
  let server: Server;
  let catalog: CatalogPublicApi;
  const gateway: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}`;
  const T0 = Date.now();
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();

  const post = (events: unknown[], secret = VOICE.signingSecret, id = channelId) => {
    const raw = JSON.stringify({ events });
    return h
      .http()
      .post(`/webhooks/voice/${id}`)
      .set('content-type', 'application/json')
      .set('x-hotella-signature', voiceSignature(secret, raw, new Date()))
      .send(raw);
  };
  const callRow = async (providerCallId: string) =>
    (
      await h.db.execute(
        sql`select * from comms.calls where tenant_id = ${hotel.tenantId} and provider_call_id = ${providerCallId}`,
      )
    ).rows[0] as Record<string, unknown>;
  const received = async (messageId?: string) => {
    const rows = await h.db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, hotel.tenantId),
          eq(eventsSchema.outbox.eventType, 'comms.message.received'),
        ),
      );
    const envelopes = rows.map((r) => r.envelope as EventEnvelope);
    return messageId
      ? envelopes.find((e) => (e.payload as { message_id: string }).message_id === messageId)!
      : envelopes.at(-1)!;
  };
  const asWorker = (envelope: EventEnvelope) => {
    const p = envelope.payload as { conversation_id: string; message_id: string };
    return h.app
      .get(RequestContext)
      .run({ tenant_id: envelope.tenant_id, property_id: envelope.property_id }, () =>
        h.app.get(ConciergeRuntime).onGuestMessage({
          tenantId: envelope.tenant_id!,
          conversationId: p.conversation_id,
          messageId: p.message_id,
        }),
      );
  };
  const route = async (capability: string, code: string, egress: string, maxDataClass: string) => {
    const providerId = (
      await h
        .http()
        .post('/ai/providers')
        .set('X-Test-Actor', ADMIN)
        .send({
          code: `${code}_${stamp}`,
          kind: 'FAKE',
          egress,
          maxDataClass,
          ...(egress === 'EXTERNAL' ? { credentialRef: 'env://CLOUD_KEY' } : {}),
        })
        .expect(201)
    ).body.id;
    const modelId = (
      await h
        .http()
        .post('/ai/models')
        .set('X-Test-Actor', ADMIN)
        .send({ providerId, code: `${code.toLowerCase()}-${stamp}`, capabilities: [capability] })
        .expect(201)
    ).body.id;
    await h
      .http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability, modelIds: [modelId] })
      .expect(200);
  };
  const setting = (key: string, value: unknown) =>
    h
      .http()
      .put(`/config/values/${key}`)
      .set('X-Test-Actor', ADMIN)
      .send({ scope: 'PROPERTY', tenantId: hotel.tenantId, propertyId: hotel.propertyId, value })
      .expect(200);

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c.toString()));
      req.on('end', () => {
        gateway.push({
          path: req.url ?? '',
          auth: req.headers.authorization,
          body: JSON.parse(data || '{}') as Record<string, unknown>,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `say-${gateway.length}` }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    h = await startAiApp(
      url,
      'hotella_app_ai_voice',
      { [gmId]: STAFF },
      {
        secrets: { VOICE_CRED: JSON.stringify(VOICE) },
      },
    );
    h.app.get(ModelProviderRegistry).register(fake);
    catalog = h.app.get(CATALOG_API);
    hotel = await createHotel(h, `voice-${stamp}`, gmId);
    other = await createHotel(h, `voice-b-${stamp}`, gmId);
    await route('REASONING_HIGH', 'VOICE_R', 'ON_PREM', 'SENSITIVE');
    await setting('comms.ai_mode.default', 'AUTO');
    channelId = (
      await h
        .http()
        .post(`${base()}/channels`)
        .set('X-Test-Actor', gm())
        .send({
          type: 'VOICE',
          name: 'Room phones',
          providerCode: 'VOICE_GATEWAY_STANDARD',
          config: { baseUrl: gatewayUrl, operatorExtension: '9' },
          credentialRef: 'env://VOICE_CRED',
        })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await h?.app.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it('refuses forged or unknown deliveries; outside numbers and extensions not in the directory go to the operator', async () => {
    const started = (id: string, from: string) => ({
      type: 'call.started',
      call_id: id,
      from,
      to: '1000',
      at: at(0),
    });
    await post([started('forged', '504')], 'not-the-signing-secret').expect(401);
    await post([started('unknown', '504')], VOICE.signingSecret, newId()).expect(404);
    expect(await callRow('forged')).toBeUndefined();

    // Room context needs the extension directory (ADR-0025): 504 is not in it yet, so it is an unknown extension.
    const res = await post([
      started('ext-1', '+201001234567'),
      started('room-early', '504'),
    ]).expect(200);
    expect(res.body).toEqual({ received: 2, applied: 2 });
    expect(gateway.filter((g) => g.path === '/transfer').map((g) => g.body)).toEqual([
      { to: 'ext-1', extension: '9' },
      { to: 'room-early', extension: '9' },
    ]);
    expect(gateway[0]!.auth).toBe(`Bearer ${VOICE.apiToken}`);
    expect(await callRow('room-early')).toMatchObject({
      status: 'TRANSFERRED',
      transfer_reason: 'UNTRUSTED_CALLER',
      caller_kind: 'UNKNOWN',
      conversation_id: null,
    });
    expect(await callRow('ext-1')).toMatchObject({ caller_kind: 'EXTERNAL' });
    // A repeated delivery changes nothing.
    await post([started('ext-1', '+201001234567')]).expect(200, { received: 1, applied: 0 });
  });

  it('a room-phone call has room context: spoken words become a request and the answer is spoken back', async () => {
    const directory = `${base()}/channels/${channelId}/extensions`;
    await h
      .http()
      .put(directory)
      .set('X-Test-Actor', gm())
      .send({
        entries: [
          { extension: '504', kind: 'ROOM', roomId: hotel.roomId },
          { extension: '100', kind: 'PUBLIC' },
        ],
      })
      .expect(200);
    // A room of another hotel cannot be put in this directory.
    await h
      .http()
      .put(directory)
      .set('X-Test-Actor', gm())
      .send({ entries: [{ extension: '900', kind: 'ROOM', roomId: other.roomId }] })
      .expect(422);
    await route('AUDIO', 'VOICE_S', 'ON_PREM', 'SENSITIVE');
    // The lobby phone is a public-area extension: operator.
    await post([
      { type: 'call.started', call_id: 'lobby-1', from: '100', to: '1000', at: at(0) },
    ]).expect(200);
    expect(await callRow('lobby-1')).toMatchObject({
      status: 'TRANSFERRED',
      caller_kind: 'PUBLIC',
      transfer_reason: 'UNTRUSTED_CALLER',
    });
    await post([
      { type: 'call.started', call_id: 'call-1', from: '504', to: '1000', at: at(0) },
    ]).expect(200, { received: 1, applied: 1 });
    const call = await callRow('call-1');
    expect(call).toMatchObject({ status: 'ANSWERED', stay_id: hotel.stayId, caller_kind: 'ROOM' });
    const conversation = (
      await h.db.execute(
        sql`select reply_channel_type, reply_channel_id from comms.conversations where id = ${call.conversation_id as string}`,
      )
    ).rows[0];
    expect(conversation).toEqual({ reply_channel_type: 'VOICE', reply_channel_id: channelId });

    const words = 'I need two more towels please';
    await post([
      {
        type: 'call.utterance',
        call_id: 'call-1',
        utterance_id: 'u-1',
        at: at(5),
        audio_base64: Buffer.from(words).toString('base64'),
        mime: 'audio/wav',
        language: 'en',
      },
    ]).expect(200, { received: 1, applied: 1 });
    const [message] = (
      await h.db.execute(
        sql`select body, channel_type, type, media_ref from comms.messages where conversation_id = ${call.conversation_id as string} and direction = 'INBOUND'`,
      )
    ).rows;
    // Only the words are kept: no audio, no media reference (Q23).
    expect(message).toEqual({ body: words, channel_type: 'VOICE', type: 'TEXT', media_ref: null });
    const speech = (
      await h.db.execute(
        sql`select count(*)::int as n from ai.model_calls where tenant_id = ${hotel.tenantId} and capability = 'AUDIO' and outcome = 'OK'`,
      )
    ).rows[0] as { n: number };
    expect(speech.n).toBe(1);

    // Room context (Q27): the room, not the person. The guest's details are not readable; the name is not in context.
    let seen = '';
    let refused: unknown;
    fake.reset();
    fake.reply(
      (request) => {
        seen = JSON.stringify(request.messages);
        return { toolCalls: [{ id: 'g', name: 'guest__get_current_stay', arguments: {} }] };
      },
      (request) => {
        const tool = [...request.messages].reverse().find((m) => m.role === 'tool');
        refused = tool ? JSON.parse(tool.content) : null;
        return {
          toolCalls: [
            {
              id: 't',
              name: 'operations__create_service_request',
              arguments: { service_code: 'EXTRA_TOWELS', fields: { quantity: 2 } },
            },
          ],
        };
      },
      { content: JSON.stringify({ reply: 'Two towels are on their way.', handoff: null }) },
    );
    expect(await asWorker(await received())).toBe('REPLIED');
    expect(refused).toMatchObject({ status: 'REFUSED' });
    expect(seen).toContain('not the person speaking');
    expect(seen).not.toContain('Mona');
    const [towels] = (await catalog.serviceRequestsOfStay(hotel.tenantId, hotel.stayId)).filter(
      (r) => r.serviceCode === 'EXTRA_TOWELS',
    );
    expect(towels).toMatchObject({ status: 'OPEN', source: 'AI' });

    expect(await h.app.get(ConversationService).sendDue()).toBe(1);
    const said = gateway.filter((g) => g.path === '/say').at(-1)!;
    expect(said.body).toMatchObject({
      to: 'call-1',
      text: 'Two towels are on their way.',
      mime: 'audio/x-fake',
    });
    expect(Buffer.from(said.body.audio_base64 as string, 'base64').toString()).toBe(
      '[auto] Two towels are on their way.',
    );

    // The call ends: 95 s answered by the platform → 2 VOICE_MINUTES, metered once; replies return to the guest web.
    const end = { type: 'call.ended', call_id: 'call-1', at: at(95), duration_s: 95 };
    await post([end]).expect(200, { received: 1, applied: 1 });
    await post([end]).expect(200, { received: 1, applied: 0 });
    expect(await callRow('call-1')).toMatchObject({ status: 'ENDED', duration_s: 95 });
    const minutes = LICENSING.usage.filter((u) => u.metric === 'VOICE_MINUTES');
    expect(minutes).toEqual([
      expect.objectContaining({ quantity: 2, idempotencyKey: `call:${call.id as string}` }),
    ]);
    const after = (
      await h.db.execute(
        sql`select reply_channel_type, reply_channel_id from comms.conversations where id = ${call.conversation_id as string}`,
      )
    ).rows[0];
    expect(after).toEqual({ reply_channel_type: 'GUEST_WEB', reply_channel_id: null });
    const types = (
      await h.db
        .select({ type: eventsSchema.outbox.eventType })
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.tenantId, hotel.tenantId),
            like(eventsSchema.outbox.eventType, 'comms.call.%'),
          ),
        )
    ).map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['comms.call.started', 'comms.call.ended']));
  });

  it('guest speech stays on-premises: an external speech provider is not used without the hotel approval (Q22)', async () => {
    // Even a cloud provider allowed to receive SENSITIVE data is skipped: the hotel has not approved cloud speech.
    await route('AUDIO', 'VOICE_X', 'EXTERNAL', 'SENSITIVE');
    await expect(
      h.app.get(ModelGatewayService).transcribe({
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        audio: new TextEncoder().encode('hello'),
        mimeType: 'audio/wav',
        dataClass: 'SENSITIVE',
      }),
    ).rejects.toMatchObject({ code: 'ai.gateway.unavailable' });
    await post([
      { type: 'call.started', call_id: 'call-2', from: '504', to: '1000', at: at(200) },
      {
        type: 'call.utterance',
        call_id: 'call-2',
        utterance_id: 'u-1',
        at: at(203),
        audio_base64: Buffer.from('hello').toString('base64'),
        mime: 'audio/wav',
      },
    ]).expect(200);
    expect(await callRow('call-2')).toMatchObject({
      status: 'TRANSFERRED',
      transfer_reason: 'SPEECH_FAILED',
    });
    expect(gateway.at(-1)).toMatchObject({
      path: '/transfer',
      body: { to: 'call-2', extension: '9' },
    });
    // The approval is recorded with who approved it and when; "enabled" alone is refused.
    await h
      .http()
      .put('/config/values/ai.speech.external')
      .set('X-Test-Actor', ADMIN)
      .send({
        scope: 'PROPERTY',
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        value: { enabled: true },
      })
      .expect(422);
    await route('AUDIO', 'VOICE_S2', 'ON_PREM', 'SENSITIVE');
  });

  it('a hand-off during a live call transfers it; later calls of the handed-off stay go straight to the operator', async () => {
    await post([
      { type: 'call.started', call_id: 'call-3', from: '504', to: '1000', at: at(300) },
    ]).expect(200);
    const call = await callRow('call-3');
    expect(call.status).toBe('ANSWERED');
    await h.app.get<CommunicationsPublicApi>(COMMUNICATIONS_API).handOff({
      tenantId: hotel.tenantId,
      conversationId: call.conversation_id as string,
      reason: 'guest asked for a person',
    });
    const [handoff] = await h.db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, hotel.tenantId),
          eq(eventsSchema.outbox.eventType, 'comms.handoff.requested'),
        ),
      );
    await h.app.get(VoiceService).apply(handoff!.envelope as EventEnvelope);
    expect(await callRow('call-3')).toMatchObject({
      status: 'TRANSFERRED',
      transfer_reason: 'HANDOFF',
    });
    expect(gateway.at(-1)).toMatchObject({ path: '/transfer', body: { to: 'call-3' } });

    await post([
      { type: 'call.started', call_id: 'call-4', from: '504', to: '1000', at: at(400) },
    ]).expect(200);
    expect(await callRow('call-4')).toMatchObject({
      status: 'TRANSFERRED',
      transfer_reason: 'HANDED_OFF',
    });
  });

  it('staff see the calls of their property only; another tenant learns nothing', async () => {
    const directory = `${base()}/channels/${channelId}/extensions`;
    // Prefilling from room numbers adds rooms that have no entry yet; 504 is already a room phone.
    const prefilled = await h
      .http()
      .post(`${directory}/rooms-by-number`)
      .set('X-Test-Actor', gm())
      .send({ prefix: '' })
      .expect(200);
    expect(prefilled.body).toEqual({ added: 0 });
    const entries = (await h.http().get(directory).set('X-Test-Actor', gm()).expect(200))
      .body as Array<{ extension: string; kind: string }>;
    expect(entries.map((e) => `${e.extension}:${e.kind}`)).toEqual(['100:PUBLIC', '504:ROOM']);
    await h.http().get(directory).set('X-Test-Actor', staff(gmId, other.tenantId)).expect(404);
    const list = await h.http().get(`${base()}/calls`).set('X-Test-Actor', gm()).expect(200);
    const ids = (list.body as Array<{ status: string; transferReason: string | null }>).map(
      (c) => c.transferReason,
    );
    expect(ids).toEqual(
      expect.arrayContaining(['UNTRUSTED_CALLER', 'SPEECH_FAILED', 'HANDOFF', 'HANDED_OFF', null]),
    );
    expect(JSON.stringify(list.body)).not.toContain('+20100');
    await h
      .http()
      .get(`${base()}/calls`)
      .set('X-Test-Actor', staff(gmId, other.tenantId))
      .expect(404);
    const theirs = await h
      .http()
      .get(`/properties/${other.propertyId}/calls`)
      .set('X-Test-Actor', staff(gmId, other.tenantId))
      .expect(200);
    expect(theirs.body).toEqual([]);
  });
});
