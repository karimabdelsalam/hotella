import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Mocks the BFF and the API; the brand changes as the manager edits it. */
async function mockBackend(page: Page, permissions: readonly string[]) {
  const calls: Array<{ method: string; path: string; body: unknown; type: string | null }> = [];
  const profile = {
    displayName: null as string | null,
    primaryColor: null as string | null,
    logoAssetKey: null as string | null,
  };
  const resolved = () => ({
    propertyId: PROPERTY,
    displayName: profile.displayName ?? 'Red Sea Resort',
    primaryColor: profile.primaryColor ?? '#1F2937',
    logoAssetKey: profile.logoAssetKey,
    attribution: { show: true, label: 'Powered by Planova', href: 'https://planova.com.eg' },
  });
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = req.method();
    const type = (await req.headerValue('content-type')) ?? null;
    const body = type?.includes('json') ? req.postDataJSON() : (req.postDataBuffer() ?? null);
    calls.push({ method, path, body, type });
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [{ propertyId: PROPERTY, permissions }],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === '/public/branding') return r.fulfill({ json: resolved() });
    if (path === '/public/branding/logo')
      return profile.logoAssetKey
        ? r.fulfill({ body: PNG, contentType: 'image/png' })
        : r.fulfill({ status: 404, json: { code: 'org.brand_asset.not_found' } });
    const own = `/properties/${PROPERTY}/branding`;
    if (path === own && method === 'PATCH') Object.assign(profile, body as object);
    if (path === `${own}/logo` && method === 'PUT') profile.logoAssetKey = `brand/t1/logo-1.png`;
    if (path === `${own}/logo` && method === 'DELETE') profile.logoAssetKey = null;
    if (path.startsWith(own)) return r.fulfill({ json: { profile, resolved: resolved() } });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

test('a manager uploads the hotel logo and sets its name and colour; the header wears them', async ({
  page,
}) => {
  const backend = await mockBackend(page, ['branding.read', 'branding.manage']);
  await page.goto('/en/branding');
  await expect(page.getByRole('heading', { name: 'Hotel brand' })).toBeVisible();
  await expect(page.getByTestId('hotel-name')).toHaveText('Red Sea Resort');
  await expect(page.getByRole('link', { name: 'Brand' })).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('logo-file').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByRole('status')).toHaveText('The logo was updated.');
  const put = backend.calls.find((c) => c.method === 'PUT');
  expect(put?.path).toBe(`/properties/${PROPERTY}/branding/logo`);
  expect(put?.type).toBe('image/png');
  expect(Buffer.compare(put!.body as Buffer, PNG)).toBe(0);
  // The header and the preview now show the uploaded logo.
  await expect(page.locator('header img[alt="Red Sea Resort"]')).toBeVisible();
  await expect(page.getByTestId('brand-preview').locator('img')).toBeVisible();

  await page.getByLabel('Hotel name').fill('Red Sea Grand');
  await page.locator('input[dir="ltr"]').fill('#7a1f2b');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('The brand was saved.');
  expect(backend.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
    displayName: 'Red Sea Grand',
    primaryColor: '#7a1f2b',
  });
  await expect(page.getByTestId('hotel-name')).toHaveText('Red Sea Grand');
  // The hotel colour reaches the staff screens.
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue('--brand-primary')),
    )
    .toBe('#7a1f2b');

  await page.getByRole('button', { name: 'Remove logo' }).click();
  await expect(page.getByRole('status')).toHaveText('The logo was removed.');
  await expect(page.locator('header img')).toHaveCount(0);
  // The attribution stays, small, with its fixed text and link: it is not a brand setting.
  const footer = page.getByTestId('attribution');
  await expect(footer.getByRole('link', { name: 'Powered by Planova' })).toHaveAttribute(
    'href',
    'https://planova.com.eg',
  );
  expect(await footer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(12);
});

test('the brand page in Arabic is right-to-left, in Cairo, and only for managers', async ({
  page,
}) => {
  await mockBackend(page, ['branding.read', 'branding.manage']);
  await page.goto('/ar/branding');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'هوية الفندق' })).toBeVisible();
  await expect(page.getByText('رفع الشعار')).toBeVisible();
  await expect(page.getByRole('link', { name: 'الهوية' })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Cairo');
  // The Cairo face is bundled with the app and loads for Arabic text.
  expect(
    await page.evaluate(
      async () => (await document.fonts.load('16px "Cairo Variable"', 'مرحبا')).length,
    ),
  ).toBeGreaterThan(0);
  // Mirrored: the hotel mark sits on the right of the header.
  const mark = await page.getByTestId('hotel-name').boundingBox();
  const lang = await page.getByRole('combobox', { name: 'اللغة' }).boundingBox();
  expect(mark!.x).toBeGreaterThan(lang!.x);
});

test('someone without brand rights is told so', async ({ page }) => {
  await mockBackend(page, ['hk.board.read']);
  await page.goto('/en/branding');
  await expect(page.getByText('You do not manage the brand of any hotel.')).toBeVisible();
});
