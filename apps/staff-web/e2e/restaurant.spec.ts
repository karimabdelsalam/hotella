import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const TERRAZZA = '01900000-0000-7000-8000-0000000000r1';
const EARLY = '01900000-0000-7000-8000-0000000000s1';
const LATE = '01900000-0000-7000-8000-0000000000s2';
const STAY = '01900000-0000-7000-8000-0000000000a1';
const ALL = [
  'restaurant.restaurant.read',
  'restaurant.restaurant.manage',
  'restaurant.reservation.read',
  'restaurant.reservation.manage',
  'restaurant.reservation.override',
];

/** Mocks the API: one restaurant with two sittings, one reservation on the board and a guest in room 504. */
async function mockBackend(page: Page, permissions: readonly string[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let status = 'CONFIRMED';
  let version = 1;
  const restaurant = (locale: string) => ({
    id: TERRAZZA,
    code: 'LA_TERRAZZA',
    status: 'ACTIVE',
    name: locale === 'ar' ? 'لا تيرازا' : 'La Terrazza',
    description: null,
    dressCode: null,
    minParty: 1,
    maxParty: 8,
    bookDaysAhead: 7,
    guestCutoffMinutes: 120,
    allowanceApplies: true,
    version: 3,
  });
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = req.method();
    const type = (await req.headerValue('content-type')) ?? '';
    const body = type.includes('json') ? req.postDataJSON() : null;
    calls.push({ method, path: path + url.search, body });
    const locale = (await req.headerValue('accept-language')) ?? 'en';
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
    if (path === `${base}/restaurants`) return r.fulfill({ json: [restaurant(locale)] });
    if (path === `${base}/restaurant-reservations` && method === 'GET')
      return r.fulfill({
        json: [
          {
            ...restaurant(locale),
            sittings: [
              {
                sittingId: EARLY,
                startsAt: '19:00',
                seats: 4,
                booked: 0,
                free: 4,
                reservations: [],
              },
              {
                sittingId: LATE,
                startsAt: '21:00',
                seats: 20,
                booked: 2,
                free: 18,
                reservations: [
                  {
                    id: 'res1',
                    restaurantId: TERRAZZA,
                    sittingId: LATE,
                    serviceDate: '2026-10-06',
                    startsAt: '21:00',
                    partySize: 2,
                    roomNumber: '101',
                    guestName: 'Giulia Rossi',
                    status,
                    channel: 'GUEST_APP',
                    notes: 'Nut allergy',
                    overridden: false,
                    version,
                  },
                ],
              },
            ],
          },
        ],
      });
    if (path === `${base}/restaurant-reservations/res1/seat`) {
      status = 'SEATED';
      version += 1;
      return r.fulfill({ json: {} });
    }
    if (path === `${base}/restaurant-reservations/stays`)
      return r.fulfill({
        json:
          url.searchParams.get('room') === '504'
            ? [
                {
                  stayId: STAY,
                  status: 'IN_HOUSE',
                  roomNumber: '504',
                  guestName: 'Hans Weber',
                  partySize: 2,
                  arrival: '2020-01-01',
                  departure: '2099-01-01',
                  nights: 8,
                  allowance: [
                    {
                      restaurantId: TERRAZZA,
                      name: restaurant(locale).name,
                      allowed: 2,
                      used: 2,
                      remaining: 0,
                    },
                  ],
                },
              ]
            : [],
      });
    if (path === `${base}/restaurants/availability`)
      return r.fulfill({
        json: [
          {
            ...restaurant(locale),
            days: [
              {
                date: url.searchParams.get('from'),
                sittings: [
                  { sittingId: EARLY, startsAt: '19:00', seats: 4, booked: 0, free: 4 },
                  { sittingId: LATE, startsAt: '21:00', seats: 20, booked: 2, free: 18 },
                ],
              },
            ],
          },
        ],
      });
    if (path === `${base}/restaurant-reservations` && method === 'POST')
      return r.fulfill({ status: 201, json: { id: 'res2', status: 'CONFIRMED' } });
    if (path === `${base}/restaurants/${TERRAZZA}`)
      return r.fulfill({
        json: {
          ...restaurant(locale),
          translations: [{ locale: 'en', name: 'La Terrazza', description: null, dressCode: null }],
          sittings: [
            { id: EARLY, weekday: 1, startsAt: '19:00', seats: 4, validFrom: '2026-10-01' },
          ],
          closures: [],
        },
      });
    if (path === `${base}/restaurants/${TERRAZZA}/sittings`) return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

test('the restaurant host seats a guest and books a table on the phone past the allowance, with a reason (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, ALL);
  await page.goto('/en/restaurant');
  await expect(page.getByRole('link', { name: 'Restaurant' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const row = page.locator('[data-reservation="101"]');
  await expect(row).toContainText('Giulia Rossi');
  await expect(row).toContainText('2 guests');
  await expect(row).toContainText('Nut allergy');
  await expect(row).toContainText('Guest app');
  await row.getByRole('button', { name: 'Seat' }).click();
  await expect(row).toContainText('Seated');
  expect(backend.calls.find((c) => c.path.endsWith('/res1/seat'))?.body).toEqual({ version: 1 });

  await page.getByRole('tab', { name: 'New booking' }).click();
  await page.getByRole('textbox', { name: 'Room' }).fill('504');
  await page.getByRole('button', { name: 'Find' }).click();
  const stay = page.locator('[data-stay="504"]');
  await expect(stay).toContainText('Hans Weber');
  await expect(stay).toContainText('La Terrazza: 0 left');
  await stay.click();
  await page.locator('[data-sitting="21:00"]').click();
  await expect(page.getByText('This stay has used its bookings at this restaurant.')).toBeVisible();
  await page.getByLabel('Notes (allergies, wishes)').fill('Window table');
  await page.getByLabel('Book anyway (beyond the allowance or seats)').check();
  const book = page.getByRole('button', { name: 'Book', exact: true });
  await expect(book).toBeDisabled();
  await page.getByLabel('Reason (required, recorded)').fill('Anniversary, approved by the GM');
  await book.click();
  await expect(page.getByRole('status')).toContainText('Booked for room 504');
  const posted = backend.calls.find(
    (c) => c.method === 'POST' && c.path.endsWith('/restaurant-reservations'),
  )?.body as Record<string, unknown>;
  expect(posted).toMatchObject({
    restaurantId: TERRAZZA,
    sittingId: LATE,
    partySize: 2,
    stayId: STAY,
    notes: 'Window table',
    override: { reason: 'Anniversary, approved by the GM' },
  });
});

test('in Arabic the board reads right-to-left, and without the override permission there is no override', async ({
  page,
}) => {
  await mockBackend(page, [
    'restaurant.restaurant.read',
    'restaurant.reservation.read',
    'restaurant.reservation.manage',
  ]);
  await page.goto('/ar/restaurant');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'لا تيرازا' })).toBeVisible();
  await expect(page.locator('[data-reservation="101"]')).toContainText('شخصان');
  await expect(page.getByRole('tab', { name: 'الإعداد' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'حجز جديد' }).click();
  await page.getByRole('textbox', { name: 'الغرفة' }).fill('504');
  await page.getByRole('button', { name: 'بحث' }).click();
  await page.locator('[data-stay="504"]').click();
  await expect(page.getByText('احجز رغم ذلك (تجاوز الحد أو المقاعد)')).toHaveCount(0);
});

test('the manager sets up the weekly sittings (Setup)', async ({ page }) => {
  const backend = await mockBackend(page, ALL);
  await page.goto('/en/restaurant');
  await page.getByRole('tab', { name: 'Setup' }).click();
  await expect(page.getByRole('heading', { name: 'La Terrazza', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Repeat the first sitting every day' }).click();
  await expect(page.locator('[data-row]')).toHaveCount(7);
  await page.getByRole('button', { name: 'Save the schedule' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  const put = backend.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/sittings'))
    ?.body as { sittings: Array<{ weekday: number; startsAt: string; seats: number }> };
  expect(put.sittings.map((s) => s.weekday).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(put.sittings.every((s) => s.startsAt === '19:00' && s.seats === 4)).toBe(true);
});

for (const [locale, tab] of [
  ['it', 'Prenotazioni'],
  ['ru', 'Бронирования'],
  ['de', 'Reservierungen'],
] as const)
  test(`the board in ${locale}`, async ({ page }) => {
    await mockBackend(page, ALL);
    await page.goto(`/${locale}/restaurant`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-reservation="101"]')).toContainText('Giulia Rossi');
  });
