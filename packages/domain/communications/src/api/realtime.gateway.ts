import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { GUEST_API, type GuestPrincipal, type GuestPublicApi } from '@hotella/domain-guest/public';
import {
  AUTHENTICATION_STRATEGY,
  type AuthenticationStrategy,
  PERMISSION_RESOLVER,
  type PermissionResolver,
  PROPERTY_SCOPE_VERIFIER,
  type PropertyScopeVerifier,
  type RequestActor,
} from '@hotella/platform-auth';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { InjectValkey } from '@hotella/platform-queue';
import { REALTIME_CHANNEL_PREFIX, type RealtimeNotice } from '../application/realtime-relay';

/** WebSocket path below the API prefix: `wss://<host>/api/v1/realtime`. */
export const REALTIME_PATH_SUFFIX = '/realtime';
const AUTH_DEADLINE_MS = 10_000;
const REVALIDATE_EVERY_MS = 60_000;

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10).max(4096) }),
  z.object({ type: z.literal('guest'), session: z.string().min(16).max(128) }),
  z.object({ type: z.literal('subscribe'), propertyId: z.uuid() }),
  z.object({ type: z.literal('ping') }),
]);

interface Client {
  readonly socket: WebSocket;
  kind: 'pending' | 'staff' | 'guest';
  credential: string | null;
  actor: RequestActor | null;
  guest: GuestPrincipal | null;
  readonly properties: Set<string>;
}

/**
 * Realtime gateway (BUILD_PLAN §8.2, notes for 4.4): staff watching a property's inbox and activated guests watching
 * their own conversation get a notice when something changes, then fetch it over REST. Authentication is the same as
 * HTTP — the staff access token through the configured strategy (live session), or the guest session through the
 * guest context — given in the first message (browsers cannot set headers on WebSockets) and re-checked every minute.
 * Staff subscribe per property with `inbox.read`; guests only hear about their stay. Notices carry ids, never content.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private wss: WebSocketServer | null = null;
  private subscriber: Redis | null = null;
  private readonly clients = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly http: HttpAdapterHost,
    @InjectValkey() private readonly valkey: Redis,
    @Inject(AUTHENTICATION_STRATEGY) private readonly strategy: AuthenticationStrategy,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @InjectLogger() private readonly logger: Logger,
    @Optional()
    @Inject(PROPERTY_SCOPE_VERIFIER)
    private readonly properties?: PropertyScopeVerifier | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = this.http.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (!path.endsWith(REALTIME_PATH_SUFFIX)) return; // not ours; other upgrade handlers may answer
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    this.subscriber = this.valkey.duplicate();
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('pmessage', (_pattern: string, _channel: string, raw: string) =>
      this.fanOut(raw),
    );
    await this.subscriber.psubscribe(`${REALTIME_CHANNEL_PREFIX}*`);
    this.timer = setInterval(() => void this.revalidate(), REVALIDATE_EVERY_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients) c.socket.close(1001, 'shutdown');
    this.wss?.close();
    await this.subscriber?.quit().catch(() => undefined);
  }

  /** Connected, authenticated clients (diagnostics and tests). */
  get connections(): number {
    return [...this.clients].filter((c) => c.kind !== 'pending').length;
  }

  private accept(socket: WebSocket): void {
    const client: Client = {
      socket,
      kind: 'pending',
      credential: null,
      actor: null,
      guest: null,
      properties: new Set(),
    };
    this.clients.add(client);
    const deadline = setTimeout(() => {
      if (client.kind === 'pending') socket.close(4401, 'unauthenticated');
    }, AUTH_DEADLINE_MS);
    deadline.unref();
    socket.on('message', (data) => void this.onMessage(client, data.toString()));
    socket.on('close', () => {
      clearTimeout(deadline);
      this.clients.delete(client);
    });
    socket.on('error', () => socket.terminate());
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let parsed: z.infer<typeof clientMessage>;
    try {
      parsed = clientMessage.parse(JSON.parse(raw));
    } catch {
      return this.send(client, { type: 'error', code: 'platform.validation_failed' });
    }
    try {
      switch (parsed.type) {
        case 'ping':
          return this.send(client, { type: 'pong' });
        case 'auth': {
          const actor = await this.staff(parsed.token);
          if (!actor) return client.socket.close(4401, 'unauthenticated');
          Object.assign(client, { kind: 'staff', credential: parsed.token, actor });
          return this.send(client, { type: 'ready', as: 'staff' });
        }
        case 'guest': {
          const principal = await this.guests.authenticateGuestSession(parsed.session);
          if (!principal || !principal.scopes.includes('CHAT'))
            return client.socket.close(4401, 'unauthenticated');
          Object.assign(client, { kind: 'guest', credential: parsed.session, guest: principal });
          return this.send(client, {
            type: 'ready',
            as: 'guest',
            conversationOf: principal.stayId,
          });
        }
        case 'subscribe': {
          if (client.kind !== 'staff' || !client.actor)
            return this.send(client, { type: 'error', code: 'platform.forbidden' });
          if (!(await this.mayWatch(client.actor, parsed.propertyId)))
            return this.send(client, {
              type: 'error',
              code: 'platform.forbidden',
              propertyId: parsed.propertyId,
            });
          client.properties.add(parsed.propertyId);
          return this.send(client, { type: 'subscribed', propertyId: parsed.propertyId });
        }
      }
    } catch (e) {
      this.logger.warn({ err: e }, 'realtime message failed');
      this.send(client, { type: 'error', code: 'platform.internal_error' });
    }
  }

  private staff(token: string): Promise<RequestActor | null> {
    return this.strategy.authenticate({
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request);
  }

  /** The same rule as the inbox route: the property belongs to the tenant and the actor holds `inbox.read` there. */
  private async mayWatch(actor: RequestActor, propertyId: string): Promise<boolean> {
    const tenantId =
      actor.tenantId ?? (await this.properties?.tenantOfProperty(propertyId)) ?? null;
    if (!tenantId) return false;
    if (
      actor.tenantId &&
      this.properties &&
      !(await this.properties.propertyBelongsToTenant(propertyId, actor.tenantId))
    )
      return false;
    return this.permissions.hasPermission(actor, 'inbox.read', { tenantId, propertyId });
  }

  private fanOut(raw: string): void {
    let notice: RealtimeNotice;
    try {
      notice = JSON.parse(raw) as RealtimeNotice;
    } catch {
      return;
    }
    const message = {
      type: 'event',
      event: notice.event,
      conversationId: notice.conversationId,
      messageId: notice.messageId,
    };
    for (const c of this.clients) {
      if (c.kind === 'staff' && c.properties.has(notice.propertyId))
        this.send(c, { ...message, propertyId: notice.propertyId });
      else if (
        c.kind === 'guest' &&
        c.guest &&
        c.guest.tenantId === notice.tenantId &&
        notice.stayId !== null &&
        c.guest.stayId === notice.stayId
      )
        this.send(c, message);
    }
  }

  /** Logout, revoked sessions, check-out and expired tokens end the socket within a minute. */
  private async revalidate(): Promise<void> {
    for (const c of this.clients) {
      if (c.kind === 'pending' || !c.credential) continue;
      const ok =
        c.kind === 'staff'
          ? Boolean(await this.staff(c.credential).catch(() => null))
          : Boolean(
              (
                await this.guests.authenticateGuestSession(c.credential).catch(() => null)
              )?.scopes.includes('CHAT'),
            );
      if (!ok) c.socket.close(4401, 'unauthenticated');
    }
  }

  /** Test hook: run the periodic re-check now. */
  revalidateNow(): Promise<void> {
    return this.revalidate();
  }

  private send(client: Client, payload: Record<string, unknown>): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(payload));
  }
}
