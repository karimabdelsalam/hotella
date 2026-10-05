// Unit test of the demo content tool: the Sea Beach Edge demo file, its checks, and the stay scenario it generates
// (the deployed run is the CI job "Ubuntu one-command install", which installs with infra/install/sea-beach-edge.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { demoScenario, hotelToday, validateDemo } from './demo-content.mjs';

const read = (f) =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/pilot/sea-beach-edge/${f}`, import.meta.url), 'utf8'),
  );
const profile = read('profile.json');
const demo = read('demo.json');

test('the Sea Beach Edge demo is valid against its profile, with one tenant-wide general manager', () => {
  assert.deepEqual(validateDemo(demo, profile), []);
  assert.equal(demo.staff.filter((s) => s.role === 'GENERAL_MANAGER').length, 1);
  // Fictional, reserved addresses only (RFC 2606): no real person's data in the repository.
  for (const s of demo.staff) assert.match(s.email, /@seabeachedge\.example$/);
});

test('mistakes are refused, never guessed', () => {
  const bad = structuredClone(demo);
  bad.staff[0].scope = undefined;
  bad.staff[1].email = bad.staff[2].email;
  bad.restaurants[0].sittings = ['7pm'];
  bad.pms.guests[0].room = '999';
  bad.pms.guests[1].state = 'ARRIVING';
  bad.pms.guests[1].arrival = -1;
  const problems = validateDemo(bad, profile).join('\n');
  for (const expected of [
    'exactly one GENERAL_MANAGER with scope TENANT',
    'staff[2]: duplicate e-mail',
    'restaurants[0].sittings',
    'room 999 is not a room of the profile',
    'an arriving guest arrives today or later',
  ])
    assert.ok(problems.includes(expected), `expected "${expected}" in:\n${problems}`);
});

test('the scenario is dated from the hotel’s today: in house, arriving and checked out', () => {
  const yaml = demoScenario(demo, profile, '2026-10-06');
  assert.match(yaml, /timezone: "Africa\/Cairo"/);
  // In house since two days, five nights.
  assert.match(
    yaml,
    /id: "DEMO-1"\n.*\n.*\n {6}arrival: "2026-10-04"\n {6}departure: "2026-10-09"\n {6}room: "104"\n {2}- checkin: \{ id: "DEMO-1", room: "104" \}/,
  );
  // Arriving today: reserved, not checked in.
  assert.match(yaml, /room: "302"\n {2}- reserve:/);
  assert.doesNotMatch(yaml, /checkin: \{ id: "DEMO-6"/);
  // Checked out today.
  assert.match(
    yaml,
    /departure: "2026-10-06"\n {6}room: "V03"\n {2}- checkin: \{ id: "DEMO-7", room: "V03" \}\n {2}- checkout: \{ id: "DEMO-7" \}/,
  );
  assert.equal((yaml.match(/- checkin:/g) ?? []).length, 7);
  assert.ok(yaml.trimEnd().endsWith('- wait_acked: {}'));
});

test('today is the hotel’s date, not the server’s', () => {
  const lateEvening = new Date('2026-10-05T22:30:00Z'); // already the 6th in Cairo (UTC+3)
  assert.equal(hotelToday('Africa/Cairo', lateEvening), '2026-10-06');
  assert.equal(hotelToday('UTC', lateEvening), '2026-10-05');
});
