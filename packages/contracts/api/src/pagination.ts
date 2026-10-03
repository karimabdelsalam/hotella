import { z } from 'zod';

export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = 100;

/** `?cursor=&limit=` for every list endpoint (ADR-0012). Offsets are not offered: they break under concurrent writes. */
export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
export interface Page<T> {
  readonly data: readonly T[];
  readonly next_cursor: string | null;
}

/** Opaque cursor: base64url(JSON). Contents are a sort key, never a row offset. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
export function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!cursor) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError();
  }
}
export class InvalidCursorError extends Error {
  constructor() {
    super('platform.invalid_cursor');
    this.name = 'InvalidCursorError';
  }
}

/**
 * Builds a page from `limit + 1` fetched rows: the extra row only signals that a next page exists.
 * `toCursor` derives the sort key of the last returned row.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (last: T) => unknown,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : [...rows];
  const last = data[data.length - 1];
  return { data, next_cursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null };
}
