// Unit test of the hotel provisioner (node --test infra/docker/pilot): profile validation, room expansion, and an
// idempotent run against an in-memory stand-in of the API (the deployed path is the CI "pilot deployment smoke").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { expandRooms, NotLicensedError, provision, validateProfile } from './provision.mjs';

const example = JSON.parse(
  readFileSync(new URL('./profiles/example.json', import.meta.url), 'utf8'),
);
const seaBeachEdge = JSON.parse(
  readFileSync(new URL('../../../docs/pilot/sea-beach-edge/profile.json', import.meta.url), 'utf8'),
);

/** A minimal in-memory API: tenants, properties (with a root location), room types, locations, rooms, departments. */
function fakeApi({ licensed = true } = {}) {
  let seq = 0;
  const id = () => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
  const db = {
    tenants: [],
    properties: [],
    roomTypes: [],
    locations: [],
    rooms: [],
    departments: [],
    settings: [],
  };
  const calls = [];
  const json = (status, body) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  });
  const tree = (propertyId) => {
    const nodes = db.locations
      .filter((l) => l.propertyId === propertyId)
      .map((l) => ({ ...l, children: [] }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const roots = [];
    for (const n of nodes) (n.parentId ? byId.get(n.parentId).children : roots).push(n);
    return roots;
  };
  const fetchFn = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/api\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push(`${init.method} ${path}`);
    assert.equal(init.headers.authorization, 'Bearer t0ken');
    let m;
    if (path === '/tenants')
      return init.method === 'GET'
        ? json(200, db.tenants)
        : json(201, (db.tenants.push({ id: id(), ...body }), db.tenants.at(-1)));
    if (/^\/control\/tenants\/[^/]+\/entitlements$/.test(path))
      return json(200, { entitlements: licensed ? [{ code: 'CORE' }] : [] });
    if (path === '/properties') {
      if (init.method === 'GET')
        return json(
          200,
          db.properties.filter((p) => p.tenantId === searchParams.get('tenantId')),
        );
      const property = { id: id(), ...body };
      db.properties.push(property);
      db.locations.push({
        id: id(),
        propertyId: property.id,
        parentId: null,
        kind: 'OTHER',
        code: property.code,
      });
      return json(201, property);
    }
    if (!(m = path.match(/^\/properties\/([^/]+)\/([a-z-]+)$/))) return json(404, {});
    const [, propertyId, what] = m;
    assert.ok(searchParams.get('tenantId'), `${path} names the tenant`);
    const list = {
      'room-types': db.roomTypes,
      locations: db.locations,
      rooms: db.rooms,
      departments: db.departments,
    }[what];
    if (init.method === 'GET')
      return json(
        200,
        what === 'locations' ? tree(propertyId) : list.filter((x) => x.propertyId === propertyId),
      );
    if (what === 'rooms') {
      assert.ok(
        db.locations.some((l) => l.id === body.parentId && l.kind === 'FLOOR'),
        'rooms go under a floor',
      );
      db.locations.push({
        id: id(),
        propertyId,
        parentId: body.parentId,
        kind: 'ROOM',
        code: body.roomNumber,
      });
    }
    const row = { id: id(), propertyId, ...body };
    list.push(row);
    return json(201, row);
  };
  const configFetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (!pathname.startsWith('/api/v1/config/values')) return fetchFn(url, init);
    calls.push(`${init.method} ${pathname.replace(/^\/api\/v1/, '')}`);
    if (init.method === 'GET')
      return json(
        200,
        db.settings.filter((v) => v.propertyId === searchParams.get('propertyId')),
      );
    const body = JSON.parse(init.body);
    const key = pathname.split('/').at(-1);
    db.settings = db.settings.filter((v) => !(v.key === key && v.propertyId === body.propertyId));
    db.settings.push({ key, ...body });
    db.writes = (db.writes ?? 0) + 1;
    return json(200, {});
  };
  return { db, calls, fetchFn: configFetch };
}

test('the example profile is valid and expands its room ranges', () => {
  assert.deepEqual(validateProfile(example), []);
  const rooms = expandRooms(example);
  assert.equal(rooms.length, 12);
  assert.deepEqual(rooms[0], { building: 'MAIN', floor: 'F1', number: '101', roomType: 'DBL' });
  assert.equal(rooms.at(-1).number, 'P1');
});

test('the Sea Beach Edge profile (demo values for now) is valid: 50 rooms, five languages', () => {
  assert.deepEqual(validateProfile(seaBeachEdge), []);
  assert.equal(seaBeachEdge.demo, true);
  assert.equal(seaBeachEdge.property.name, 'Sea Beach Edge');
  assert.deepEqual(seaBeachEdge.property.enabledLocales, ['en', 'ar', 'it', 'ru', 'de']);
  const rooms = expandRooms(seaBeachEdge);
  assert.equal(rooms.length, 50);
  assert.deepEqual(rooms.at(-1), {
    building: 'BEACH',
    floor: 'GF',
    number: 'V08',
    roomType: 'VIL',
  });
});

test('a value still marked TBD is listed once and stops the profile', () => {
  const pending = structuredClone(seaBeachEdge);
  pending.property.timezone = 'TBD';
  pending.buildings = 'TBD';
  const problems = validateProfile(pending);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.equal(problems[0], 'still to fill (TBD): property.timezone, buildings');
});

test('validation refuses what the API would refuse, and never guesses', () => {
  const bad = structuredClone(example);
  bad.tenant.code = 'x';
  bad.property.currency = 'pounds';
  bad.property.enabledLocales = ['en', 'fr'];
  bad.roomTypes.push({ ...bad.roomTypes[0] });
  bad.buildings[0].floors[0].rooms.push(
    { number: '101' },
    { from: 1, to: 900 },
    { number: '1', roomType: 'NOPE' },
  );
  bad.departments[0].names = { ar: 'بدون إنجليزي' };
  bad.departments.pop();
  bad.settings.push({ key: 'room_context', value: true });
  const problems = validateProfile(bad).join('\n');
  for (const expected of [
    'tenant.code',
    'property.currency',
    'property.enabledLocales',
    'duplicate code DBL',
    'room 101 appears twice',
    'at most 500 rooms',
    'roomType NOPE is not in roomTypes',
    'departments[0]: names.en is required',
    'FO is required',
    'settings[1]',
  ])
    assert.ok(problems.includes(expected), `expected "${expected}" in:\n${problems}`);
});

test('provision creates the hotel once and is idempotent on a second run', async () => {
  const api = fakeApi();
  const first = await provision(example, {
    api: 'http://api/api/v1/',
    token: 't0ken',
    fetchFn: api.fetchFn,
  });
  assert.deepEqual(first.counts, {
    tenant: { created: 1, existing: 0 },
    property: { created: 1, existing: 0 },
    roomType: { created: 2, existing: 0 },
    building: { created: 1, existing: 0 },
    floor: { created: 2, existing: 0 },
    room: { created: 12, existing: 0 },
    department: { created: 3, existing: 0 },
    setting: { created: 1, existing: 0 },
  });
  const room = api.db.rooms.find((r) => r.roomNumber === '201');
  assert.equal(room.roomTypeId, api.db.roomTypes.find((t) => t.code === 'TWN').id);
  assert.equal(room.floorLabel, '2');
  assert.deepEqual(
    api.db.roomTypes[0].translations.map((t) => t.locale),
    ['en', 'ar', 'it', 'ru', 'de'],
  );
  assert.equal(api.db.settings[0].scope, 'PROPERTY');
  assert.equal(api.db.settings[0].propertyId, first.propertyId);

  const second = await provision(example, {
    api: 'http://api/api/v1',
    token: 't0ken',
    fetchFn: api.fetchFn,
  });
  assert.equal(second.propertyId, first.propertyId);
  for (const [what, count] of Object.entries(second.counts))
    assert.equal(count.created, 0, `${what} created again`);
  assert.equal(api.db.writes, 1, 'an unchanged setting is not written again');
  assert.equal(api.db.rooms.length, 12);
});

test('an unlicensed tenant stops the run after the tenant; --tenant-only creates only the tenant', async () => {
  const api = fakeApi({ licensed: false });
  const only = await provision(example, {
    api: 'http://api/api/v1',
    token: 't0ken',
    tenantOnly: true,
    fetchFn: api.fetchFn,
  });
  assert.equal(only.propertyId, null);
  assert.deepEqual(api.calls, ['GET /tenants', 'POST /tenants']);
  await assert.rejects(
    provision(example, { api: 'http://api/api/v1', token: 't0ken', fetchFn: api.fetchFn }),
    NotLicensedError,
  );
  assert.equal(api.db.properties.length, 0);
});

test('an API refusal stops the run with the status, never with the token', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"code":"auth.forbidden"}',
  });
  await assert.rejects(
    provision(example, { api: 'http://api/api/v1', token: 't0ken', fetchFn }),
    (e) => /GET \/tenants → 403/.test(e.message) && !e.message.includes('t0ken'),
  );
});
