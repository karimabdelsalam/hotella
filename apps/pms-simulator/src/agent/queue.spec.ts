import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableQueue } from './queue';

const msg = (id: string) => ({
  source_message_id: id,
  message_type: 'FIAS_RECORD',
  occurred_at: null,
  payload: { record: 'LS|' },
});

describe('DurableQueue', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('numbers messages in order and keeps them until acknowledged, across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hotella-sim-'));
    dirs.push(dir);
    const q = DurableQueue.open(dir);
    expect(
      [q.append(msg('a')), q.append(msg('b')), q.append(msg('c'))].map((m) => m.sequence_no),
    ).toEqual([1, 2, 3]);
    q.ackThrough(1);
    const reopened = DurableQueue.open(dir);
    expect(reopened.pending().map((m) => m.source_message_id)).toEqual(['b', 'c']);
    expect(reopened.firstBuffered).toBe(2);
    expect(reopened.append(msg('d')).sequence_no).toBe(4);
    reopened.ackThrough(4);
    expect(DurableQueue.open(dir).depth).toBe(0);
    expect(DurableQueue.open(dir).append(msg('e')).sequence_no).toBe(5);
  });
});
