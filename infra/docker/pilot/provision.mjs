#!/usr/bin/env node
// Provision a hotel from a profile (docs/pilot/README.md): tenant, property, buildings, floors, room types, rooms,
// departments and property settings, through the public API as a platform administrator. Structure only: the hotel's
// content (services, staff, knowledge) is the hotel's own, and a platform administrator has no right to it (Spec §64).
// Idempotent: what exists (by code or room number) is kept, only what is missing is created, so the same profile can be
// applied again as it grows.
// Nothing hotel-specific lives in code (CLAUDE.md rule 15): every name and number comes from the profile.
//
//   node provision.mjs --check <profile.json>                       validate only (no API calls)
//   node provision.mjs --api <url> --token <token> <profile.json>   apply (token: platform administrator)
//   ... --tenant-only                                               create the tenant only (to license it first)
//
// The token can also come from $HOTELLA_TOKEN; it is never printed. A hotel whose tenant has no licence could be set up
// (platform administrators pass the entitlement stage) but its staff could not use it, so an unlicensed tenant stops the
// run after the tenant with exit code 3 (`pilot.sh provision` licenses it in between).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CODE = /^[A-Z][A-Z0-9_-]{1,31}$/;
const LOCALES = ['en', 'ar', 'it', 'ru', 'de'];
const PLACEHOLDER = /\bTBD\b/;
const CORE_DEPARTMENTS = ['HK', 'ENG', 'FO'];

const list = (v) => (Array.isArray(v) ? v : []);

/** Every room number a profile describes, in order, with its place. */
export function expandRooms(profile) {
  const out = [];
  for (const b of list(profile.buildings))
    for (const f of list(b.floors))
      for (const spec of list(f.rooms)) {
        if (typeof spec.number === 'string')
          out.push({
            building: b.code,
            floor: f.code,
            number: spec.number,
            roomType: spec.roomType ?? null,
          });
        else if (
          Number.isInteger(spec.from) &&
          Number.isInteger(spec.to) &&
          spec.to - spec.from < 500
        )
          for (let n = spec.from; n <= spec.to; n++)
            out.push({
              building: b.code,
              floor: f.code,
              number: String(n),
              roomType: spec.roomType ?? null,
            });
      }
  return out;
}

/**
 * The problems of a profile (empty when it can be applied). Values still marked `TBD` are listed once, as what is left
 * to fill, and are not reported again as malformed.
 */
export function validateProfile(profile) {
  const problems = [];
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  const names = (obj, where) => {
    need(
      obj && typeof obj === 'object' && typeof obj.en === 'string' && obj.en.trim(),
      `${where}: names.en is required`,
    );
    for (const l of Object.keys(obj ?? {}))
      need(LOCALES.includes(l), `${where}: unsupported locale ${l}`);
  };
  need(profile?.profileVersion === 1, 'profileVersion must be 1');
  const placeholders = [];
  const walk = (v, path) => {
    if (typeof v === 'string' && PLACEHOLDER.test(v)) placeholders.push(path);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(profile, '');
  const pending = (problem) =>
    placeholders.some(
      (path) => problem.startsWith(path) && /^($|[:.[ ])/.test(problem.slice(path.length)),
    );
  const t = profile?.tenant ?? {};
  need(CODE.test(t.code ?? ''), 'tenant.code: 2–32 upper-case letters, digits, - or _');
  need(typeof t.name === 'string' && t.name.trim(), 'tenant.name is required');
  const p = profile?.property ?? {};
  need(CODE.test(p.code ?? ''), 'property.code: 2–32 upper-case letters, digits, - or _');
  need(typeof p.name === 'string' && p.name.trim(), 'property.name is required');
  need(
    typeof p.timezone === 'string' && /^[A-Za-z_]+\/[A-Za-z_]+/.test(p.timezone),
    'property.timezone: an IANA zone',
  );
  need(/^[A-Z]{3}$/.test(p.currency ?? ''), 'property.currency: ISO 4217');
  need(/^[A-Z]{2}$/.test(p.country ?? ''), 'property.country: ISO 3166 alpha-2');
  need(LOCALES.includes(p.defaultLocale), 'property.defaultLocale: one of ' + LOCALES.join(', '));
  need(
    Array.isArray(p.enabledLocales) &&
      p.enabledLocales.length > 0 &&
      p.enabledLocales.every((l) => LOCALES.includes(l)),
    'property.enabledLocales: supported locales',
  );
  const types = new Set();
  for (const [i, rt] of list(profile?.roomTypes).entries()) {
    need(CODE.test(rt.code ?? ''), `roomTypes[${i}].code`);
    need(
      Number.isInteger(rt.capacity) && rt.capacity >= 1 && rt.capacity <= 20,
      `roomTypes[${i}].capacity: 1–20`,
    );
    names(rt.names, `roomTypes[${i}]`);
    need(!types.has(rt.code), `roomTypes[${i}]: duplicate code ${rt.code}`);
    types.add(rt.code);
  }
  for (const [bi, b] of list(profile?.buildings).entries()) {
    need(CODE.test(b.code ?? ''), `buildings[${bi}].code`);
    names(b.names, `buildings[${bi}]`);
    for (const [fi, f] of list(b.floors).entries()) {
      need(CODE.test(f.code ?? ''), `buildings[${bi}].floors[${fi}].code`);
      names(f.names, `buildings[${bi}].floors[${fi}]`);
      for (const [ri, r] of list(f.rooms).entries()) {
        const where = `buildings[${bi}].floors[${fi}].rooms[${ri}]`;
        if (typeof r.number === 'string')
          need(/^[A-Za-z0-9-]{1,16}$/.test(r.number), `${where}.number`);
        else
          need(
            Number.isInteger(r.from) &&
              Number.isInteger(r.to) &&
              r.from <= r.to &&
              r.to - r.from < 500,
            `${where}: { from, to } (at most 500 rooms per range) or { number }`,
          );
        if (r.roomType != null)
          need(types.has(r.roomType), `${where}.roomType ${r.roomType} is not in roomTypes`);
      }
    }
  }
  const seen = new Set();
  for (const r of expandRooms(profile ?? {})) {
    need(!seen.has(r.number), `room ${r.number} appears twice`);
    seen.add(r.number);
  }
  need(seen.size > 0, 'buildings: at least one floor with rooms');
  need(Array.isArray(profile?.roomTypes), 'roomTypes: a list');
  for (const [i, d] of list(profile?.departments).entries()) {
    need(CODE.test(d.code ?? ''), `departments[${i}].code`);
    names(d.names, `departments[${i}]`);
  }
  // Housekeeping, engineering and the service catalog route work to these departments by code.
  const departments = new Set(list(profile?.departments).map((d) => d.code));
  for (const code of CORE_DEPARTMENTS)
    need(departments.has(code), `departments: ${code} is required (work is routed to it)`);
  for (const [i, s] of list(profile?.settings).entries())
    need(
      typeof s.key === 'string' &&
        /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(s.key) &&
        'value' in s,
      `settings[${i}]: { key: <context>.<area>.<name>, value }`,
    );
  const rest = problems.filter((p) => !pending(p));
  return placeholders.length ? [`still to fill (TBD): ${placeholders.join(', ')}`, ...rest] : rest;
}

const translations = (names) => Object.entries(names).map(([locale, name]) => ({ locale, name }));

/** The tenant has no in-force licence yet: nothing past the tenant can be created. */
export class NotLicensedError extends Error {
  constructor(code) {
    super(
      `tenant ${code} has no licence yet; license it (pilot.sh provision does), then run again`,
    );
    this.tenantCode = code;
  }
}

/** Applies a valid profile; returns what was created and what already existed. */
export async function provision(
  profile,
  { api, token, tenantOnly = false, fetchFn = fetch, log = () => {} },
) {
  const base = api.replace(/\/+$/, '');
  const call = async (method, path, body) => {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const counts = {};
  const note = (what, created) => {
    counts[what] ??= { created: 0, existing: 0 };
    counts[what][created ? 'created' : 'existing']++;
  };

  // Tenant and property, by code.
  let tenant = (await call('GET', '/tenants')).find((x) => x.code === profile.tenant.code);
  note('tenant', !tenant);
  tenant ??= await call('POST', '/tenants', {
    code: profile.tenant.code,
    name: profile.tenant.name,
    defaultLocale: profile.property.defaultLocale,
    defaultTimezone: profile.property.timezone,
    defaultCurrency: profile.property.currency,
  });
  log(`tenant ${tenant.code} (${tenant.id})`);
  if (tenantOnly) return { tenantId: tenant.id, propertyId: null, counts };
  const licence = await call('GET', `/control/tenants/${tenant.id}/entitlements`);
  if (!(licence?.entitlements ?? []).some((e) => e.code === 'CORE'))
    throw new NotLicensedError(tenant.code);

  let property = (await call('GET', `/properties?tenantId=${tenant.id}`)).find(
    (x) => x.code === profile.property.code,
  );
  note('property', !property);
  property ??= await call('POST', '/properties', {
    tenantId: tenant.id,
    code: profile.property.code,
    name: profile.property.name,
    timezone: profile.property.timezone,
    currency: profile.property.currency,
    country: profile.property.country,
    defaultLocale: profile.property.defaultLocale,
    enabledLocales: profile.property.enabledLocales,
  });
  log(`property ${property.code} (${property.id})`);
  const p = `/properties/${property.id}`;
  const q = `?tenantId=${tenant.id}`;

  // Room types.
  const roomTypes = new Map((await call('GET', `${p}/room-types${q}`)).map((t) => [t.code, t.id]));
  for (const rt of profile.roomTypes ?? []) {
    note('roomType', !roomTypes.has(rt.code));
    if (!roomTypes.has(rt.code))
      roomTypes.set(
        rt.code,
        (
          await call('POST', `${p}/room-types${q}`, {
            code: rt.code,
            capacity: rt.capacity,
            translations: translations(rt.names),
          })
        ).id,
      );
  }

  // Buildings and floors under the property's root location, by code.
  const tree = await call('GET', `${p}/locations${q}`);
  const root = (Array.isArray(tree) ? tree : [tree]).find((n) => n.parentId === null);
  if (!root) throw new Error(`property ${property.code} has no root location`);
  const childByCode = (node, code) => (node?.children ?? []).find((c) => c.code === code);
  const floors = new Map();
  for (const [bi, b] of (profile.buildings ?? []).entries()) {
    let building = childByCode(root, b.code);
    note('building', !building);
    building ??= {
      ...(await call('POST', `${p}/locations${q}`, {
        parentId: root.id,
        kind: 'BUILDING',
        code: b.code,
        sortOrder: bi,
        translations: translations(b.names),
      })),
      children: [],
    };
    for (const [fi, f] of list(b.floors).entries()) {
      let floor = childByCode(building, f.code);
      note('floor', !floor);
      floor ??= await call('POST', `${p}/locations${q}`, {
        parentId: building.id,
        kind: 'FLOOR',
        code: f.code,
        sortOrder: fi,
        translations: translations(f.names),
      });
      floors.set(`${b.code}/${f.code}`, { id: floor.id, label: f.floorLabel ?? null });
    }
  }

  // Rooms, by number.
  const existing = new Set((await call('GET', `${p}/rooms${q}`)).map((r) => r.roomNumber));
  for (const r of expandRooms(profile)) {
    note('room', !existing.has(r.number));
    if (existing.has(r.number)) continue;
    const floor = floors.get(`${r.building}/${r.floor}`);
    await call('POST', `${p}/rooms${q}`, {
      parentId: floor.id,
      roomNumber: r.number,
      roomTypeId: r.roomType ? roomTypes.get(r.roomType) : null,
      floorLabel: floor.label,
    });
    existing.add(r.number);
  }

  // Departments, by code.
  const departments = new Set((await call('GET', `${p}/departments${q}`)).map((d) => d.code));
  for (const d of profile.departments ?? []) {
    note('department', !departments.has(d.code));
    if (!departments.has(d.code))
      await call('POST', `${p}/departments${q}`, {
        code: d.code,
        translations: translations(d.names),
      });
  }

  // Property settings (configuration is versioned and audited by the platform); an unchanged value is not written again.
  const target = `scope=PROPERTY&tenantId=${tenant.id}&propertyId=${property.id}`;
  const stored = new Map(
    (await call('GET', `/config/values?${target}`)).map((v) => [v.key, JSON.stringify(v.value)]),
  );
  for (const s of profile.settings ?? []) {
    const same = stored.get(s.key) === JSON.stringify(s.value);
    note('setting', !same);
    if (!same)
      await call('PUT', `/config/values/${s.key}`, {
        scope: 'PROPERTY',
        tenantId: tenant.id,
        propertyId: property.id,
        value: s.value,
        reason: `hotel profile ${profile.property.code}`,
      });
  }
  return { tenantId: tenant.id, propertyId: property.id, counts };
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const bool = (name) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const check = bool('--check');
  const tenantOnly = bool('--tenant-only');
  const api = flag('--api') ?? 'http://localhost:3000/api/v1';
  const token = flag('--token') ?? process.env.HOTELLA_TOKEN;
  const file = args[0];
  if (!file)
    throw new Error(
      'usage: provision.mjs [--check | --tenant-only] [--api <url> --token <token>] <profile.json>',
    );
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateProfile(profile);
  if (problems.length) {
    process.stderr.write(`profile ${file} is not ready:\n- ${problems.join('\n- ')}\n`);
    process.exit(2);
  }
  const rooms = expandRooms(profile).length;
  if (check) {
    process.stdout.write(`profile ${file} is valid: ${profile.property.name}, ${rooms} rooms\n`);
    return;
  }
  if (!token)
    throw new Error('a platform administrator token is needed (--token or $HOTELLA_TOKEN)');
  const result = await provision(profile, {
    api,
    token,
    tenantOnly,
    log: (l) => process.stdout.write(`${l}\n`),
  });
  // One line, last: what scripts read (`grep '^result ' | tail -1`).
  process.stdout.write(`result ${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main(process.argv).catch((e) => {
    process.stderr.write(`provision failed: ${e.message}\n`);
    process.exit(e instanceof NotLicensedError ? 3 : 1);
  });
