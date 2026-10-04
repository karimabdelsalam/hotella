import { createServer, type Server, type Socket } from 'node:net';
import type { SimulatedPms } from './hotel';

const STX = 0x02;
const ETX = 0x03;

/** FIAS maid status (RS 1–6) → the status the simulated PMS records. */
const MAID_STATUS: Record<string, string> = {
  '1': 'DIRTY',
  '2': 'DIRTY',
  '3': 'CLEAN',
  '4': 'CLEAN',
  '5': 'INSPECTED',
  '6': 'INSPECTED',
};

function stamp(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `DA${p(now.getUTCFullYear() % 100)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}|TI${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}|`;
}

/**
 * The simulator's byte-level IFC8 face (BUILD_PLAN §10 Phase 10, Sprint 10.2): a TCP endpoint that behaves like OPERA's
 * FIAS interface towards the hotel agent — STX/ETX framing, link start (LS) on connect, the interface's description
 * (LD) and record requests (LR), link alive (LA) both ways, database sync (DR → DS, GI with SF…, DE) and room status
 * written by the interface (RE). Records produced while no interface is linked wait in IFC8's buffer and go out when
 * the link is up again, as IFC8 does. Only the record types the interface requested are sent.
 */
export class Ifc8Face {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private linkUp = false;
  private readonly pending: string[] = [];
  private readonly requested = new Set<string>();
  /** Every record the interface sent (link records included), for assertions. */
  readonly received: string[] = [];
  readonly stats = { connections: 0, sent: 0 };

  constructor(private readonly pms: SimulatedPms) {}

  /** Listens on 127.0.0.1 (port 0 = any free port); resolves to the port. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  get connected(): boolean {
    return this.linkUp;
  }

  /** A business record from the PMS (GI, GO, GC, RE…): sent now when linked and requested, else buffered. */
  send(record: string): void {
    const id = record.slice(0, 2);
    if (this.linkUp && this.socket && this.requested.has(id)) this.write(record);
    else this.pending.push(record);
  }

  /** Cuts the TCP connection like a network failure; buffered records survive. */
  drop(): void {
    const socket = this.socket;
    // Down at once: what the PMS produces from now on is buffered, not written to a dying socket.
    this.socket = null;
    this.linkUp = false;
    socket?.destroy();
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  private accept(socket: Socket): void {
    // IFC8 talks to one interface: a new connection replaces the old one.
    this.socket?.destroy();
    this.socket = socket;
    this.linkUp = false;
    this.requested.clear();
    this.stats.connections++;
    let frame: number[] | null = null;
    socket.on('data', (chunk: Buffer) => {
      for (const b of chunk) {
        if (b === STX) frame = [];
        else if (b === ETX && frame) {
          this.onRecord(Buffer.from(frame).toString('utf8'));
          frame = null;
        } else frame?.push(b);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.linkUp = false;
      }
    });
    this.write(`LS|${stamp()}`);
  }

  private onRecord(record: string): void {
    this.received.push(record);
    const id = record.slice(0, 2);
    switch (id) {
      case 'LS':
        this.linkUp = false;
        this.write(`LS|${stamp()}`);
        break;
      case 'LR': {
        const ri = /\|RI([A-Z]{2})\|/.exec(record)?.[1];
        if (ri) this.requested.add(ri);
        break;
      }
      case 'LA':
        if (!this.linkUp) {
          this.linkUp = true;
          this.write(`LA|${stamp()}`);
          this.flush();
        } else this.write(`LA|${stamp()}`);
        break;
      case 'LE':
        this.socket?.end();
        break;
      case 'DR':
        for (const r of this.pms.databaseSync()) this.send(r);
        break;
      case 'RE': {
        const room = /\|RN([^|]+)\|/.exec(record)?.[1];
        const rs = /\|RS([^|]+)\|/.exec(record)?.[1];
        if (room && rs && MAID_STATUS[rs]) this.pms.acceptRoomStatus(room, MAID_STATUS[rs]!);
        break;
      }
      default:
        break;
    }
  }

  private flush(): void {
    const waiting = this.pending.splice(0);
    for (const r of waiting) this.send(r);
  }

  private write(record: string): void {
    if (!this.socket) return;
    this.socket.write(Buffer.concat([Buffer.of(STX), Buffer.from(record, 'utf8'), Buffer.of(ETX)]));
    if (!record.startsWith('L')) this.stats.sent++;
  }
}
