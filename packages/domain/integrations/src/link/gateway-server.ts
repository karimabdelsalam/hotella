import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { gunzipSync } from 'node:zlib';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import {
  agentFrameSchema,
  BATCH_PATH,
  CA_PATH,
  batchRequestSchema,
  ENROLL_PATH,
  enrollRequestSchema,
  LINK_PATH,
  type PlatformFrame,
  RENEW_PATH,
  renewRequestSchema,
} from '@hotella/contracts-connectors';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { newId } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { AgentKeys } from './agent-keys';
import { EnrollmentService } from './enrollment.service';
import { type AgentSession, AgentLinkService } from './link.service';

const MAX_JSON_BYTES = 64 * 1024;
const MAX_BATCH_BYTES = 5 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const COMMAND_POLL_MS = 2_000;
/** Reads are interactive (a person or a module waits), so waiting ones are picked up more often than commands. */
const QUERY_POLL_MS = 500;
/** Per-instance inbound frames per second before the platform asks the agent to slow down (ADR-0017 §4). */
const THROTTLE_PER_SECOND = 200;

/** Close codes (4000–4999 are application-defined). */
export const LINK_CLOSE = {
  PROTOCOL: 4400,
  UNAUTHORIZED: 4401,
  HELLO_TIMEOUT: 4408,
  IDLE: 4410,
  REPLACED: 4409,
} as const;

/**
 * The agent gateway (ADR-0017): its own TLS 1.3 listener with client-certificate authentication, serving ONLY the
 * agent endpoints — enrollment, renewal, HTTPS batches and the WSS link. Staff routes never reach this port.
 */
@Injectable()
export class AgentGatewayServer implements OnApplicationShutdown {
  private server: Server | undefined;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** Live sessions by instance: a new connection replaces the previous one. */
  private readonly sessions = new Map<string, WebSocket>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly keys: AgentKeys,
    private readonly link: AgentLinkService,
    private readonly enrollment: EnrollmentService,
    private readonly ctx: RequestContext,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async listen(options: { host?: string; port?: number } = {}): Promise<number> {
    const keys = await this.keys.get();
    this.server = createServer(
      {
        key: keys.tlsPrivateKeyPem,
        cert: keys.tlsCertificatePem,
        ca: keys.caCertificatePem,
        requestCert: true,
        // Enrollment happens before the agent has a certificate; every other route checks `authorized` itself.
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
      },
      (req, res) => void this.handle(req, res),
    );
    this.server.on(
      'upgrade',
      (req, socket, head) => void this.upgrade(req, socket as TLSSocket, head),
    );
    await new Promise<void>((resolve) =>
      this.server!.listen(
        options.port ?? this.config.agent.port,
        options.host ?? this.config.agent.host,
        resolve,
      ),
    );
    const port = (this.server.address() as AddressInfo).port;
    this.logger.info({ port }, 'agent gateway listening (TLS 1.3, client certificates)');
    return port;
  }

  async onApplicationShutdown(): Promise<void> {
    for (const ws of this.sessions.values()) ws.close(1001, 'shutting down');
    this.wss.close();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  // ---- HTTPS ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/agent/v1/health')
        return send(res, 200, { status: 'ok' });
      // Public: the agent CA certificate, which an installing agent checks against the fingerprint in its enrollment
      // code before trusting it (ADR-0020).
      if (req.method === 'GET' && path === CA_PATH)
        return send(res, 200, { ca_certificate: (await this.keys.get()).caCertificatePem });
      if (req.method !== 'POST') return send(res, 404, { code: 'platform.not_found' });
      if (path === ENROLL_PATH) {
        const body = enrollRequestSchema.parse(await readJson(req, MAX_JSON_BYTES));
        return send(res, 200, await this.ctx.run({}, () => this.enrollment.enroll(body)));
      }
      const session = await this.authenticate(req.socket as TLSSocket);
      if (!session) return send(res, 401, { code: 'integration.agent.unauthorized' });
      const run = <T>(fn: () => Promise<T>) => this.inContext(session, fn);
      if (path === RENEW_PATH) {
        const body = renewRequestSchema.parse(await readJson(req, MAX_JSON_BYTES));
        return send(
          res,
          200,
          await run(() => this.enrollment.renew(session.instance, body.csr, null)),
        );
      }
      if (path === BATCH_PATH) {
        const body = batchRequestSchema.parse(await readJson(req, MAX_BATCH_BYTES));
        return send(res, 200, await run(() => this.link.batch(session, body.messages)));
      }
      return send(res, 404, { code: 'platform.not_found' });
    } catch (err) {
      if (err instanceof z.ZodError) return send(res, 400, { code: 'platform.validation_failed' });
      if (err instanceof AppError) return send(res, err.status, { code: err.code });
      if (err instanceof PayloadTooLargeError) return send(res, 413, { code: 'platform.http_413' });
      this.logger.error({ err: errorMessage(err), path }, 'agent gateway request failed');
      return send(res, 500, { code: 'platform.internal_error' });
    }
  }

  // ---- WSS link ----

  private async upgrade(req: IncomingMessage, socket: TLSSocket, head: Buffer): Promise<void> {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if ((req.url ?? '').split('?')[0] !== LINK_PATH) return reject(404, 'Not Found');
    const session = await this.authenticate(socket).catch(() => null);
    if (!session) return reject(401, 'Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws, session));
  }

  private connected(ws: WebSocket, session: AgentSession): void {
    const sessionId = newId();
    const instanceId = session.instance.id;
    this.sessions.get(instanceId)?.close(LINK_CLOSE.REPLACED, 'replaced by a newer connection');
    this.sessions.set(instanceId, ws);
    const heartbeatMs = this.config.agent.heartbeatSeconds * 1000;
    let greeted = false;
    let lastFrameAt = Date.now();
    let windowStart = Date.now();
    let windowCount = 0;
    let busy = Promise.resolve();
    const timers: NodeJS.Timeout[] = [];
    const out = (frame: PlatformFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const fail = (code: number, reason: string) => {
      out({ type: 'error', code: reason, message: reason });
      ws.close(code, reason);
    };

    timers.push(
      setTimeout(() => {
        if (!greeted) fail(LINK_CLOSE.HELLO_TIMEOUT, 'hello_timeout');
      }, HELLO_TIMEOUT_MS),
    );
    timers.push(
      setInterval(() => {
        if (!greeted) return;
        if (Date.now() - lastFrameAt > 3 * heartbeatMs) return fail(LINK_CLOSE.IDLE, 'idle');
        void this.inContext(session, async () => {
          if (!(await this.link.stillValid(session)))
            return fail(LINK_CLOSE.UNAUTHORIZED, 'revoked');
          for (const frame of await this.link.commandsToSend(session)) out(frame);
        }).catch((err) => this.logger.error({ err: errorMessage(err) }, 'command delivery failed'));
      }, COMMAND_POLL_MS),
    );
    let querying = false;
    timers.push(
      setInterval(() => {
        if (!greeted || querying) return;
        querying = true;
        void this.inContext(session, async () => {
          for (const frame of await this.link.queriesToSend(session)) out(frame);
        })
          .catch((err) => this.logger.error({ err: errorMessage(err) }, 'query delivery failed'))
          .finally(() => (querying = false));
      }, QUERY_POLL_MS),
    );

    ws.on('message', (data, isBinary) => {
      lastFrameAt = Date.now();
      if (Date.now() - windowStart > 1000) {
        windowStart = Date.now();
        windowCount = 0;
      }
      if (++windowCount === THROTTLE_PER_SECOND)
        out({ type: 'throttle', max_messages_per_second: THROTTLE_PER_SECOND / 2 });
      // Frames are handled strictly one after another (ordering is the protocol's backbone).
      busy = busy.then(async () => {
        if (isBinary) return fail(LINK_CLOSE.PROTOCOL, 'binary_frame');
        let frame;
        try {
          frame = agentFrameSchema.parse(JSON.parse(data.toString()));
        } catch {
          return fail(LINK_CLOSE.PROTOCOL, 'malformed_frame');
        }
        if (!greeted && frame.type !== 'hello') return fail(LINK_CLOSE.PROTOCOL, 'hello_required');
        try {
          await this.inContext(session, async () => {
            switch (frame.type) {
              case 'hello':
                greeted = true;
                return out(await this.link.hello(session, frame, sessionId));
              case 'message': {
                const outcome = await this.link.message(session, frame);
                return out(
                  outcome.kind === 'ack'
                    ? { type: 'ack', sequence_no: outcome.sequence }
                    : { type: 'resend', from_sequence: outcome.from },
                );
              }
              case 'heartbeat':
                return this.link.heartbeat(session, frame);
              case 'command_result':
                return this.link.commandResult(session, frame);
              case 'query_result':
                return this.link.queryResult(session, frame);
            }
          });
        } catch (err) {
          // Not acknowledged: the agent keeps the message and retries after reconnecting.
          this.logger.error(
            { err: errorMessage(err), instance_id: instanceId },
            'agent frame failed',
          );
          const code = err instanceof AppError ? err.code : 'internal_error';
          fail(LINK_CLOSE.PROTOCOL, code);
        }
      });
    });

    ws.on('close', () => {
      timers.forEach((t) => clearTimeout(t));
      if (this.sessions.get(instanceId) === ws) this.sessions.delete(instanceId);
      void this.inContext(session, () => this.link.disconnected(session, sessionId)).catch(
        () => undefined,
      );
    });
  }

  private async authenticate(socket: TLSSocket): Promise<AgentSession | null> {
    if (!socket.authorized) return null;
    const cert = socket.getPeerCertificate();
    const fingerprint = cert?.fingerprint256?.replace(/:/g, '').toLowerCase() ?? null;
    return this.link.authenticate(fingerprint);
  }

  /** Every agent request runs in its own context: correlation id, tenant/property, actor INTEGRATION. */
  private inContext<T>(session: AgentSession, fn: () => Promise<T>): Promise<T> {
    return this.ctx.run(
      {
        tenant_id: session.instance.tenantId,
        property_id: session.instance.propertyId,
        actor_type: 'INTEGRATION',
        actor_id: session.instance.id,
      },
      fn,
    );
  }
}

class PayloadTooLargeError extends Error {}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new PayloadTooLargeError();
    chunks.push(chunk as Buffer);
  }
  let raw = Buffer.concat(chunks);
  if (req.headers['content-encoding'] === 'gzip') {
    raw = gunzipSync(raw, { maxOutputLength: limit });
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new z.ZodError([]);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
