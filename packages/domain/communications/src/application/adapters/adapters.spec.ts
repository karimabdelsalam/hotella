import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderError, type ProviderContext } from '../providers';
import { BSP_WEBHOOK_SECRET_HEADER, Dialog360WhatsAppAdapter } from './bsp';
import type { FetchLike } from './http';
import { MetaCloudWhatsAppAdapter } from './meta-cloud';
import { JsonHttpSmsAdapter } from './sms-http';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
function recorder(respond: (call: Call) => { status: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call = {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { calls, fetchFn };
}
const ctx = (config: Record<string, unknown>, credential: unknown): ProviderContext => ({
  channelId: 'c1',
  tenantId: 't1',
  propertyId: 'p1',
  config,
  credential: async () => JSON.stringify(credential),
});
const META_CRED = {
  accessToken: 'EAAG-access-token',
  appSecret: 'meta-app-secret',
  verifyToken: 'verify-me-please',
};
const META_CONFIG = {
  phoneNumberId: '1234567890',
  templates: {
    otp: { name: 'hotella_otp', codeButton: true },
    activation: { name: 'hotella_activation' },
  },
};

/** A Cloud API webhook as Meta sends it (trimmed to the fields the platform reads). */
const CLOUD_WEBHOOK = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '201000000000', phone_number_id: '1234567890' },
            contacts: [{ profile: { name: 'Mona' }, wa_id: '201001234567' }],
            messages: [
              {
                from: '201001234567',
                id: 'wamid.TEXT1',
                timestamp: '1791036000',
                type: 'text',
                text: { body: 'الجو حر أوي هنا' },
              },
              {
                from: '201001234567',
                id: 'wamid.IMG1',
                timestamp: '1791036010',
                type: 'image',
                image: { id: 'MEDIA1', caption: 'AC' },
                context: { id: 'wamid.OUT1' },
              },
              {
                from: '201001234567',
                id: 'wamid.BTN1',
                timestamp: '1791036020',
                type: 'interactive',
                interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes' } },
              },
              {
                from: '201001234567',
                id: 'wamid.LOC1',
                timestamp: '1791036030',
                type: 'location',
                location: { latitude: 27.2, longitude: 33.8, name: 'Pool' },
              },
            ],
            statuses: [
              {
                id: 'wamid.OUT1',
                status: 'delivered',
                timestamp: '1791036040',
                recipient_id: '201001234567',
              },
              {
                id: 'wamid.OUT2',
                status: 'failed',
                timestamp: '1791036050',
                recipient_id: '201001234567',
                errors: [{ code: 131047, title: 'Re-engagement message' }],
              },
              { id: 'wamid.OUT3', status: 'deleted', timestamp: '1791036060' },
            ],
          },
        },
      ],
    },
  ],
};

describe('WhatsApp Cloud API through Meta (WHATSAPP_META_CLOUD)', () => {
  it('sends an authentication template with the code in the body and the copy-code button', async () => {
    const { calls, fetchFn } = recorder(() => ({
      status: 200,
      body: { messages: [{ id: 'wamid.SENT1' }] },
    }));
    const adapter = new MetaCloudWhatsAppAdapter(fetchFn);
    const result = await adapter.sendTemplate(
      ctx(adapter.configSchema.parse(META_CONFIG), META_CRED),
      {
        to: '+201001234567',
        template: 'otp',
        locale: 'ar',
        parameters: ['482913'],
      },
    );
    expect(result).toEqual({ providerMessageId: 'wamid.SENT1' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(calls[0]!.headers.authorization).toBe('Bearer EAAG-access-token');
    expect(calls[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '201001234567',
      type: 'template',
      template: {
        name: 'hotella_otp',
        language: { code: 'ar' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '482913' }],
          },
        ],
      },
    });
  });

  it('sends free text as a reply, and refuses templates the channel does not map', async () => {
    const { calls, fetchFn } = recorder(() => ({
      status: 200,
      body: { messages: [{ id: 'wamid.SENT2' }] },
    }));
    const adapter = new MetaCloudWhatsAppAdapter(fetchFn);
    const c = ctx(adapter.configSchema.parse(META_CONFIG), META_CRED);
    await adapter.sendText(c, {
      to: '+201001234567',
      body: 'On our way',
      replyToProviderMessageId: 'wamid.TEXT1',
    });
    expect(calls[0]!.body).toMatchObject({
      type: 'text',
      text: { body: 'On our way' },
      context: { message_id: 'wamid.TEXT1' },
    });
    await expect(
      adapter.sendTemplate(c, { to: '+201', template: 'unknown', locale: 'en', parameters: [] }),
    ).rejects.toMatchObject({
      code: 'REJECTED',
    });
  });

  it.each([
    [401, { error: { code: 190 } }, 'AUTH_FAILED', false],
    [400, { error: { code: 131026 } }, 'INVALID_RECIPIENT', false],
    [400, { error: { code: 131056 } }, 'RATE_LIMITED', true],
    [429, null, 'RATE_LIMITED', true],
    [503, null, 'UNAVAILABLE', true],
    [400, { error: { code: 100 } }, 'REJECTED', false],
  ])('maps HTTP %s %j to %s', async (status, body, code, retryable) => {
    const adapter = new MetaCloudWhatsAppAdapter(recorder(() => ({ status, body })).fetchFn);
    const err = await adapter
      .sendText(ctx(adapter.configSchema.parse(META_CONFIG), META_CRED), {
        to: '+201001234567',
        body: 'x',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code, retryable });
  });

  it('maps network failures and malformed credentials', async () => {
    const down = new MetaCloudWhatsAppAdapter(
      recorder(() => new TypeError('fetch failed')).fetchFn,
    );
    await expect(
      down.sendText(ctx(down.configSchema.parse(META_CONFIG), META_CRED), {
        to: '+201001234567',
        body: 'x',
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    const c = {
      ...ctx(down.configSchema.parse(META_CONFIG), META_CRED),
      credential: async () => 'not-json',
    };
    await expect(down.sendText(c, { to: '+201001234567', body: 'x' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('verifies X-Hub-Signature-256 over the raw body and the subscription token', async () => {
    const adapter = new MetaCloudWhatsAppAdapter();
    const c = ctx(adapter.configSchema.parse(META_CONFIG), META_CRED);
    const raw = Buffer.from(JSON.stringify(CLOUD_WEBHOOK));
    const sig = `sha256=${createHmac('sha256', 'meta-app-secret').update(raw).digest('hex')}`;
    expect(
      await adapter.verifyWebhook(c, { rawBody: raw, headers: { 'x-hub-signature-256': sig } }),
    ).toBe(true);
    expect(
      await adapter.verifyWebhook(c, {
        rawBody: Buffer.from('{}'),
        headers: { 'x-hub-signature-256': sig },
      }),
    ).toBe(false);
    expect(await adapter.verifyWebhook(c, { rawBody: raw, headers: {} })).toBe(false);
    expect(await adapter.verifySubscription(c, 'verify-me-please')).toBe(true);
    expect(await adapter.verifySubscription(c, 'nope')).toBe(false);
  });

  it('normalizes messages (text, media, button replies, location) and receipts; unknown statuses are skipped', () => {
    const items = new MetaCloudWhatsAppAdapter().parseWebhook(ctx({}, META_CRED), CLOUD_WEBHOOK);
    expect(items).toEqual([
      {
        kind: 'MESSAGE',
        providerMessageId: 'wamid.TEXT1',
        from: '+201001234567',
        at: new Date(1791036000_000),
        type: 'TEXT',
        text: 'الجو حر أوي هنا',
        mediaRef: null,
        replyToProviderMessageId: null,
      },
      {
        kind: 'MESSAGE',
        providerMessageId: 'wamid.IMG1',
        from: '+201001234567',
        at: new Date(1791036010_000),
        type: 'IMAGE',
        text: 'AC',
        mediaRef: 'MEDIA1',
        replyToProviderMessageId: 'wamid.OUT1',
      },
      {
        kind: 'MESSAGE',
        providerMessageId: 'wamid.BTN1',
        from: '+201001234567',
        at: new Date(1791036020_000),
        type: 'INTERACTIVE',
        text: 'Yes',
        mediaRef: null,
        replyToProviderMessageId: null,
      },
      {
        kind: 'MESSAGE',
        providerMessageId: 'wamid.LOC1',
        from: '+201001234567',
        at: new Date(1791036030_000),
        type: 'LOCATION',
        text: 'Pool 27.2,33.8',
        mediaRef: null,
        replyToProviderMessageId: null,
      },
      {
        kind: 'STATUS',
        providerMessageId: 'wamid.OUT1',
        status: 'DELIVERED',
        at: new Date(1791036040_000),
        errorCode: null,
      },
      {
        kind: 'STATUS',
        providerMessageId: 'wamid.OUT2',
        status: 'FAILED',
        at: new Date(1791036050_000),
        errorCode: '131047',
      },
    ]);
    expect(
      new MetaCloudWhatsAppAdapter().parseWebhook(ctx({}, META_CRED), { nonsense: true }),
    ).toEqual([]);
  });
});

describe('WhatsApp through a BSP (WHATSAPP_BSP_360DIALOG)', () => {
  const CRED = { apiKey: 'd360-key-123', webhookSecret: 'bsp-webhook-secret-0001' };
  const CONFIG = { templates: { otp: { name: 'otp_v2', codeButton: false } } };

  it('sends the same Cloud API message model to the BSP endpoint with its key header', async () => {
    const { calls, fetchFn } = recorder(() => ({
      status: 200,
      body: { messages: [{ id: 'wamid.BSP1' }] },
    }));
    const adapter = new Dialog360WhatsAppAdapter(fetchFn);
    const result = await adapter.sendTemplate(ctx(adapter.configSchema.parse(CONFIG), CRED), {
      to: '+201001234567',
      template: 'otp',
      locale: 'en',
      parameters: ['112233'],
    });
    expect(result.providerMessageId).toBe('wamid.BSP1');
    expect(calls[0]!.url).toBe('https://waba-v2.360dialog.io/messages');
    expect(calls[0]!.headers['D360-API-KEY']).toBe('d360-key-123');
    expect(calls[0]!.body).toMatchObject({
      type: 'template',
      template: { name: 'otp_v2', components: [{ type: 'body' }] },
    });
  });

  it('authenticates webhooks with the shared secret header and parses the relayed Cloud API payload', async () => {
    const adapter = new Dialog360WhatsAppAdapter();
    const c = ctx(adapter.configSchema.parse(CONFIG), CRED);
    expect(
      await adapter.verifyWebhook(c, {
        rawBody: Buffer.from('{}'),
        headers: { [BSP_WEBHOOK_SECRET_HEADER]: 'bsp-webhook-secret-0001' },
      }),
    ).toBe(true);
    expect(
      await adapter.verifyWebhook(c, {
        rawBody: Buffer.from('{}'),
        headers: { [BSP_WEBHOOK_SECRET_HEADER]: 'wrong' },
      }),
    ).toBe(false);
    expect(adapter.parseWebhook(c, CLOUD_WEBHOOK)).toHaveLength(6);
  });
});

describe('SMS over a JSON HTTP aggregator (SMS_HTTP_JSON)', () => {
  const CRED = { apiKey: 'sms-key-1234', webhookSecret: 'sms-webhook-secret-001' };

  it('posts {to, from, text} with a bearer key and reads the id at the configured path', async () => {
    const { calls, fetchFn } = recorder(() => ({
      status: 200,
      body: { data: { messageId: 98765 } },
    }));
    const adapter = new JsonHttpSmsAdapter(fetchFn);
    const c = ctx(
      adapter.configSchema.parse({
        url: 'https://sms.example/send',
        senderId: 'REDSEA',
        idPath: 'data.messageId',
      }),
      CRED,
    );
    expect(await adapter.sendSms(c, { to: '+201001234567', text: '123456 is your code' })).toEqual({
      providerMessageId: '98765',
    });
    expect(calls[0]!.headers.authorization).toBe('Bearer sms-key-1234');
    expect(calls[0]!.body).toEqual({
      to: '+201001234567',
      from: 'REDSEA',
      text: '123456 is your code',
    });
  });

  it('parses delivery receipts; anything else is ignored', () => {
    const adapter = new JsonHttpSmsAdapter();
    const items = adapter.parseWebhook(ctx({}, CRED), [
      { id: 98765, status: 'delivered', at: '2026-10-03T10:00:00Z' },
      { id: 98766, status: 'failed', error: 'EXPIRED' },
      { id: 98767, status: 'weird' },
    ]);
    expect(items.map((i) => [i.providerMessageId, i.kind === 'STATUS' ? i.status : null])).toEqual([
      ['98765', 'DELIVERED'],
      ['98766', 'FAILED'],
    ]);
  });
});
