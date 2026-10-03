import { uuidv7 } from 'uuidv7';

/**
 * Application-generated UUIDv7 (ADR-0003). Time-ordered, so B-tree indexes stay compact and an id
 * can be known before the row is written (outbox correlation). Never use DB-side gen_random_uuid().
 */
export function newId(): string {
  return uuidv7();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
