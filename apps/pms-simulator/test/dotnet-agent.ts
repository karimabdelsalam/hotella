import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { QueuedMessage, ScenarioLink } from '../src';

/**
 * Drives the .NET hotel agent (apps/hotel-agent, `Hotella.Agent.Conformance`) over stdin/stdout JSON lines, so the
 * same scenarios that exercise the TypeScript reference agent run against the production agent's link code.
 * Requests are answered in order; `{"event":"command"}` lines report commands the agent acknowledged.
 */

/** The built agent (`dotnet build` → artifacts/bin/<project>/<release|debug>/), release preferred. */
export function agentBinaries(artifacts: string | undefined): {
  conformance: string;
  host: string;
} {
  if (!artifacts)
    throw new Error('TEST_DOTNET_AGENT is not set: CI must build the .NET agent and point at it');
  for (const config of ['release', 'debug']) {
    const conformance = join(
      artifacts,
      'Hotella.Agent.Conformance',
      config,
      'Hotella.Agent.Conformance.dll',
    );
    const host = join(artifacts, 'Hotella.Agent', config, 'hotella-agent.dll');
    if (existsSync(conformance) && existsSync(host)) return { conformance, host };
  }
  throw new Error(
    `the .NET hotel agent is not built under ${artifacts} (dotnet build apps/hotel-agent)`,
  );
}

type Reply = { id: number; ok: boolean; status?: number; code?: string; error?: string } & Record<
  string,
  unknown
>;

export interface DotnetAgentState {
  connected: boolean;
  revoked: boolean;
  queue_depth: number;
  ifc8?: { link_up: boolean; sessions: number; forwarded: number };
  ows?: { polls: number; failures: number; forwarded: number; last_error: string | null };
  opera_db?: { up: boolean; problem: string | null; polls: number; forwarded: number };
  licence?: { state: string; expires_at: string | null; capabilities: string[] | null };
  stats?: {
    connects: number;
    welcomes: number;
    acks: number;
    resends: number;
    commands: number;
    rejected_commands: number;
    queries: number;
    rejected_queries: number;
  };
}

export class DotnetAgentError extends Error {
  constructor(readonly reply: Reply) {
    super(reply.error ?? `HTTP ${reply.status} (${reply.code})`);
  }
  get status(): number | undefined {
    return this.reply.status;
  }
  get code(): string | undefined {
    return this.reply.code;
  }
}

export class DotnetAgent implements ScenarioLink {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (r: Reply) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private exited: Error | null = null;
  /** Commands the agent verified, executed and acknowledged, in order. */
  readonly commands: { command_type: string; payload: unknown }[] = [];
  /** Stderr of the agent (its logs), kept for failure messages. */
  readonly logs: string[] = [];
  /** Failures of calls nobody awaited (publish, chaos); `drained` reports them. */
  private readonly unawaited: Error[] = [];
  onCommand: (command: { command_type: string; payload: unknown }) => void = () => undefined;

  /** Chaos switches forwarded to the agent (the scenario sets them synchronously; the pipe keeps the order). */
  readonly chaos = (() => {
    const send = (flag: string) => this.fire({ op: 'chaos', [flag]: true });
    return {
      set reorderNext(v: boolean) {
        if (v) send('reorder_next');
      },
      get reorderNext() {
        return false;
      },
      set duplicateNext(v: boolean) {
        if (v) send('duplicate_next');
      },
      get duplicateNext() {
        return false;
      },
    };
  })();

  constructor(dll: string) {
    this.child = spawn('dotnet', [dll], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as Reply & { event?: string };
      if (msg.event === 'command') {
        const command = { command_type: String(msg['command_type']), payload: msg['payload'] };
        this.commands.push(command);
        this.onCommand(command);
        return;
      }
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!waiter) return;
      if (msg.ok) waiter.resolve(msg);
      else waiter.reject(new DotnetAgentError(msg));
    });
    createInterface({ input: this.child.stderr }).on('line', (line) => {
      this.logs.push(line);
      if (this.logs.length > 400) this.logs.shift();
    });
    this.child.on('exit', (code) => {
      this.exited = new Error(`agent exited with ${code}: ${this.logs.slice(-20).join('\n')}`);
      for (const w of this.pending.values()) w.reject(this.exited);
      this.pending.clear();
    });
  }

  call(request: Record<string, unknown>): Promise<Reply> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }

  async enroll(gateway: string, token: string, ca: string): Promise<string> {
    return (await this.call({ op: 'enroll', gateway, token, ca }))['instance_id'] as string;
  }

  /** Starts the link; with `ifc8` (OPERA5_FIAS) or `ows` (OPERA5_OWS) the agent also runs that adapter. */
  async start(
    connector: string,
    capabilities: readonly string[],
    commands: readonly string[],
    adapter?:
      | { ifc8: { host: string; port: number } }
      | { ows: { url: string; user: string; password: string; poll_seconds?: number } }
      | { opera_db: { fixture: string; resort: string; change_polling?: boolean } },
  ) {
    await this.call({ op: 'start', connector, capabilities, commands, ...adapter });
  }

  /** Runs the OPERA database privilege self-check now; returns the problems found. */
  async operaDbCheck(): Promise<string[]> {
    return (await this.call({ op: 'opera_db_check' }))['problems'] as string[];
  }

  /** One OPERA database change poll now (instead of waiting for the agent's timer). */
  async operaDbPoll(): Promise<number> {
    return (await this.call({ op: 'opera_db_poll' }))['forwarded'] as number;
  }

  async stop(): Promise<void> {
    await this.call({ op: 'stop' });
  }

  /** Durably queued by the agent; the scenario does not wait (the pipe keeps the order). */
  publish(message: QueuedMessage): void {
    this.fire({ op: 'publish', ...message });
  }

  dropConnection(): void {
    this.fire({ op: 'chaos', drop_connection: true });
  }

  async drained(timeoutMs = 15_000): Promise<void> {
    await this.call({ op: 'drained', timeout_ms: timeoutMs });
    if (this.unawaited.length > 0) throw this.unawaited[0];
  }

  private fire(request: Record<string, unknown>): void {
    this.call(request).catch((e: Error) => this.unawaited.push(e));
  }

  async state(): Promise<DotnetAgentState> {
    return (await this.call({ op: 'state' })) as unknown as DotnetAgentState;
  }

  async batch(): Promise<{ acked_through: number; resend_from: number | null }> {
    const r = await this.call({ op: 'batch' });
    return {
      acked_through: r['acked_through'] as number,
      resend_from: (r['resend_from'] as number | null) ?? null,
    };
  }

  /** Evaluates the licence as if this many days had passed (an agent offline past its grace). */
  async licenceClock(days: number): Promise<void> {
    await this.call({ op: 'licence_clock', days });
  }

  async renew(): Promise<string> {
    return (await this.call({ op: 'renew' }))['certificate'] as string;
  }

  async quit(): Promise<void> {
    if (this.exited) return;
    await this.call({ op: 'quit' }).catch(() => undefined);
    this.child.kill();
  }
}
