import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';

/** Mocks a person who may open housekeeping and the logbook, at a hotel licensed for the logbook only. */
async function mockBackend(page: Page, codes: string[] | null) {
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const path = new URL(r.request().url()).pathname.replace(/^\/hotella/, '');
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [{ propertyId: PROPERTY, permissions: ['hk.board.read', 'logbook.read'] }],
        },
      });
    if (path === '/me/entitlements')
      return codes
        ? r.fulfill({ json: { propertyId: null, unrestricted: false, codes } })
        : r.fulfill({ status: 503, json: { code: 'platform.unavailable' } });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
}

const nav = (page: Page) => page.getByRole('navigation');

test('the header offers only the modules in the hotel’s licence (English)', async ({ page }) => {
  await mockBackend(page, ['CORE', 'LOGBOOK']);
  await page.goto('/en/logbook');
  await expect(nav(page).locator('a[href$="/logbook"]')).toBeVisible();
  await expect(nav(page).locator('a[href$="/housekeeping"]')).toHaveCount(0);
});

test('in Arabic, the same licence hides the same module, right-to-left', async ({ page }) => {
  await mockBackend(page, ['CORE', 'LOGBOOK']);
  await page.goto('/ar/logbook');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(nav(page).locator('a[href$="/logbook"]')).toBeVisible();
  await expect(nav(page).locator('a[href$="/housekeeping"]')).toHaveCount(0);
});

test('when the licence cannot be read, nothing is hidden (the API still refuses what is not licensed)', async ({
  page,
}) => {
  await mockBackend(page, null);
  await page.goto('/en/logbook');
  await expect(nav(page).locator('a[href$="/housekeeping"]')).toBeVisible();
  await expect(nav(page).locator('a[href$="/logbook"]')).toBeVisible();
});
