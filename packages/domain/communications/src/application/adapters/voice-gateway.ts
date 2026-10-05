import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  type ProviderContext,
  ProviderError,
  type SendResult,
  type VoiceEvent,
  type VoiceProvider,
  type WebhookRequest,
} from '../providers';
import { callProvider, credentialJson, type FetchLike, statusError } from './http';

/** How long a signed voice event stays acceptable (replay window, as for inbound endpoints). */
export const VOICE_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Utterance audio larger than this is refused at the adapter (about a minute of compressed speech). */
export const MAX_UTTERANCE_AUDIO_BYTES = 2 * 1024 * 1024;

const extension = z.string().regex(/^[0-9*#]{1,16}$/);

const config = z.object({
  /** The gateway's API (`/say`, `/transfer`). */
  baseUrl: z.url(),
  /** Where calls go that the platform does not answer: unknown callers, hand-offs, speech failures. */
  operatorExtension: extension,
});

/** Credential JSON (one SecretRef): the secret that signs the gateway's events and the token for its API. */
const credential = z.object({
  signingSecret: z.string().min(16),
  apiToken: z.string().min(16),
});

const at = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const callId = z.string().min(1).max(64);
const event = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call.started'),
    call_id: callId,
    from: z.string().min(1).max(32),
    to: z.string().min(1).max(32),
    at,
  }),
  z.object({
    type: z.literal('call.utterance'),
    call_id: callId,
    utterance_id: z.string().min(1).max(64),
    at,
    text: z.string().max(4000).optional(),
    audio_base64: z
      .string()
      .max(Math.ceil((MAX_UTTERANCE_AUDIO_BYTES * 4) / 3) + 4)
      .optional(),
    mime: z
      .string()
      .regex(/^audio\/[a-z0-9.+-]{1,40}$/)
      .optional(),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
      .optional(),
  }),
  z.object({
    type: z.literal('call.ended'),
    call_id: callId,
    at,
    duration_s: z.number().int().min(0).max(86_400),
  }),
]);
const webhookBody = z.object({ events: z.array(event).min(1).max(50) });

/**
 * The Planova Voice Profile v1 (BUILD_PLAN 13.4) over HTTPS: the gateway posts signed events
 * (`X-Hotella-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signingSecret, "<t>.<raw body>")>`) and accepts
 * `POST {baseUrl}/say` and `POST {baseUrl}/transfer` with a bearer token. Vendor-neutral: a PBX bridge or SIP service
 * implements the profile (Q21).
 */
export class VoiceGatewayAdapter implements VoiceProvider {
  readonly kind = 'VOICE' as const;
  readonly code = 'VOICE_GATEWAY_STANDARD';
  readonly channelType = 'VOICE' as const;
  readonly configSchema = config;

  constructor(
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async creds(ctx: ProviderContext) {
    const parsed = credential.safeParse(credentialJson(await ctx.credential()));
    if (!parsed.success) throw new ProviderError('AUTH_FAILED', false);
    return parsed.data;
  }

  async verifyWebhook(ctx: ProviderContext, req: WebhookRequest): Promise<boolean> {
    const { signingSecret } = await this.creds(ctx);
    return validVoiceSignature(
      signingSecret,
      req.headers['x-hotella-signature'],
      req.rawBody,
      this.now(),
    );
  }

  parseVoiceWebhook(_ctx: ProviderContext, body: unknown): VoiceEvent[] {
    const parsed = webhookBody.safeParse(body);
    if (!parsed.success) return [];
    const out: VoiceEvent[] = [];
    for (const e of parsed.data.events) {
      if (e.type === 'call.started')
        out.push({ kind: 'CALL_STARTED', callId: e.call_id, from: e.from, to: e.to, at: e.at });
      else if (e.type === 'call.ended')
        out.push({
          kind: 'CALL_ENDED',
          callId: e.call_id,
          at: e.at,
          durationSeconds: e.duration_s,
        });
      else {
        const audio =
          e.audio_base64 && e.mime
            ? { data: new Uint8Array(Buffer.from(e.audio_base64, 'base64')), mimeType: e.mime }
            : null;
        const text = e.text?.trim() ? e.text.trim() : null;
        // An utterance with neither words nor usable audio carries nothing.
        if (!text && (!audio || audio.data.byteLength === 0)) continue;
        if (audio && audio.data.byteLength > MAX_UTTERANCE_AUDIO_BYTES) continue;
        out.push({
          kind: 'UTTERANCE',
          callId: e.call_id,
          utteranceId: e.utterance_id,
          at: e.at,
          text,
          audio: text ? null : audio,
          language: e.language ?? null,
        });
      }
    }
    return out;
  }

  async say(
    ctx: ProviderContext,
    m: {
      callId: string;
      text: string;
      audio: { data: Uint8Array; mimeType: string } | null;
    },
  ): Promise<SendResult> {
    const body = await this.call(ctx, '/say', {
      to: m.callId,
      text: m.text,
      ...(m.audio
        ? { audio_base64: Buffer.from(m.audio.data).toString('base64'), mime: m.audio.mimeType }
        : {}),
    });
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 120)
      throw new ProviderError('REJECTED', false);
    return { providerMessageId: id };
  }

  async transfer(ctx: ProviderContext, c: { callId: string; extension: string }): Promise<void> {
    await this.call(ctx, '/transfer', { to: c.callId, extension: extension.parse(c.extension) });
  }

  private async call(ctx: ProviderContext, path: string, body: unknown): Promise<unknown> {
    const { apiToken } = await this.creds(ctx);
    const base = config.parse(ctx.config).baseUrl.replace(/\/+$/, '');
    return callProvider(
      this.fetchFn,
      `${base}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
        body: JSON.stringify(body),
      },
      (status) =>
        status === 404 || status === 410
          ? new ProviderError('INVALID_RECIPIENT', false)
          : statusError(status),
    );
  }
}

/** Constant-time check of the profile's signature with its replay window. */
export function validVoiceSignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer,
  now: Date,
  toleranceSeconds = VOICE_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries(
    (header ?? '')
      .split(',')
      .map((p) => p.trim().split('=', 2))
      .filter((p): p is [string, string] => p.length === 2),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1!, 'hex'));
}

/** The header a gateway (or a test, or the simulator) sends with a body. */
export function voiceSignature(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
