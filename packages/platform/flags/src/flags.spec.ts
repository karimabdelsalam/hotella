import 'reflect-metadata';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@hotella/platform-config';
import { DATABASE, DatabaseModule, type Database, runMigrations } from '@hotella/platform-database';
import { EventsModule, eventsSchema } from '@hotella/platform-events';
import { ObservabilityModule } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureFlagsModule } from './flags.module';
import { resolveFlag } from './resolve';

const t1 = '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f11';
const p1 = '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f22';

describe('resolveFlag', () => {
  const rows = [
    { key: 'guest.ai_concierge', scope: 'PLATFORM' as const, scopeId: null, enabled: false },
    { key: 'guest.ai_concierge', scope: 'TENANT' as const, scopeId: t1, enabled: true },
    { key: 'guest.ai_concierge', scope: 'PROPERTY' as const, scopeId: p1, enabled: false },
  ];
  it('most specific scope wins, unknown flags are off', () => {
    expect(resolveFlag(rows, 'guest.ai_concierge')).toBe(false);
    expect(resolveFlag(rows, 'guest.ai_concierge', { tenantId: t1 })).toBe(true);
    expect(resolveFlag(rows, 'guest.ai_concierge', { tenantId: t1, propertyId: p1 })).toBe(false);
    expect(
      resolveFlag(rows, 'guest.ai_concierge', { tenantId: 'other', propertyId: 'other' }),
    ).toBe(false);
    expect(resolveFlag(rows, 'nope')).toBe(false);
  });
});

describe.skipIf(needsInfra())(
  `FeatureFlagService against PostgreSQL (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    let svc: FeatureFlagService;
    let db: Database;
    let close: () => Promise<void>;
    beforeAll(async () => {
      await runMigrations(url);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        VALKEY_URL: 'redis://127.0.0.1:1',
      };
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ env }),
          ObservabilityModule.forRoot(),
          DatabaseModule.forRoot(),
          EventsModule.forRoot(),
          FeatureFlagsModule,
        ],
      }).compile();
      const app = ref.createNestApplication({ logger: false });
      await app.init();
      svc = app.get(FeatureFlagService);
      db = app.get(DATABASE);
      close = () => app.close();
    });
    afterAll(() => close?.());

    it('sets, resolves by scope, publishes the change event and invalidates the snapshot', async () => {
      const key = `test.flag.${Date.now()}`;
      expect(await svc.isEnabled(key)).toBe(false);
      await svc.set({ key, scope: 'PLATFORM', enabled: true, description: 'test' });
      expect(await svc.isEnabled(key)).toBe(true);
      await svc.set({ key, scope: 'PROPERTY', scopeId: p1, enabled: false });
      expect(await svc.isEnabled(key, { propertyId: p1 })).toBe(false);
      expect(await svc.isEnabled(key, { propertyId: 'other' })).toBe(true);
      await svc.set({ key, scope: 'PLATFORM', enabled: false }); // upsert path
      expect(await svc.isEnabled(key)).toBe(false);
      const events = await db
        .select()
        .from(eventsSchema.outbox)
        .where(eq(eventsSchema.outbox.eventName, 'platform.feature_flag.changed.v1'));
      expect(
        events.filter((e) => (e.envelope as { payload: { key: string } }).payload.key === key),
      ).toHaveLength(3);
    });

    it('rejects scoped flags without a scope id', async () => {
      await expect(svc.set({ key: 'x.y', scope: 'TENANT', enabled: true })).rejects.toThrow(
        /scopeId/,
      );
    });
  },
);
