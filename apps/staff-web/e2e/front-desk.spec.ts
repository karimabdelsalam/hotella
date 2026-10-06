import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const STAY = '01900000-0000-7000-8000-0000000000a1';
const BREZZA = '01900000-0000-7000-8000-0000000000r1';
const SITTING = '01900000-0000-7000-8000-0000000000s1';
const DESK = [
  'org.property.read',
  'stay.read',
  'catalog.read',
  'request.read',
  'request.create',
  'request.manage',
  'restaurant.restaurant.read',
  'restaurant.reservation.read',
  'restaurant.reservation.manage',
  'access.read',
  'complaint.read',
  'complaint.manage',
  'inbox.read',
  'hk.arrivals.read',
];
const ATTENDANT = ['org.property.read', 'hk.board.read', 'lostfound.register', 'task.read'];

/** Today where the browser runs (the hotel), as the screens compute it. */
const today = () => new Date().toLocaleDateString('en-CA');
const shift = (days: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function stay(id: string, given: string, arrival: string, departure: string, status = 'IN_HOUSE') {
  return {
    id,
    status,
    expectedArrival: arrival,
    expectedDeparture: departure,
    actualCheckinAt: null,
    eta: status === 'EXPECTED' ? '15:30:00' : null,
    adults: 2,
    children: 0,
    primaryGuest: { givenName: given, familyName: 'Demo', vipCode: null },
  };
}

/**
 * The API in memory: two guests in house (one leaving today), two expected (one today), room 204 with a stay and
 * room 305 empty, two published services, one restaurant with one sitting, one open request.
 */
async function mockBackend(page: Page, permissions: readonly string[], signedIn = true) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const requests = [
    {
      id: 'req-1',
      serviceCode: 'HOUSEKEEPING_CLEAN',
      serviceName: 'Room cleaning',
      stayId: STAY,
      status: 'OPEN',
      source: 'GUEST',
      requestedForAt: null,
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      roomNumber: '204',
      guestName: 'Mona Demo',
    },
  ];
  await page.route('**/bff/refresh', (r) =>
    signedIn
      ? r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } })
      : r.fulfill({ status: 401, json: {} }),
  );
  await page.route('**/bff/login', (r) => {
    signedIn = true;
    return r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } });
  });
  await page.route('**/hotella/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as unknown);
    if (method !== 'GET') calls.push({ method, path, body });
    const locale = (await req.headerValue('accept-language')) ?? 'en';
    const base = `/properties/${PROPERTY}`;
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1', givenName: 'Mona', familyName: 'Adel' },
          memberships: [{ propertyId: PROPERTY, permissions }],
        },
      });
    if (path === '/me/entitlements') return r.fulfill({ json: { unrestricted: true, codes: [] } });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Sea Beach Edge' }] });
    if (path === `${base}/stays`)
      return r.fulfill({
        json:
          url.searchParams.get('status') === 'IN_HOUSE'
            ? [stay(STAY, 'Mona', shift(-2), shift(3)), stay('s-2', 'Karim', shift(-4), today())]
            : [
                stay('s-3', 'Laila', today(), shift(2), 'EXPECTED'),
                stay('s-4', 'Omar', shift(1), shift(5), 'EXPECTED'),
              ],
      });
    if (path === `${base}/service-requests`)
      return r.fulfill({
        json: url.searchParams.get('stayId')
          ? requests.filter((x) => x.stayId === url.searchParams.get('stayId'))
          : requests.filter((x) => x.status === 'OPEN' || x.status === 'IN_PROGRESS'),
      });
    if (path === `${base}/restaurant-reservations` && method === 'GET')
      return r.fulfill({
        json: [
          {
            id: BREZZA,
            name: 'La Brezza',
            sittings: [
              {
                sittingId: SITTING,
                startsAt: '19:00',
                seats: 20,
                booked: 3,
                free: 17,
                reservations: [
                  { id: 'x1', status: 'CONFIRMED' },
                  { id: 'x2', status: 'SEATED' },
                  { id: 'x3', status: 'CANCELLED' },
                ],
              },
            ],
          },
        ],
      });
    if (path === `${base}/rooms`)
      return r.fulfill({
        json: [
          { locationId: 'loc-204', roomNumber: '204' },
          { locationId: 'loc-305', roomNumber: '305' },
        ],
      });
    if (path === `${base}/rooms/loc-204/current-stay`)
      return r.fulfill({
        json: {
          ...stay(STAY, 'Mona', shift(-2), shift(3)),
          room: { id: 'loc-204', roomNumber: '204' },
        },
      });
    if (path === `${base}/rooms/loc-305/current-stay`)
      return r.fulfill({ status: 404, json: { code: 'guest.stay.not_found' } });
    if (path === '/catalog/services')
      return r.fulfill({
        json: [
          {
            id: 'svc-1',
            code: 'EXTRA_TOWELS',
            status: 'ACTIVE',
            published: {
              id: 'v1',
              requiredFields: [
                { code: 'quantity', type: 'NUMBER', required: true, min: 1, max: 6 },
                { code: 'size', type: 'CHOICE', required: false, options: ['BATH', 'POOL'] },
              ],
              availability: { allowScheduling: false },
              translations: [
                {
                  locale: 'en',
                  name: 'Extra towels',
                  fieldLabels: {
                    quantity: { label: 'How many' },
                    size: { label: 'Kind', options: { BATH: 'Bath towel', POOL: 'Pool towel' } },
                  },
                },
                {
                  locale: 'ar',
                  name: 'مناشف إضافية',
                  fieldLabels: { quantity: { label: 'العدد' }, size: { label: 'النوع' } },
                },
              ],
            },
          },
          {
            id: 'svc-2',
            code: 'RETIRED_THING',
            status: 'RETIRED',
            published: { id: 'v2', translations: [{ locale: 'en', name: 'Old service' }] },
          },
        ],
      });
    if (path === `${base}/stays/${STAY}/service-requests`) {
      const created = {
        ...requests[0]!,
        id: 'req-2',
        serviceCode: 'EXTRA_TOWELS',
        serviceName: locale.startsWith('ar') ? 'مناشف إضافية' : 'Extra towels',
        source: 'STAFF',
        createdAt: new Date().toISOString(),
      };
      requests.unshift(created);
      return r.fulfill({ json: { request: created, related: false } });
    }
    if (path === `${base}/service-requests/req-1/cancel`) {
      requests.find((x) => x.id === 'req-1')!.status = 'CANCELLED';
      return r.fulfill({ json: { id: 'req-1', status: 'CANCELLED' } });
    }
    if (path === `${base}/restaurant-reservations/stays`)
      return r.fulfill({
        json:
          url.searchParams.get('room') === '204'
            ? [
                {
                  stayId: STAY,
                  status: 'IN_HOUSE',
                  roomNumber: '204',
                  guestName: 'Mona Demo',
                  partySize: 2,
                  arrival: shift(-2),
                  departure: shift(3),
                  nights: 5,
                  allowance: [
                    { restaurantId: BREZZA, name: 'La Brezza', allowed: 2, used: 0, remaining: 2 },
                  ],
                },
              ]
            : [],
      });
    if (path === `${base}/restaurants/availability`)
      return r.fulfill({
        json: [
          {
            id: BREZZA,
            name: 'La Brezza',
            days: [
              {
                date: url.searchParams.get('from'),
                sittings: [
                  { sittingId: SITTING, startsAt: '19:00', seats: 20, booked: 3, free: 17 },
                ],
              },
            ],
          },
        ],
      });
    if (path === `${base}/restaurant-reservations` && method === 'POST')
      return r.fulfill({ json: { id: 'res-9', status: 'CONFIRMED' } });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

test('the desk starts on its home page: today in numbers, what to start, and the open requests (English)', async ({
  page,
}) => {
  await mockBackend(page, DESK);
  await page.goto('/en');
  await expect(page).toHaveURL(/\/en\/home$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Mona');
  const today = page.getByRole('list', { name: 'Today at the hotel' });
  await expect(today.locator('[data-stat="Guests in house"]')).toHaveText('2');
  await expect(today.locator('[data-stat="Arrivals today"]')).toHaveText('1');
  await expect(today.locator('[data-stat="Departures today"]')).toHaveText('1');
  await expect(today.locator('[data-stat="Open guest requests"]')).toHaveText('1');
  await expect(today.locator('[data-stat="Restaurant bookings today"]')).toHaveText('2');
  await expect(page.getByText('Laila Demo')).toBeVisible();
  await expect(page.getByText('Omar Demo')).toHaveCount(0);
  // The side navigation is grouped the way the hotel works.
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByText('Reception', { exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Front desk' })).toBeVisible();
  await expect(nav.locator('a[href$="/housekeeping"]')).toHaveCount(0);
  // "+ New" offers what this role starts.
  await page.getByRole('button', { name: 'New' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Guest request (phone)',
    'Restaurant booking',
    'Guest complaint',
  ]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  // An open request leads to its room at the desk.
  await page.getByRole('link', { name: /Room cleaning/ }).click();
  await expect(page).toHaveURL(/\/en\/front-desk\?room=204$/);
  await expect(page.getByTestId('stay-card')).toContainText('Mona Demo');
});

test('a guest calls the desk: a service request, its cancellation and a table for the room (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, DESK);
  await page.goto('/en/home');
  // The top bar's search finds a room from anywhere.
  await page.getByRole('searchbox', { name: 'Quick search' }).fill('204');
  await page.getByRole('searchbox', { name: 'Quick search' }).press('Enter');
  await expect(page).toHaveURL(/\/en\/front-desk\?room=204$/);
  const card = page.getByTestId('stay-card');
  await expect(card).toContainText('Mona Demo');
  await expect(card).toContainText('In house');
  await expect(card.getByRole('link', { name: 'Keys & Wi-Fi' })).toBeVisible();

  // A service on the phone: only published, active services are offered.
  const form = page.getByRole('region', { name: 'Guest request' });
  await expect(form.getByRole('button', { name: 'Old service' })).toHaveCount(0);
  await form.getByRole('button', { name: 'Extra towels' }).click();
  const send = form.getByRole('button', { name: 'Send: Extra towels' });
  await expect(send).toBeDisabled();
  await form.getByLabel('How many *').fill('3');
  await form.getByLabel('Kind').selectOption('POOL');
  await send.click();
  await expect(page.getByRole('status')).toHaveText(
    'Extra towels is on its way to the team for room 204.',
  );
  expect(
    backend.calls.find((c) => c.path.endsWith(`/stays/${STAY}/service-requests`))?.body,
  ).toEqual({ serviceCode: 'EXTRA_TOWELS', fields: { quantity: 3, size: 'POOL' } });
  const list = page.getByRole('region', { name: 'Requests of this stay' });
  await expect(list.locator('[data-request="EXTRA_TOWELS"]')).toContainText('by staff');

  // The guest changed their mind about the cleaning.
  const cleaning = list.locator('[data-request="HOUSEKEEPING_CLEAN"]');
  await cleaning.getByRole('button', { name: 'Cancel this request' }).click();
  await cleaning.getByLabel('Why (optional, recorded)').fill('Guest asked later');
  await cleaning.getByRole('button', { name: 'Cancel it' }).click();
  await expect(page.getByRole('status')).toHaveText('Room cleaning was cancelled.');
  await expect(cleaning).toContainText('Cancelled');
  expect(backend.calls.find((c) => c.path.endsWith('/req-1/cancel'))?.body).toEqual({
    reason: 'Guest asked later',
  });

  // And a table tonight, without searching the room again.
  await page.getByRole('tab', { name: 'Restaurant booking' }).click();
  await expect(page.getByRole('heading', { name: 'Stays in room 204' })).toBeVisible();
  await page.locator('[data-sitting="19:00"]').click();
  await page.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Booked for room 204');
  expect(
    backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/restaurant-reservations'))
      ?.body,
  ).toMatchObject({ restaurantId: BREZZA, sittingId: SITTING, stayId: STAY, partySize: 2 });
});

test('the same desk in Arabic: right-to-left, navigation on the right, rooms that are empty or unknown', async ({
  page,
}) => {
  await mockBackend(page, DESK);
  await page.goto('/ar/front-desk?do=restaurant');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'الاستقبال' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'الأقسام' });
  await expect(nav.getByRole('link', { name: 'الاستقبال' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav.getByText('خدمة النزلاء')).toBeVisible();
  // Mirrored: the navigation sits on the right of the page.
  const side = await page.getByTestId('sidebar').boundingBox();
  const main = await page.locator('main').boundingBox();
  expect(side!.x).toBeGreaterThan(main!.x);

  const room = page.getByRole('textbox', { name: 'الغرفة' });
  await room.fill('305');
  await page.getByRole('button', { name: 'ابحث' }).click();
  await expect(page.getByText('لا يوجد نزيل في غرفة 305 الآن.')).toBeVisible();
  await room.fill('999');
  await page.getByRole('button', { name: 'ابحث' }).click();
  await expect(page.getByText('لا توجد غرفة 999 في هذا الفندق.')).toBeVisible();
  await room.fill('204');
  await page.getByRole('button', { name: 'ابحث' }).click();
  await expect(page.getByTestId('stay-card')).toContainText('مقيم');
  // Asked for a booking from "+ New": the restaurant tab is open.
  await expect(page.getByRole('tab', { name: 'حجز مطعم' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'طلب خدمة' }).click();
  await expect(page.getByRole('button', { name: 'مناشف إضافية' })).toBeVisible();
  await expect(page.getByTestId('attribution')).toContainText('Powered by Planova');
});

test('a room attendant sees only their own sections and no desk tools', async ({ page }) => {
  await mockBackend(page, ATTENDANT);
  await page.goto('/en/home');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Mona');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav.locator('a[href$="/housekeeping"]')).toBeVisible();
  await expect(nav.locator('a[href$="/front-desk"]')).toHaveCount(0);
  await expect(nav.getByText('Reception', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Today at the hotel' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Found item']);
});

test('signing in returns the person to the page they asked for', async ({ page }) => {
  await mockBackend(page, DESK, false);
  await page.goto('/en/front-desk');
  await expect(page).toHaveURL(/\/en\/login$/);
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await page.getByLabel('Hotel code').fill('SEA_BEACH_EDGE');
  await page.getByLabel('Email').fill('desk@seabeachedge.example');
  await page.getByLabel('Password').fill('a long enough passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/en\/front-desk$/);
  await expect(page.getByTestId('sidebar')).toBeVisible();
});
