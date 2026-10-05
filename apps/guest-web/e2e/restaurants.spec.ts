import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const TERRAZZA = '01900000-0000-7000-8000-0000000000r1';
const EARLY = '01900000-0000-7000-8000-0000000000s1';
const LATE = '01900000-0000-7000-8000-0000000000s2';
const branding = {
  propertyId: PROPERTY,
  displayName: 'Nile View Hotel',
  logoAssetKey: null,
  primaryColor: '#0a7d5a',
  welcomeText: null,
  attribution: { show: true, label: 'Powered by Planova', href: 'https://planova.com.eg' },
};
const NAMES: Record<string, string> = {
  en: 'La Terrazza',
  ar: 'لا تيرازا',
  it: 'La Terrazza',
  ru: 'Ла Терацца',
  de: 'La Terrazza',
};

/** A signed-in guest with the DINING scope; one restaurant with two nights and two sittings each. */
async function mockBackend(page: Page, opts: { remaining: number }) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let remaining = opts.remaining;
  let booked: Record<string, unknown> | null = null;
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella\//, '');
    const method = r.request().method();
    const body = r.request().postDataJSON?.() ?? null;
    calls.push({ method, path, body });
    const locale = r.request().headers()['accept-language'] ?? 'en';
    if (path === 'public/branding') return r.fulfill({ json: branding });
    if (path === 'guest/me')
      return r.fulfill({
        json: {
          guest: { givenName: 'Giulia', locale },
          stay: {
            id: 's1',
            status: 'IN_HOUSE',
            expectedDeparture: '2030-12-31',
            room: { number: '504' },
          },
          scopes: ['SERVICE_REQUEST', 'CHAT', 'DINING'],
          property: { id: PROPERTY, name: 'Nile View' },
          branding,
        },
      });
    if (path === 'guest/services') return r.fulfill({ json: { categories: [] } });
    if (path === 'guest/room-signals') return r.fulfill({ json: { active: [] } });
    if (path === 'guest/restaurants')
      return r.fulfill({
        json: {
          restaurants: [
            {
              id: TERRAZZA,
              code: 'LA_TERRAZZA',
              status: 'ACTIVE',
              name: NAMES[locale] ?? 'La Terrazza',
              description: locale === 'it' ? 'Cucina italiana' : 'Italian cuisine',
              dressCode: null,
              minParty: 1,
              maxParty: 6,
              allowance: { allowed: 1, used: 1 - remaining, remaining },
              days: ['2030-06-10', '2030-06-11'].map((date) => ({
                date,
                sittings: [
                  {
                    sittingId: EARLY,
                    startsAt: '19:00',
                    seats: 4,
                    booked: 4,
                    free: 0,
                    bookable: false,
                  },
                  {
                    sittingId: LATE,
                    startsAt: '21:00',
                    seats: 20,
                    booked: 2,
                    free: 18,
                    bookable: true,
                  },
                ],
              })),
            },
          ],
        },
      });
    if (path === 'guest/restaurant-reservations' && method === 'POST') {
      remaining = 0;
      booked = {
        id: 'res1',
        restaurantId: TERRAZZA,
        serviceDate: (body as { serviceDate: string }).serviceDate,
        startsAt: '21:00',
        partySize: (body as { partySize: number }).partySize,
        status: 'CONFIRMED',
        restaurant: { name: NAMES[locale] },
      };
      return r.fulfill({ status: 201, json: booked });
    }
    if (path === 'guest/restaurant-reservations')
      return r.fulfill({ json: booked ? [booked] : [] });
    if (path === 'guest/restaurant-reservations/res1/cancel') {
      booked = { ...booked!, status: 'CANCELLED' };
      remaining = 1;
      return r.fulfill({ json: booked });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

test('a guest books a table from home in three taps, then cancels it (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, { remaining: 1 });
  await page.goto('/en');
  await page.getByRole('link', { name: 'Restaurants' }).click();
  await expect(page.getByRole('heading', { name: 'Restaurants', level: 1 })).toBeVisible();
  const card = page.locator(`[data-restaurant="${TERRAZZA}"]`);
  await expect(card).toContainText('You can book here 1 more time during your stay.');
  await card.getByRole('button', { name: /11/ }).click();
  await expect(card.locator('[data-sitting="19:00"]')).toBeDisabled();
  await card.locator('[data-sitting="21:00"]').click();
  await card.getByRole('combobox', { name: 'Guests' }).selectOption('3');
  await card.getByLabel('Allergies or wishes (optional)').fill('Gluten free');
  await card.getByRole('button', { name: 'Book a table' }).click();
  await expect(page.getByRole('status')).toContainText('Your table is booked: La Terrazza');
  expect(
    backend.calls.find((c) => c.method === 'POST' && c.path === 'guest/restaurant-reservations')
      ?.body,
  ).toEqual({
    restaurantId: TERRAZZA,
    sittingId: LATE,
    serviceDate: '2030-06-11',
    partySize: 3,
    notes: 'Gluten free',
  });
  await expect(card).toContainText('You have used your booking here for this stay.');
  const mine = page.locator('[data-reservation="res1"]');
  await expect(mine).toContainText('3 guests');
  await mine.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status')).toHaveText('Your reservation was cancelled.');
  await expect(card).toContainText('You can book here 1 more time during your stay.');
});

test('in Arabic the page is right-to-left and a used allowance offers no booking', async ({
  page,
}) => {
  await mockBackend(page, { remaining: 0 });
  await page.goto('/ar/restaurants');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const card = page.locator(`[data-restaurant="${TERRAZZA}"]`);
  await expect(card.getByRole('heading', { name: 'لا تيرازا' })).toBeVisible();
  await expect(card).toContainText('لقد استخدمت حجزك في هذا المطعم خلال هذه الإقامة.');
  await expect(card.getByRole('button', { name: 'احجز طاولة' })).toHaveCount(0);
});

for (const [locale, title, left] of [
  ['it', 'Ristoranti', 'Puoi prenotare qui ancora 1 volta durante il soggiorno.'],
  ['ru', 'Рестораны', 'Здесь можно забронировать ещё 1 раз за время проживания.'],
  ['de', 'Restaurants', 'Sie können hier während Ihres Aufenthalts noch 1 Mal reservieren.'],
] as const)
  test(`the restaurants page in ${locale}`, async ({ page }) => {
    await mockBackend(page, { remaining: 1 });
    await page.goto(`/${locale}/restaurants`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
    await expect(page.locator(`[data-restaurant="${TERRAZZA}"]`)).toContainText(left);
  });
