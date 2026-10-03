import { createPublicKey } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  type AgentFrameInput,
  type BatchResponse,
  BATCH_PATH,
  LINK_PATH,
  LINK_PROTOCOL_VERSION,
  type LinkMessage,
  type PlatformFrame,
  platformFrameSchema,
} from '@hotella/contracts-connectors';
import { verifyCanonical } from '@hotella/platform-pki';
import { type AgentIdentity, postJson } from './identity';
import type { DurableQueue, QueuedMessage } from './queue';

type HelloFrame = Extract<AgentFrameInput, { type: 'hello' }>;
export type CommandFrame = Extract<PlatformFrame, { type: 'command' }>;
export type CommandHandler = (
  command: CommandFrame,
) => Promise<{ status: 'ACKNOWLEDGED' } | { status: 'FAILED'; error: string }>;

export interface LinkClientOptions {
  readonly gatewayUrl: string;
  readonly identity: AgentIdentity;
  readonly queue: DurableQueue;
  readonly connectorCode: string;
  readonly capabilities: readonly string[];
  readonly agentVersion: string;
  readonly onCommand?: CommandHandler;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * The agent side of the link (ADR-0017 §3–§4): outbound-only WSS with the device certificate, hello → welcome,
 * ordered sending from the durable queue, cumulative acks, resend on request, heartbeats, signed-command
 * verification against the pinned key, and reconnect with exponential back-off and jitter (1 s → 60 s).
 */
export class AgentLinkClient {
  private ws: WebSocket | null = null;
  private held: LinkMessage | null = null;
  private stopped = true;
  private welcomed = false;
  private attempt = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly executed = new Map<
    string,
    { status: 'ACKNOWLEDGED' | 'FAILED'; error: string | null }
  >();
  private readonly commandKey;
  /** Observability for tests and the CLI. */
  readonly stats = {
    connects: 0,
    welcomes: 0,
    acks: 0,
    resends: 0,
    commands: 0,
    rejectedCommands: 0,
  };
  revoked = false;
  lastClose: { code: number; reason: string } | null = null;
  /** Chaos switches (CI scenarios): swap the next two messages, or send the next one twice. */
  readonly chaos = { reorderNext: false, duplicateNext: false };

  constructor(private readonly options: LinkClientOptions) {
    this.commandKey = createPublicKey(options.identity.commandPublicKeyPem);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.ws?.close(1000, 'agent stopping');
  }

  /** Cuts the connection like a network failure; the client reconnects on its own. */
  dropConnection(): void {
    this.ws?.terminate();
  }

  get connected(): boolean {
    return this.welcomed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Durably queues a vendor message and sends it when the link is up. */
  publish(message: QueuedMessage): LinkMessage {
    const m = this.options.queue.append(message);
    if (!this.connected) return m;
    if (this.chaos.reorderNext && !this.held) {
      // Hold this one back and send it after the next message (the platform must ask for a resend).
      this.held = m;
      return m;
    }
    const held = this.held;
    this.held = null;
    if (held) {
      this.chaos.reorderNext = false;
      this.flush([m, held]);
    } else this.flush([m]);
    return m;
  }

  /** Resolves once the link is up and welcomed (or throws after `timeoutMs`). */
  async ready(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected) {
      if (this.revoked) throw new Error('link revoked');
      if (Date.now() > deadline) throw new Error('link not established');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Resolves when every queued message has been acknowledged. */
  async drained(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // A message held back for the reorder chaos goes out now: nothing else may follow to release it.
    if (this.held && this.connected) {
      const held = this.held;
      this.held = null;
      this.chaos.reorderNext = false;
      this.flush([held]);
    }
    while (this.options.queue.depth > 0) {
      if (Date.now() > deadline)
        throw new Error(`link not drained: ${this.options.queue.depth} message(s) unacknowledged`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** HTTPS batch upload (large resyncs) for whatever is queued; the socket is not needed. */
  async sendBatch(): Promise<BatchResponse> {
    const { identity, gatewayUrl, queue } = this.options;
    const messages = queue.pending().slice(0, 500);
    const res = await postJson<BatchResponse>(
      gatewayUrl,
      BATCH_PATH,
      { messages },
      { ca: identity.caCertificatePem, cert: identity.certificatePem, key: identity.privateKeyPem },
    );
    queue.ackThrough(res.acked_through);
    return res;
  }

  private connect(): void {
    const { identity, gatewayUrl } = this.options;
    const url = new URL(LINK_PATH, gatewayUrl.replace(/^http/, 'ws'));
    const ws = new WebSocket(url, {
      ca: identity.caCertificatePem,
      cert: identity.certificatePem,
      key: identity.privateKeyPem,
      minVersion: 'TLSv1.3',
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    this.welcomed = false;
    ws.on('open', () => {
      this.stats.connects++;
      this.send({
        type: 'hello',
        protocol: LINK_PROTOCOL_VERSION,
        agent_version: this.options.agentVersion,
        connector_code: this.options.connectorCode,
        capabilities: [...this.options.capabilities] as HelloFrame['capabilities'],
        first_buffered_sequence: this.options.queue.firstBuffered,
      });
    });
    ws.on('message', (data) => void this.onFrame(data.toString()));
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) this.revoked = true;
      this.lastClose = { code: res.statusCode ?? 0, reason: 'http' };
    });
    ws.on('error', (err) => this.options.log?.('link error', { err: err.message }));
    ws.on('close', (code, reason) => {
      clearInterval(this.heartbeat);
      this.welcomed = false;
      if (code) this.lastClose = { code, reason: reason.toString() };
      if (code === 4401) this.revoked = true;
      if (!this.stopped && !this.revoked) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempt++, 6));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async onFrame(text: string): Promise<void> {
    const parsed = platformFrameSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return this.options.log?.('unknown frame ignored');
    const frame = parsed.data;
    switch (frame.type) {
      case 'welcome': {
        this.welcomed = true;
        this.attempt = 0;
        this.stats.welcomes++;
        this.options.queue.ackThrough(frame.next_expected_sequence - 1);
        this.heartbeat = setInterval(
          () =>
            this.send({
              type: 'heartbeat',
              sent_at: new Date().toISOString(),
              queue_depth: this.options.queue.depth,
            }),
          frame.heartbeat_interval_seconds * 1000,
        );
        this.flush(this.options.queue.pending());
        return;
      }
      case 'ack':
        this.stats.acks++;
        this.options.queue.ackThrough(frame.sequence_no);
        return;
      case 'resend':
        this.stats.resends++;
        this.flush(this.options.queue.pending(frame.from_sequence));
        return;
      case 'command':
        return this.onCommand(frame);
      case 'throttle':
      case 'error':
        this.options.log?.(`platform ${frame.type}`, frame);
        return;
    }
  }

  private async onCommand(frame: CommandFrame): Promise<void> {
    const { signature, ...body } = frame;
    // A command that is not signed by the pinned platform key is never executed (ADR-0017 §5).
    if (
      !verifyCanonical(body, signature, this.commandKey) ||
      body.instance_id !== this.options.identity.instanceId
    ) {
      this.stats.rejectedCommands++;
      return;
    }
    let result = this.executed.get(frame.command_id);
    if (!result) {
      this.stats.commands++;
      const outcome = this.options.onCommand
        ? await this.options.onCommand(frame).catch((err: Error) => ({
            status: 'FAILED' as const,
            error: err.message,
          }))
        : { status: 'FAILED' as const, error: 'no command handler' };
      result = {
        status: outcome.status,
        error: outcome.status === 'FAILED' ? outcome.error : null,
      };
      this.executed.set(frame.command_id, result);
    }
    this.send({ type: 'command_result', command_id: frame.command_id, ...result });
  }

  private flush(messages: LinkMessage[]): void {
    for (const m of messages) {
      this.send(m);
      if (this.chaos.duplicateNext) {
        this.chaos.duplicateNext = false;
        this.send(m);
      }
    }
  }

  private send(frame: AgentFrameInput): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }
}
