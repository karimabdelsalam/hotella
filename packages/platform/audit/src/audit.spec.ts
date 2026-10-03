import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { classify } from '@hotella/platform-database';
import type { RequestContext } from '@hotella/platform-observability';
import { AuditRequiresTransactionError, AuditWriter } from './audit-writer';
import { REDACTED, redactForAudit } from './redact';

// A classified table makes its RESTRICTED/SENSITIVE columns redactable by name, wherever they appear.
classify(
  pgTable('audit_spec_accounts', {
    id: uuid('id').primaryKey(),
    passwordHash: text('password_hash'),
    nationalId: text('national_id'),
    displayName: text('display_name'),
  }),
  { id: 'INTERNAL', passwordHash: 'RESTRICTED', nationalId: 'SENSITIVE', displayName: 'PUBLIC' },
);

describe('redactForAudit', () => {
  it('redacts classified SENSITIVE/RESTRICTED columns and secret-looking keys at any depth', () => {
    const out = redactForAudit({
      id: 'u1',
      passwordHash: '$argon2id$…',
      displayName: 'Mona',
      nested: {
        national_id: '2990101',
        password: 'x',
        token: 'inv_…',
        ok: [1, { nationalId: 'y' }],
      },
      at: new Date('2026-10-03T10:00:00Z'),
    }) as Record<string, unknown>;
    expect(out).toEqual({
      id: 'u1',
      passwordHash: REDACTED,
      displayName: 'Mona',
      nested: {
        national_id: REDACTED,
        password: REDACTED,
        token: REDACTED,
        ok: [1, { nationalId: REDACTED }],
      },
      at: '2026-10-03T10:00:00.000Z',
    });
  });
  it('bounds depth and keeps primitives', () => {
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit(3)).toBe(3);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redactForAudit(deep))).toContain('[TRUNCATED]');
  });
});

describe('AuditWriter', () => {
  it('refuses to write outside a transaction unless explicitly allowed', async () => {
    const ctx = {
      actor: null,
      tenantId: null,
      propertyId: null,
      correlationId: null,
      traceId: null,
    };
    const writer = new AuditWriter({} as never, ctx as unknown as RequestContext);
    await expect(
      writer.record({ action: 'x.y.z', entityType: 'e', entityId: '1' }),
    ).rejects.toBeInstanceOf(AuditRequiresTransactionError);
  });
});
