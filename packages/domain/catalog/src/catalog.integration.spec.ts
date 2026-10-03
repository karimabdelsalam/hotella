import { sql } from 'drizzle-orm';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHotel,
  guestSession,
  type Harness,
  type Hotel,
  seedStay,
  type SeededStay,
  staff,
  startCatalogApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const MANAGE = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'org.department.manage',
];
const CATALOG = ['catalog.read', 'catalog.manage', 'catalog.publish'];

interface GuestCatalog {
  categories: Array<{
    code: string;
    name: string;
    services: Array<{
      code: string;
      versionId: string;
      name: string;
      fields: Array<{
        code: string;
        label: string;
        options?: Array<{ code: string; label: string }>;
      }>;
      openNow: boolean;
    }>;
  }>;
}
const services = (c: GuestCatalog) => c.categories.flatMap((x) => x.services);

describe.skipIf(needsInfra())(
  `Guest service catalog against PostgreSQL (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    const gmId = newId();
    const chainId = newId();
    const propertyOnlyId = newId();
    const otherId = newId();
    const grants: Record<string, string[]> = {
      [gmId]: [...MANAGE, ...CATALOG],
      [chainId]: [...MANAGE, ...CATALOG],
      [propertyOnlyId]: [],
      [otherId]: [...MANAGE, ...CATALOG],
    };
    let h: Harness;
    let hotel: Hotel;
    let stay: SeededStay;
    let primary: string;
    let companion: string;
    const gm = () => staff(gmId, hotel.tenantId);
    const catalog = async (token: string, lang = 'ar') =>
      (
        await h
          .http()
          .get('/guest/services')
          .set('X-Guest-Session', token)
          .set('Accept-Language', lang)
          .expect(200)
      ).body as GuestCatalog;

    beforeAll(async () => {
      h = await startCatalogApp(url, 'hotella_app_catalog', grants);
      hotel = await createHotel(h, `cat-a-${stamp}`, gmId, ['504', '505']);
      stay = await seedStay(h.db, hotel, '504');
      primary = await guestSession(h, hotel, stay.stayId, stay.primary);
      companion = await guestSession(h, hotel, stay.stayId, stay.companion);
      grants[propertyOnlyId] = CATALOG.map((p) => `${p}@${hotel.propertyId}`);
    });
    afterAll(() => h?.app.close());

    it('imports the starter catalog once; guests read it in Arabic with every label translated', async () => {
      const first = await h
        .http()
        .post(`/properties/${hotel.propertyId}/catalog/starter`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(200);
      expect(first.body.created).toEqual([
        'EXTRA_TOWELS',
        'ROOM_CLEANING',
        'AC_PROBLEM',
        'WIFI_HELP',
        'AIRPORT_TRANSFER',
        'LATE_CHECKOUT_REQUEST',
      ]);
      const again = await h
        .http()
        .post(`/properties/${hotel.propertyId}/catalog/starter`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(200);
      expect(again.body).toEqual({ created: [], skipped: first.body.created });

      const ar = await catalog(primary, 'ar');
      expect(ar.categories.map((c) => c.code)).toEqual([
        'HOUSEKEEPING',
        'MAINTENANCE',
        'FRONT_DESK',
        'TRANSPORT',
      ]);
      expect(ar.categories[0]!.name).toBe('التدبير الفندقي');
      const towels = services(ar).find((s) => s.code === 'EXTRA_TOWELS')!;
      expect(towels.name).toBe('مناشف إضافية');
      expect(towels.fields.map((f) => [f.code, f.label])).toEqual([
        ['quantity', 'العدد'],
        ['notes', 'أي ملاحظات تودّ إخبارنا بها'],
      ]);
      const ac = services(ar).find((s) => s.code === 'AC_PROBLEM')!;
      expect(ac.fields[0]!.options!.map((o) => o.label)).toContain('حر جدًا');
      expect(
        services(await catalog(primary, 'en')).find((s) => s.code === 'EXTRA_TOWELS')!.name,
      ).toBe('Extra towels');
      // A language nobody translated falls back to the property default (English here).
      expect(services(await catalog(primary, 'fr'))[0]!.name).toBe('Extra towels');

      // Late check-out is for the primary guest only (eligibility); the companion does not see it.
      expect(services(ar).map((s) => s.code)).toContain('LATE_CHECKOUT_REQUEST');
      expect(services(await catalog(companion)).map((s) => s.code)).not.toContain(
        'LATE_CHECKOUT_REQUEST',
      );
      await h
        .http()
        .get('/guest/services/LATE_CHECKOUT_REQUEST')
        .set('X-Guest-Session', companion)
        .expect(404);
      const one = await h
        .http()
        .get('/guest/services/EXTRA_TOWELS')
        .set('X-Guest-Session', primary)
        .set('Accept-Language', 'ar')
        .expect(200);
      expect(one.body).toMatchObject({ code: 'EXTRA_TOWELS', name: 'مناشف إضافية', openNow: true });
      await h.http().get('/guest/services').expect(401);
    });

    it('a published version is frozen; editing makes the next draft, publishing replaces it for guests', async () => {
      const list = await h
        .http()
        .get(`/catalog/services?propertyId=${hotel.propertyId}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      const towels = (
        list.body as Array<{ id: string; code: string; published: { id: string; version: number } }>
      ).find((s) => s.code === 'EXTRA_TOWELS')!;
      const v1 = towels.published;

      // The API refuses to edit a published version, and so does the database.
      await h
        .http()
        .patch(`/catalog/versions/${v1.id}`)
        .set('X-Test-Actor', gm())
        .send({ version: v1.version, priority: 'HIGH' })
        .expect(409);
      await expect(
        h.db.execute(
          sql`update catalog.service_versions set priority = 'HIGH' where id = ${v1.id}`,
        ),
      ).rejects.toThrow();
      await expect(
        h.db.execute(
          sql`update catalog.service_version_translations set name = 'x' where entity_id = ${v1.id}`,
        ),
      ).rejects.toThrow();

      const draft = await h
        .http()
        .post(`/catalog/services/${towels.id}/drafts`)
        .set('X-Test-Actor', gm())
        .expect(201);
      expect(draft.body).toMatchObject({ versionNo: 2, status: 'DRAFT' });
      await h
        .http()
        .post(`/catalog/services/${towels.id}/drafts`)
        .set('X-Test-Actor', gm())
        .expect(409);
      // A new choice field without labels cannot be published.
      const edited = await h
        .http()
        .patch(`/catalog/versions/${draft.body.id}`)
        .set('X-Test-Actor', gm())
        .send({
          version: draft.body.version,
          requiredFields: [
            { code: 'quantity', type: 'NUMBER', required: true, min: 1, max: 10 },
            { code: 'size', type: 'CHOICE', options: ['BATH', 'HAND'] },
          ],
        })
        .expect(200);
      const missing = await h
        .http()
        .post(`/catalog/versions/${draft.body.id}/publish`)
        .set('X-Test-Actor', gm())
        .send({ version: edited.body.version })
        .expect(422);
      expect(missing.body.code).toBe('catalog.version.label_missing');
      const labelled = await h
        .http()
        .patch(`/catalog/versions/${draft.body.id}`)
        .set('X-Test-Actor', gm())
        .send({
          version: edited.body.version,
          translations: [
            {
              locale: 'en',
              name: 'Extra towels',
              fieldLabels: {
                quantity: { label: 'How many' },
                size: { label: 'Size', options: { BATH: 'Bath', HAND: 'Hand' } },
              },
            },
            {
              locale: 'ar',
              name: 'مناشف إضافية',
              fieldLabels: {
                quantity: { label: 'العدد' },
                size: { label: 'المقاس', options: { BATH: 'حمّام', HAND: 'يد' } },
              },
            },
          ],
        })
        .expect(200);
      const published = await h
        .http()
        .post(`/catalog/versions/${draft.body.id}/publish`)
        .set('X-Test-Actor', gm())
        .send({ version: labelled.body.version })
        .expect(200);
      expect(published.body).toMatchObject({ versionNo: 2, status: 'PUBLISHED' });

      const detail = await h
        .http()
        .get(`/catalog/services/${towels.id}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(
        (detail.body.versions as Array<{ versionNo: number; status: string }>).map((v) => [
          v.versionNo,
          v.status,
        ]),
      ).toEqual([
        [2, 'PUBLISHED'],
        [1, 'SUPERSEDED'],
      ]);
      const guestView = services(await catalog(primary)).find((s) => s.code === 'EXTRA_TOWELS')!;
      expect(guestView.versionId).toBe(draft.body.id);
      expect(guestView.fields.find((f) => f.code === 'size')!.options).toEqual([
        { code: 'BATH', label: 'حمّام' },
        { code: 'HAND', label: 'يد' },
      ]);
      const [event] = (
        await h.db.execute(sql`select envelope->'payload' as payload from platform.outbox
        where event_type = 'catalog.service_version.published' and aggregate_id = ${towels.id}
        order by id desc limit 1`)
      ).rows as Array<{ payload: { version_no: number; superseded_version_id: string } }>;
      expect(event!.payload).toMatchObject({ version_no: 2, superseded_version_id: v1.id });
      const [audit] = (
        await h.db.execute(sql`select count(*)::int as n from audit.audit_log
        where action = 'catalog.version.publish' and entity_id = ${draft.body.id}`)
      ).rows as Array<{ n: number }>;
      expect(audit!.n).toBe(1);
    });

    it('tenant-wide services serve every property; a property service with the same code replaces it there', async () => {
      const chain = staff(chainId, hotel.tenantId);
      const category = await h
        .http()
        .post('/catalog/categories')
        .set('X-Test-Actor', chain)
        .send({
          code: 'LEISURE',
          sortOrder: 5,
          translations: [
            { locale: 'en', name: 'Leisure' },
            { locale: 'ar', name: 'الترفيه' },
          ],
        })
        .expect(201);
      const draft = (name: string, ar: string) => ({
        departmentCode: 'HK',
        translations: [
          { locale: 'en', name },
          { locale: 'ar', name: ar },
        ],
      });
      const pool = await h
        .http()
        .post('/catalog/services')
        .set('X-Test-Actor', chain)
        .send({
          code: 'POOL_TOWELS',
          categoryId: category.body.id,
          draft: draft('Pool towels', 'مناشف المسبح'),
        })
        .expect(201);
      expect(pool.body).toMatchObject({ propertyId: null, published: null });
      // A property-only manager may not publish what every property serves.
      await h
        .http()
        .post(`/catalog/versions/${pool.body.draft.id}/publish`)
        .set('X-Test-Actor', staff(propertyOnlyId, hotel.tenantId))
        .send({ version: pool.body.draft.version })
        .expect(403);
      await h
        .http()
        .post(`/catalog/versions/${pool.body.draft.id}/publish`)
        .set('X-Test-Actor', chain)
        .send({ version: pool.body.draft.version })
        .expect(200);
      expect(services(await catalog(primary)).find((s) => s.code === 'POOL_TOWELS')!.name).toBe(
        'مناشف المسبح',
      );

      // The property's own POOL_TOWELS (property manager) replaces the chain's at this property.
      const own = await h
        .http()
        .post('/catalog/services')
        .set('X-Test-Actor', staff(propertyOnlyId, hotel.tenantId))
        .send({
          propertyId: hotel.propertyId,
          code: 'POOL_TOWELS',
          categoryId: category.body.id,
          draft: draft('Beach and pool towels', 'مناشف الشاطئ والمسبح'),
        })
        .expect(201);
      await h
        .http()
        .post(`/catalog/versions/${own.body.draft.id}/publish`)
        .set('X-Test-Actor', staff(propertyOnlyId, hotel.tenantId))
        .send({ version: own.body.draft.version })
        .expect(200);
      const pools = services(await catalog(primary)).filter((s) => s.code === 'POOL_TOWELS');
      expect(pools.map((s) => s.name)).toEqual(['مناشف الشاطئ والمسبح']);

      // Retiring its own version opts the property out of the service; the chain's stays hidden here.
      await h
        .http()
        .patch(`/catalog/services/${own.body.id}`)
        .set('X-Test-Actor', gm())
        .send({ version: own.body.version + 1, status: 'RETIRED' })
        .expect(200);
      expect(services(await catalog(primary)).map((s) => s.code)).not.toContain('POOL_TOWELS');
    });

    it('refuses unknown departments and shows closed services as closed', async () => {
      const [cat] = (
        await h
          .http()
          .get(`/catalog/categories?propertyId=${hotel.propertyId}`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as Array<{ id: string }>;
      const ghost = await h
        .http()
        .post('/catalog/services')
        .set('X-Test-Actor', gm())
        .send({
          propertyId: hotel.propertyId,
          code: 'SPA_BOOKING',
          categoryId: cat!.id,
          draft: { departmentCode: 'SPA', translations: [{ locale: 'en', name: 'Spa' }] },
        })
        .expect(201);
      const refused = await h
        .http()
        .post(`/catalog/versions/${ghost.body.draft.id}/publish`)
        .set('X-Test-Actor', gm())
        .send({ version: ghost.body.draft.version })
        .expect(422);
      expect(refused.body.code).toBe('catalog.version.department_unknown');

      // Opening hours on no day of the week: listed, but closed now.
      const night = await h
        .http()
        .patch(`/catalog/versions/${ghost.body.draft.id}`)
        .set('X-Test-Actor', gm())
        .send({
          version: ghost.body.draft.version,
          departmentCode: 'FO',
          availability: {
            hours: [{ days: [(new Date().getUTCDay() + 3) % 7], from: '00:00', to: '00:01' }],
          },
        })
        .expect(200);
      await h
        .http()
        .post(`/catalog/versions/${ghost.body.draft.id}/publish`)
        .set('X-Test-Actor', gm())
        .send({ version: night.body.version })
        .expect(200);
      expect(
        services(await catalog(primary, 'en')).find((s) => s.code === 'SPA_BOOKING'),
      ).toMatchObject({
        name: 'Spa',
        openNow: false,
      });
    });

    it('tenants never see each other’s catalog (404)', async () => {
      const other = await createHotel(h, `cat-b-${stamp}`, otherId);
      const otherStaff = staff(otherId, other.tenantId);
      const mine = (
        await h
          .http()
          .get(`/catalog/services?propertyId=${hotel.propertyId}`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as Array<{ id: string; published: { id: string; version: number } | null }>;
      const target = mine.find((s) => s.published)!;
      await h
        .http()
        .get(`/catalog/services/${target.id}`)
        .set('X-Test-Actor', otherStaff)
        .expect(404);
      await h
        .http()
        .post(`/catalog/services/${target.id}/drafts`)
        .set('X-Test-Actor', otherStaff)
        .expect(404);
      await h
        .http()
        .post(`/catalog/versions/${target.published!.id}/publish`)
        .set('X-Test-Actor', otherStaff)
        .send({ version: target.published!.version })
        .expect(404);
      await h
        .http()
        .get(`/catalog/services?propertyId=${hotel.propertyId}`)
        .set('X-Test-Actor', otherStaff)
        .expect(404);
      const theirs = await h
        .http()
        .get('/catalog/services')
        .set('X-Test-Actor', otherStaff)
        .expect(200);
      expect(theirs.body).toEqual([]);
    });
  },
);
