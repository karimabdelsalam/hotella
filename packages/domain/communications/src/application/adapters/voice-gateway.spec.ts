import { describe, expect, it } from 'vitest';
import { ProviderError, type ProviderContext } from '../providers';
import type { FetchLike } from './http';
import {
  MAX_UTTERANCE_AUDIO_BYTES,
  validVoiceSignature,
  VoiceGatewayAdapter,
  voiceSignature,
} from './voice-gateway';

const CRED = { signingSecret: 'voice-signing-secret-1', apiToken: 'voice-api-token-123456' };
const CONFIG = { baseUrl: 'https://pbx.example.test/hotella/', operatorExtension: '0' };
const ctx = (config: Record<string, unknown> = CONFIG): ProviderContext => ({
  channelId: 'c1',
  tenantId: 't1',
  propertyId: 'p1',
  config,
  credential: async () => JSON.stringify(CRED),
});
const NOW = new Date('2026-10-05T10:00:00Z');

function recorder(status = 200, body: unknown = { id: 'say-1' }) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

describe('Planova Voice Profile v1 adapter', () => {
  it('accepts a fresh signature over the raw body and refuses stale, tampered or missing ones', async () => {
    const adapter = new VoiceGatewayAdapter(undefined, () => NOW);
    const body = JSON.stringify({ events: [] });
    const header = voiceSignature(CRED.signingSecret, body, NOW);
    const req = (h: string | undefined, raw = body) => ({
      rawBody: Buffer.from(raw),
      headers: { 'x-hotella-signature': h },
    });
    expect(await adapter.verifyWebhook(ctx(), req(header))).toBe(true);
    expect(await adapter.verifyWebhook(ctx(), req(header, `${body} `))).toBe(false);
    expect(await adapter.verifyWebhook(ctx(), req(undefined))).toBe(false);
    const stale = voiceSignature(CRED.signingSecret, body, new Date(NOW.getTime() - 301_000));
    expect(await adapter.verifyWebhook(ctx(), req(stale))).toBe(false);
    expect(validVoiceSignature('another-secret-xyz1', header, Buffer.from(body), NOW)).toBe(false);
  });

  it('normalizes call events; audio-only utterances keep the audio, worded ones drop it', () => {
    const adapter = new VoiceGatewayAdapter();
    const events = adapter.parseVoiceWebhook(ctx(), {
      events: [
        { type: 'call.started', call_id: 'c-1', from: '214', to: '9', at: NOW.toISOString() },
        {
          type: 'call.utterance',
          call_id: 'c-1',
          utterance_id: 'u-1',
          at: NOW.toISOString(),
          audio_base64: Buffer.from('two towels please').toString('base64'),
          mime: 'audio/wav',
          language: 'en',
        },
        {
          type: 'call.utterance',
          call_id: 'c-1',
          utterance_id: 'u-2',
          at: NOW.toISOString(),
          text: '  thanks ',
          audio_base64: 'AAAA',
          mime: 'audio/wav',
        },
        { type: 'call.utterance', call_id: 'c-1', utterance_id: 'u-3', at: NOW.toISOString() },
        { type: 'call.ended', call_id: 'c-1', at: NOW.toISOString(), duration_s: 42 },
      ],
    });
    expect(events.map((e) => e.kind)).toEqual([
      'CALL_STARTED',
      'UTTERANCE',
      'UTTERANCE',
      'CALL_ENDED',
    ]);
    const [, audio, worded] = events;
    expect(audio).toMatchObject({ text: null, language: 'en', audio: { mimeType: 'audio/wav' } });
    expect(Buffer.from((audio as { audio: { data: Uint8Array } }).audio.data).toString()).toBe(
      'two towels please',
    );
    expect(worded).toMatchObject({ text: 'thanks', audio: null });
    expect(events[3]).toMatchObject({ durationSeconds: 42 });
  });

  it('refuses malformed bodies and oversized audio', () => {
    const adapter = new VoiceGatewayAdapter();
    expect(adapter.parseVoiceWebhook(ctx(), { nonsense: true })).toEqual([]);
    expect(
      adapter.parseVoiceWebhook(ctx(), {
        events: [{ type: 'call.started', call_id: 'c', from: '1', to: '2', at: 'yesterday' }],
      }),
    ).toEqual([]);
    const big = Buffer.alloc(MAX_UTTERANCE_AUDIO_BYTES + 1).toString('base64');
    expect(
      adapter.parseVoiceWebhook(ctx(), {
        events: [
          {
            type: 'call.utterance',
            call_id: 'c',
            utterance_id: 'u',
            at: NOW.toISOString(),
            audio_base64: big,
            mime: 'audio/wav',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('speaks into the call and transfers it with the bearer token', async () => {
    const { calls, fetchFn } = recorder();
    const adapter = new VoiceGatewayAdapter(fetchFn);
    const said = await adapter.say(ctx(), {
      callId: 'c-1',
      text: 'Towels are on their way.',
      audio: { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/x-fake' },
    });
    expect(said.providerMessageId).toBe('say-1');
    await adapter.transfer(ctx(), { callId: 'c-1', extension: '0' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://pbx.example.test/hotella/say',
      'https://pbx.example.test/hotella/transfer',
    ]);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${CRED.apiToken}`);
    expect(calls[0]!.body).toEqual({
      to: 'c-1',
      text: 'Towels are on their way.',
      audio_base64: 'AQID',
      mime: 'audio/x-fake',
    });
    expect(calls[1]!.body).toEqual({ to: 'c-1', extension: '0' });
  });

  it('maps a gone call to INVALID_RECIPIENT and a missing id to REJECTED', async () => {
    const gone = new VoiceGatewayAdapter(recorder(410, {}).fetchFn);
    await expect(gone.say(ctx(), { callId: 'c-1', text: 'hi', audio: null })).rejects.toMatchObject(
      { code: 'INVALID_RECIPIENT' },
    );
    const noId = new VoiceGatewayAdapter(recorder(200, {}).fetchFn);
    await expect(
      noId.say(ctx(), { callId: 'c-1', text: 'hi', audio: null }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('validates its configuration', () => {
    const adapter = new VoiceGatewayAdapter();
    expect(adapter.configSchema.safeParse(CONFIG).success).toBe(true);
    expect(adapter.configSchema.safeParse({ ...CONFIG, operatorExtension: 'desk' }).success).toBe(
      false,
    );
    expect(adapter.configSchema.safeParse({ ...CONFIG, roomExtensionPrefix: '7' }).success).toBe(
      true,
    );
  });
});
