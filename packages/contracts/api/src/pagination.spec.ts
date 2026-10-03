import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  buildPage,
  cursorQuerySchema,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from './pagination';

describe('cursor pagination', () => {
  it('parses query with defaults and bounds', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(cursorQuerySchema.parse({ limit: '10', cursor: 'abc' })).toEqual({
      limit: 10,
      cursor: 'abc',
    });
    expect(() => cursorQuerySchema.parse({ limit: 1000 })).toThrow();
  });
  it('round-trips an opaque cursor and rejects tampering', () => {
    const key = { createdAt: '2026-10-03T00:00:00Z', id: 'x' };
    const schema = z.object({ createdAt: z.string(), id: z.string() });
    expect(decodeCursor(encodeCursor(key), schema)).toEqual(key);
    expect(() => decodeCursor('not-base64-json', schema)).toThrow(InvalidCursorError);
    expect(decodeCursor(undefined, schema)).toBeUndefined();
  });
  it('uses the extra row only as a has-more signal', () => {
    const rows = [1, 2, 3, 4];
    const page = buildPage(rows, 3, (n) => ({ n }));
    expect(page.data).toEqual([1, 2, 3]);
    expect(page.next_cursor).toBe(encodeCursor({ n: 3 }));
    expect(buildPage([1, 2], 3, (n) => ({ n })).next_cursor).toBeNull();
  });
});
