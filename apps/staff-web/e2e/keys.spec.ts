import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const ROOM = '01900000-0000-7000-8000-0000000000e1';
const STAY = '01900000-0000-7000-8000-0000000000e2';

async function mockBackend(page: Page, permissions: string[]) {
  const acted: Array<{ path: string; body: unknown }> = [];
  const grants: Array<Record<string, unknown>> = [
    {
      id: 'g-wifi',
      kind: 'WIFI',
      roomNumber: '504',
      status: 'FAILED',
      validUntil: '2026-10-08T11:00:00Z',
      issuedAt: null,
      revokedAt: null,
      revokeReason: null,
      version: 2,
    },
  ];
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const base = `/properties/${PROPERTY}`;
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [{ propertyId: PROPERTY, permissions }],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === `${base}/rooms`)
      return r.fulfill({
        json: [
          { locationId: ROOM, roomNumber: '504' },
          { locationId: 'r-505', roomNumber: '505' },
        ],
      });
    if (path === `${base}/rooms/${ROOM}/current-stay`)
      return r.fulfill({
        json: {
          id: STAY,
          status: 'IN_HOUSE',
          expectedDeparture: '2026-10-08',
          room: { id: ROOM, roomNumber: '504' },
          primaryGuest: { givenName: 'Lina', familyName: 'Stone' },
        },
      });
    if (path === `${base}/rooms/r-505/current-stay`)
      return r.fulfill({ status: 404, json: { code: 'guest.stay.not_in_room' } });
    if (path === `${base}/stays/${STAY}/access` && r.request().method() === 'GET')
      return r.fulfill({ json: { available: ['KEY', 'WIFI'], grants } });
    if (path === `${base}/stays/${STAY}/access`) {
      const body = r.request().postDataJSON() as { kind: string };
      acted.push({ path, body });
      grants.push({
        id: 'g-key',
        kind: body.kind,
        roomNumber: '504',
        status: 'ISSUED',
        validUntil: '2026-10-08T11:00:00Z',
        issuedAt: new Date().toISOString(),
        revokedAt: null,
        revokeReason: null,
        version: 2,
      });
      return r.fulfill({ status: 201, json: grants.at(-1) });
    }
    if (path === `${base}/stays/${STAY}/access/g-key/revoke`) {
      acted.push({ path, body: null });
      Object.assign(grants.at(-1)!, { status: 'REVOKE_REQUESTED', revokeReason: 'STAFF' });
      return r.fulfill({ json: grants.at(-1) });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { acted };
}

test('the desk finds the guest by room, encodes a key and revokes a lost card (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, [
    'access.read',
    'access.key.issue',
    'access.wifi.issue',
    'stay.read',
    'org.property.read',
  ]);
  await page.goto('/en/keys');
  await expect(page.getByRole('heading', { name: 'Room keys and Wi-Fi' })).toBeVisible();
  await page.getByLabel('Room').fill('505');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('No guest is checked in to this room.')).toBeVisible();

  await page.getByLabel('Room').fill('504');
  await page.getByRole('button', { name: 'Find' }).click();
  const stay = page.getByRole('region', { name: 'Guest in the room' });
  await expect(stay).toContainText('Lina Stone');
  await expect(stay).toContainText('Room 504');
  await expect(stay.locator('[data-grant="g-wifi"]')).toContainText('Failed');
  // The hotel has no mobile keys: only what the systems serve is offered.
  await expect(stay.getByRole('button', { name: 'Send a mobile key' })).toHaveCount(0);
  await stay.getByRole('button', { name: 'Encode a key card' }).click();
  const key = stay.locator('[data-grant="g-key"]');
  await expect(key).toContainText('Key card');
  await expect(key).toContainText('Active');
  await key.getByRole('button', { name: 'Revoke' }).click();
  await expect(key).toContainText('Being revoked');
  await expect(key).toContainText('Revoked by staff');
  expect(backend.acted).toEqual([
    { path: `/properties/${PROPERTY}/stays/${STAY}/access`, body: { kind: 'KEY' } },
    { path: `/properties/${PROPERTY}/stays/${STAY}/access/g-key/revoke`, body: null },
  ]);
  await expect(stay).toContainText('Check-out and room moves revoke keys and Wi-Fi automatically.');
});

test('a viewer sees the keys but cannot issue; Arabic is right-to-left', async ({ page }) => {
  await mockBackend(page, ['access.read', 'stay.read', 'org.property.read']);
  await page.goto('/ar/keys');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'مفاتيح الغرف والواي فاي' })).toBeVisible();
  await page.getByLabel('الغرفة').fill('504');
  await page.getByRole('button', { name: 'بحث' }).click();
  const stay = page.getByRole('region', { name: 'النزيل في الغرفة' });
  await expect(stay).toContainText('Lina Stone');
  await expect(stay.locator('[data-grant="g-wifi"]')).toContainText('فشل');
  await expect(stay.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'المفاتيح والواي فاي' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
