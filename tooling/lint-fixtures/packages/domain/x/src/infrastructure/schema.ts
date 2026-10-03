// Fixture: DB-generated uuid default and a naive timestamp. Must fail no-restricted-syntax.
import { pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core';
const s = pgSchema('x');
export const bad = s.table('bad', {
  id: uuid('id').primaryKey().defaultRandom(),
  at: timestamp('at', { withTimezone: false }),
});
