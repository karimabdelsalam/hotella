import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SimVoiceOptions {
  /** The platform's webhook for this channel: `{api}/webhooks/voice/{channelId}`. */
  readonly webhookUrl: string;
  readonly signingSecret: string;
  /** The bearer token the platform must present on `/say` and `/transfer`. */
  readonly apiToken: string;
}

export interface SimCall {
  readonly callId: string;
  /** What the platform spoke into this call (text; audio is decoded when it is the FAKE speech encoding). */
  readonly heard: string[];
  /** The extension the call went to, once transferred. */
  transferredTo: string | null;
  /** The caller speaks: sent as audio (UTF-8 bytes, what the FAKE speech provider "hears"), or as text. */
  say(
    words: string,
    opts?: { readonly asText?: boolean; readonly language?: string },
  ): Promise<number>;
  hangUp(): Promise<number>;
}

/**
 * The voice face of the simulator (BUILD_PLAN 13.4): a PBX bridge speaking the Planova Voice Profile v1. It posts signed
 * call events to the platform and serves `/say` and `/transfer`, so a scenario can play "a guest calls from room 214
 * and asks for towels" without telephony.
 */
export class SimulatedVoiceGateway {
  readonly calls = new Map<string, SimCall>();
  private server: Server | null = null;
  private seq = 0;

  constructor(private readonly options: SimVoiceOptions) {}

  /** Starts the gateway API; returns its base URL (the channel's `baseUrl`). */
  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  /** A call from `from` (a room extension such as `214`, or an outside number) to `to`. */
  async dial(from: string, to = '1000'): Promise<SimCall> {
    const callId = `sim-${randomUUID()}`;
    const startedAt = Date.now();
    const call: SimCall = {
      callId,
      heard: [],
      transferredTo: null,
      say: (words, opts) =>
        this.post({
          type: 'call.utterance',
          call_id: callId,
          utterance_id: `u-${++this.seq}`,
          at: new Date().toISOString(),
          ...(opts?.asText
            ? { text: words }
            : { audio_base64: Buffer.from(words).toString('base64'), mime: 'audio/wav' }),
          ...(opts?.language ? { language: opts.language } : {}),
        }),
      hangUp: () =>
        this.post({
          type: 'call.ended',
          call_id: callId,
          at: new Date().toISOString(),
          duration_s: Math.round((Date.now() - startedAt) / 1000),
        }),
    };
    this.calls.set(callId, call);
    await this.post({
      type: 'call.started',
      call_id: callId,
      from,
      to,
      at: new Date(startedAt).toISOString(),
    });
    return call;
  }

  /** Posts one signed event; returns the platform's HTTP status. */
  private async post(event: Record<string, unknown>): Promise<number> {
    const body = JSON.stringify({ events: [event] });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', this.options.signingSecret)
      .update(`${t}.${body}`)
      .digest('hex');
    const res = await fetch(this.options.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hotella-signature': `t=${t},v1=${v1}` },
      body,
    });
    await res.arrayBuffer();
    return res.status;
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let data = '';
    for await (const chunk of req) data += String(chunk);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${this.options.apiToken}`) return reply(401, {});
    let body: {
      to?: string;
      text?: string;
      audio_base64?: string;
      mime?: string;
      extension?: string;
    };
    try {
      body = JSON.parse(data || '{}') as typeof body;
    } catch {
      return reply(400, {});
    }
    const call = body.to ? this.calls.get(body.to) : undefined;
    if (!call || call.transferredTo) return reply(410, {});
    if (req.method === 'POST' && req.url === '/say') {
      call.heard.push(
        body.audio_base64 && body.mime === 'audio/x-fake'
          ? Buffer.from(body.audio_base64, 'base64')
              .toString()
              .replace(/^\[[^\]]*\] /, '')
          : (body.text ?? ''),
      );
      return reply(200, { id: `say-${++this.seq}` });
    }
    if (req.method === 'POST' && req.url === '/transfer' && body.extension) {
      call.transferredTo = body.extension;
      return reply(200, {});
    }
    return reply(404, {});
  }
}
