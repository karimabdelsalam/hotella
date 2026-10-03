import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LinkMessage } from '@hotella/contracts-connectors';

export type QueuedMessage = Omit<LinkMessage, 'type' | 'sequence_no'>;

/**
 * The agent's durable, ordered outbound queue (ADR-0017 §4). Every message gets the next sequence number and is
 * written before it is sent; it is removed only when the platform acknowledges it. File-backed (JSON lines + a
 * compacted snapshot) so a restart loses nothing; `memory` mode for tests.
 */
export class DurableQueue {
  private items: LinkMessage[] = [];
  private nextSequence = 1;

  private constructor(private readonly dir: string | null) {}

  static memory(): DurableQueue {
    return new DurableQueue(null);
  }

  static open(dir: string): DurableQueue {
    mkdirSync(dir, { recursive: true });
    const q = new DurableQueue(dir);
    const snapshot = join(dir, 'queue.json');
    if (existsSync(snapshot)) {
      const s = JSON.parse(readFileSync(snapshot, 'utf8')) as {
        next: number;
        items: LinkMessage[];
      };
      q.nextSequence = s.next;
      q.items = s.items;
    }
    const log = join(dir, 'queue.log');
    if (existsSync(log)) {
      for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
        const m = JSON.parse(line) as LinkMessage;
        if (m.sequence_no >= q.nextSequence) {
          q.items.push(m);
          q.nextSequence = m.sequence_no + 1;
        }
      }
    }
    q.compact();
    return q;
  }

  append(message: QueuedMessage): LinkMessage {
    const m: LinkMessage = { type: 'message', sequence_no: this.nextSequence++, ...message };
    this.items.push(m);
    if (this.dir) appendFileSync(join(this.dir, 'queue.log'), `${JSON.stringify(m)}\n`);
    return m;
  }

  /** Cumulative acknowledgement: everything up to `sequence` is durable on the platform. */
  ackThrough(sequence: number): void {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.sequence_no > sequence);
    if (this.items.length !== before) this.compact();
  }

  pending(fromSequence = 0): LinkMessage[] {
    return this.items.filter((m) => m.sequence_no >= fromSequence);
  }

  get depth(): number {
    return this.items.length;
  }

  get firstBuffered(): number | null {
    return this.items[0]?.sequence_no ?? null;
  }

  private compact(): void {
    if (!this.dir) return;
    const tmp = join(this.dir, 'queue.json.tmp');
    writeFileSync(tmp, JSON.stringify({ next: this.nextSequence, items: this.items }));
    renameSync(tmp, join(this.dir, 'queue.json'));
    writeFileSync(join(this.dir, 'queue.log'), '');
  }
}
