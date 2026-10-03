import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const soon = () => new Date(Date.now() + 60 * 60_000).toISOString();

async function mockBackend(page: Page) {
  const days: string[] = [];
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [
            { propertyId: PROPERTY, permissions: ['hk.arrivals.read', 'hk.board.read'] },
          ],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === `/properties/${PROPERTY}/housekeeping/arrival-risk`) {
      const day = url.searchParams.get('day') ?? 'today';
      days.push(day);
      return r.fulfill({
        json: {
          day: day === 'today' ? '2026-10-03' : '2026-10-04',
          arrivals:
            day === 'today'
              ? [
                  {
                    stayId: 's1',
                    guestName: 'Sara Adel',
                    vip: true,
                    eta: soon(),
                    roomNumber: '504',
                    housekeeping: 'DIRTY',
                    ready: false,
                    score: 80,
                    level: 'HIGH',
                    reasons: ['ROOM_DIRTY', 'OPEN_ENGINEERING_WORK', 'ETA_SOON', 'VIP_GUEST'],
                  },
                  {
                    stayId: 's2',
                    guestName: 'Omar Nabil',
                    vip: false,
                    eta: null,
                    roomNumber: null,
                    housekeeping: null,
                    ready: false,
                    score: 30,
                    level: 'MEDIUM',
                    reasons: ['NO_ROOM_ASSIGNED'],
                  },
                  {
                    stayId: 's3',
                    guestName: 'Lina Fares',
                    vip: false,
                    eta: soon(),
                    roomNumber: '201',
                    housekeeping: 'INSPECTED',
                    ready: true,
                    score: 0,
                    level: 'LOW',
                    reasons: [],
                  },
                ]
              : [],
        },
      });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { days };
}

test('the front desk sees today’s arrivals riskiest first, with the reasons (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto('/en/arrivals');
  await expect(page.getByRole('heading', { name: 'Arrivals' })).toBeVisible();
  await expect(page.getByTestId('summary')).toHaveText('3 arrivals · 2 at risk');
  const cards = page.locator('[data-stay]');
  await expect(cards).toHaveCount(3);
  await expect(cards.first()).toHaveAttribute('data-level', 'HIGH');
  await expect(cards.first()).toContainText('Sara Adel');
  await expect(cards.first()).toContainText('VIP');
  await expect(cards.first()).toContainText('High risk · 80');
  await expect(cards.first()).toContainText('Room not cleaned');
  await expect(cards.first()).toContainText('Open maintenance work');
  await expect(cards.first()).toContainText('Arriving within 2 hours');
  await expect(page.locator('[data-stay="s2"]')).toContainText('No room assigned');
  await expect(page.locator('[data-stay="s3"]')).toContainText('Room ready');
  await page.getByRole('tab', { name: 'Tomorrow' }).click();
  await expect(page.getByText('No expected arrivals.')).toBeVisible();
  expect(backend.days).toEqual(['today', 'tomorrow']);
});

test('arrivals in Arabic are right-to-left and translated, the risk bar on the start side', async ({
  page,
}) => {
  await mockBackend(page);
  await page.goto('/ar/arrivals');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const first = page.locator('[data-stay="s1"]');
  await expect(first).toContainText('خطر مرتفع · 80');
  await expect(first).toContainText('الغرفة لم تُنظَّف');
  await expect(first).toContainText('يصل خلال ساعتين');
  await expect(page.getByRole('link', { name: 'الوصول' })).toHaveAttribute('aria-current', 'page');
  const card = await first.boundingBox();
  const bar = await first.locator('span[aria-hidden]').first().boundingBox();
  // In RTL the start side is the right.
  expect(bar!.x + bar!.width).toBeGreaterThan(card!.x + card!.width - 2);
});
