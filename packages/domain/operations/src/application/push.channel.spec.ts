import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '@hotella/platform-config';
import type { SecretResolver } from '@hotella/platform-secrets';
import { FcmPushChannel, PushSendError, PushTokenGoneError } from './push.channel';

/** A local stand-in for Google's OAuth token endpoint and FCM HTTP v1. */
describe('FCM push channel', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    client_email: 'hotella-push@demo-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const seen: Array<{ path: string; auth?: string; body: string }> = [];
  let server: Server;
  let base: string;
  let tokenCalls = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/token') {
          tokenCalls++;
          res.end(JSON.stringify({ access_token: 'ya29.access', expires_in: 3600 }));
          return;
        }
        const token = (JSON.parse(body) as { message: { token: string } }).message.token;
        if (token === 'gone') {
          res.statusCode = 404;
          res.end(
            JSON.stringify({
              error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
            }),
          );
        } else if (token === 'busy') {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { status: 'UNAVAILABLE' } }));
        } else res.end(JSON.stringify({ name: 'projects/demo-project/messages/1' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const channel = (push: AppConfig['notifications']['push']) =>
    new FcmPushChannel(
      { notifications: { push } } as AppConfig,
      { resolve: async () => JSON.stringify(account) } as unknown as SecretResolver,
      { fcm: base, tokenUri: `${base}/token` },
    );
  const message = (token: string) => ({
    token,
    platform: 'ANDROID' as const,
    title: 'Escalation',
    body: 'Open the app to see it.',
    data: { intent_id: 'i1', category: 'ESCALATION' },
  });

  it('is off without a project and credentials', () => {
    expect(channel(null).configured).toBe(false);
  });

  it('mints one access token with a signed service-account JWT and sends notification + references', async () => {
    const fcm = channel({
      projectId: 'demo-project',
      credentialsRef: 'vault://kv/hotella/app#fcm',
    });
    expect(fcm.configured).toBe(true);
    expect(await fcm.send(message('device-token-1'))).toEqual({
      providerRef: 'projects/demo-project/messages/1',
    });
    await fcm.send(message('device-token-2'));
    expect(tokenCalls).toBe(1);

    const grant = new URLSearchParams(seen.find((s) => s.path === '/token')!.body);
    expect(grant.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = grant.get('assertion')!.split('.');
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, signature!, 'base64url'),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: `${base}/token`,
    });

    const send = seen.find((s) => s.path === '/v1/projects/demo-project/messages:send')!;
    expect(send.auth).toBe('Bearer ya29.access');
    expect(JSON.parse(send.body)).toMatchObject({
      message: {
        token: 'device-token-1',
        notification: { title: 'Escalation', body: 'Open the app to see it.' },
        data: { intent_id: 'i1', category: 'ESCALATION' },
      },
    });
  });

  it('tells a forgotten device from a failure worth retrying', async () => {
    const fcm = channel({
      projectId: 'demo-project',
      credentialsRef: 'vault://kv/hotella/app#fcm',
    });
    await expect(fcm.send(message('gone'))).rejects.toBeInstanceOf(PushTokenGoneError);
    const busy = fcm.send(message('busy'));
    await expect(busy).rejects.toBeInstanceOf(PushSendError);
    await expect(busy).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
