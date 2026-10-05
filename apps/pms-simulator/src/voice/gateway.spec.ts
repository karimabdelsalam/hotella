import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedVoiceGateway } from './gateway';

const SECRET = 'sim-voice-signing-secret';
const TOKEN = 'sim-voice-api-token-0001';

describe('SimulatedVoiceGateway', () => {
  let platform: Server;
  let gateway: SimulatedVoiceGateway;
  let gatewayUrl: string;
  const received: Array<{ type: string; valid: boolean }> = [];

  beforeAll(async () => {
    // A stand-in platform webhook that checks the profile's signature.
    platform = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const [t, v1] = String(req.headers['x-hotella-signature'])
          .split(',')
          .map((p) => p.split('=')[1]);
        const valid =
          createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex') === v1 &&
          Math.abs(Date.now() / 1000 - Number(t)) < 300;
        for (const e of (JSON.parse(raw) as { events: Array<{ type: string }> }).events)
          received.push({ type: e.type, valid });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => platform.listen(0, '127.0.0.1', () => r()));
    const port = (platform.address() as AddressInfo).port;
    gateway = new SimulatedVoiceGateway({
      webhookUrl: `http://127.0.0.1:${port}/webhooks/voice/c1`,
      signingSecret: SECRET,
      apiToken: TOKEN,
    });
    gatewayUrl = await gateway.start();
  });
  afterAll(async () => {
    await gateway.stop();
    await new Promise<void>((r) => platform.close(() => r()));
  });

  it('posts signed call events and serves /say and /transfer to the platform only', async () => {
    const call = await gateway.dial('214');
    expect(await call.say('two towels please')).toBe(200);
    expect(await call.hangUp()).toBe(200);
    expect(received).toEqual([
      { type: 'call.started', valid: true },
      { type: 'call.utterance', valid: true },
      { type: 'call.ended', valid: true },
    ]);

    const say = (auth: string, body: unknown) =>
      fetch(`${gatewayUrl}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
      });
    expect((await say('Bearer wrong', { to: call.callId, text: 'x' })).status).toBe(401);
    const ok = await say(`Bearer ${TOKEN}`, {
      to: call.callId,
      text: 'On their way.',
      audio_base64: Buffer.from('[auto] On their way.').toString('base64'),
      mime: 'audio/x-fake',
    });
    expect(ok.status).toBe(200);
    expect(call.heard).toEqual(['On their way.']);

    const transfer = await fetch(`${gatewayUrl}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ to: call.callId, extension: '9' }),
    });
    expect(transfer.status).toBe(200);
    expect(call.transferredTo).toBe('9');
    // A transferred call no longer hears the platform.
    expect((await say(`Bearer ${TOKEN}`, { to: call.callId, text: 'x' })).status).toBe(410);
  });
});
