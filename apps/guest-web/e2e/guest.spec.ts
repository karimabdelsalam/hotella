import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const TOKEN = 'link-token-0123456789abcdef';
const QR = 'qr-token-0123456789abcdef';

const branding = {
  displayName: 'Nile View Hotel',
  primaryColor: '#0a7d5a',
  welcomeText: null,
  attribution: { show: true, label: 'Powered by Planova', href: 'https://planova.com.eg' },
};
const me = (locale: 'en' | 'ar') => ({
  guest: { givenName: locale === 'ar' ? 'منى' : 'Mona', locale },
  stay: { id: 's1', status: 'IN_HOUSE', expectedDeparture: '2030-12-31', room: { number: '504' } },
  scopes: ['SERVICE_REQUEST', 'CHAT'],
  property: { id: PROPERTY, name: 'Nile View' },
  branding,
});
const towels = (ar: boolean) => ({
  code: 'EXTRA_TOWELS',
  name: ar ? 'مناشف إضافية' : 'Extra towels',
  shortDescription: ar ? 'مناشف نظيفة تصل إلى غرفتك' : 'Fresh towels brought to your room',
  description: null,
  price: null,
  openNow: true,
  allowScheduling: false,
  fields: [
    {
      code: 'quantity',
      type: 'NUMBER',
      required: true,
      label: ar ? 'العدد' : 'How many',
      min: 1,
      max: 6,
    },
    {
      code: 'notes',
      type: 'TEXT',
      required: false,
      label: ar ? 'ملاحظات' : 'Anything we should know',
      maxLength: 300,
    },
  ],
});
const catalog = (ar: boolean) => ({
  categories: [
    {
      code: 'HOUSEKEEPING',
      icon: 'sparkles',
      name: ar ? 'التدبير الفندقي' : 'Housekeeping',
      services: [towels(ar)],
    },
  ],
});

/** Mocks the BFF and the API (through the same-origin proxy) in the browser; records what the pages send. */
async function mockBackend(page: Page, opts: { signedIn: boolean; locale?: 'en' | 'ar' }) {
  const calls: Array<{ method: string; path: string; body: unknown; lang: string | undefined }> =
    [];
  let signedIn = opts.signedIn;
  const ar = opts.locale === 'ar';
  await page.route('**/bff/verify', async (r) => {
    calls.push({
      method: 'POST',
      path: '/bff/verify',
      body: r.request().postDataJSON(),
      lang: undefined,
    });
    signedIn = true;
    await r.fulfill({
      json: { expiresAt: '2030-12-31T00:00:00Z', scopes: ['SERVICE_REQUEST', 'CHAT'] },
    });
  });
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella\//, '');
    const method = r.request().method();
    calls.push({
      method,
      path,
      body: r.request().postDataJSON?.() ?? null,
      lang: r.request().headers()['accept-language'],
    });
    if (path === 'guest/activation/start')
      return r.fulfill(
        r.request().postDataJSON().token === TOKEN
          ? {
              json: {
                propertyId: PROPERTY,
                propertyName: 'Nile View',
                expiresAt: '2030-01-01T00:00:00Z',
              },
            }
          : { status: 410, json: { code: 'comms.activation.token_used' } },
      );
    if (path === `guest/qr/${QR}`)
      return r.fulfill({
        json: { propertyId: PROPERTY, propertyName: 'Nile View', roomNumber: '504' },
      });
    if (path === `guest/qr/${QR}/verify`) return r.fulfill({ json: { ok: true } });
    if (path === 'public/branding') return r.fulfill({ json: branding });
    if (path === 'guest/activation/otp/request')
      return r.fulfill({
        json: {
          handle: 'handle-0123456789abcdef',
          reference: 'K7P2QX',
          sentVia: 'WHATSAPP',
          expiresAt: '2030-01-01T00:00:00Z',
          resendAfter: new Date(Date.now() + 30_000).toISOString(),
        },
      });
    if (!signedIn) return r.fulfill({ status: 401, json: { code: 'platform.unauthorized' } });
    if (path === 'guest/me') return r.fulfill({ json: me(opts.locale ?? 'en') });
    if (path === 'guest/services') return r.fulfill({ json: catalog(ar) });
    if (path === 'guest/services/EXTRA_TOWELS') return r.fulfill({ json: towels(ar) });
    if (path === 'guest/requests' && method === 'POST')
      return r.fulfill({
        status: 201,
        json: { related: false, request: { id: 'r1', status: 'OPEN' } },
      });
    if (path === 'guest/requests')
      return r.fulfill({
        json: [
          {
            id: 'r1',
            serviceCode: 'EXTRA_TOWELS',
            serviceName: ar ? 'مناشف إضافية' : 'Extra towels',
            status: 'IN_PROGRESS',
            relatedCount: 0,
            createdAt: new Date().toISOString(),
            closedAt: null,
          },
          {
            id: 'r2',
            serviceCode: 'WIFI_HELP',
            serviceName: ar ? 'مساعدة في الواي فاي' : 'Wi-Fi help',
            status: 'OPEN',
            relatedCount: 0,
            createdAt: new Date().toISOString(),
            closedAt: null,
          },
        ],
      });
    if (path === 'guest/requests/r2/cancel')
      return r.fulfill({ json: { id: 'r2', status: 'CANCELLED' } });
    if (path === 'guest/conversation')
      return r.fulfill({
        json: {
          conversation: { id: 'c1', status: 'OPEN' },
          messages: [
            {
              id: 'm1',
              direction: 'INBOUND',
              senderType: 'GUEST',
              body: ar ? 'الجو حر أوي هنا' : 'It is hot in here',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'm2',
              direction: 'OUTBOUND',
              senderType: 'SYSTEM',
              body: ar
                ? 'نعمل على طلبك: مشكلة في التكييف.'
                : 'We are on it: Air conditioning problem.',
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

test('activates by link and asks for towels in English (left-to-right)', async ({ page }) => {
  const backend = await mockBackend(page, { signedIn: false, locale: 'en' });
  await page.goto(`/en/a/${TOKEN}`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { name: 'Welcome to Nile View' })).toBeVisible();
  await expect(page.getByTestId('hotel-name')).toHaveText('Nile View Hotel');
  await page.getByLabel('Your mobile number').fill('0100 111 2233');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByText('We sent a 6-digit code to your WhatsApp.')).toBeVisible();
  await expect(page.getByTestId('reference')).toHaveText('K7P2QX');
  await expect(
    page.getByRole('button', { name: /Send another way in \d+ seconds/ }),
  ).toBeDisabled();
  await page.getByLabel('Code').fill('123456');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page).toHaveURL(/\/en$/);
  expect(backend.calls.find((c) => c.path === '/bff/verify')?.body).toEqual({
    handle: 'handle-0123456789abcdef',
    code: '123456',
  });
  expect(backend.calls.find((c) => c.path === 'guest/activation/otp/request')?.body).toEqual({
    token: TOKEN,
    phone: '0100 111 2233',
  });

  await expect(page.getByRole('heading', { name: 'Welcome, Mona' })).toBeVisible();
  await expect(page.getByText('Room 504')).toBeVisible();
  await page.getByRole('link', { name: /Extra towels/ }).click();
  await expect(page.getByRole('heading', { name: 'Extra towels' })).toBeVisible();
  await page.getByLabel('How many').fill('2');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('status')).toContainText('your request is on its way');
  const sent = backend.calls.find((c) => c.path === 'guest/requests' && c.method === 'POST');
  expect(sent).toMatchObject({
    body: { serviceCode: 'EXTRA_TOWELS', fields: { quantity: 2 } },
    lang: 'en',
  });
  await expect(
    page.getByTestId('attribution').getByRole('link', { name: 'Powered by Planova' }),
  ).toHaveAttribute('href', 'https://planova.com.eg');
});

test('the guest app in Arabic is right-to-left and fully translated', async ({ page }) => {
  const backend = await mockBackend(page, { signedIn: true, locale: 'ar' });
  // Browser-side errors are part of the failure report (a page that fails to render shows only its static shell).
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto('/ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { name: 'أهلًا منى' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'التدبير الفندقي' })).toBeVisible();
  await expect(page.getByRole('link', { name: /مناشف إضافية/ })).toBeVisible();
  expect(backend.calls.find((c) => c.path === 'guest/services')?.lang).toBe('ar');

  await page.getByRole('link', { name: 'طلباتي' }).click();
  await expect(page.getByRole('heading', { name: 'طلباتي' })).toBeVisible();
  const row = page.locator('[data-request="EXTRA_TOWELS"]');
  await expect(row.getByText('في الطريق إليك')).toBeVisible();
  // Mirrored: the service name sits on the start side (right in Arabic), its status after it (to the left).
  const name = await row.getByText('مناشف إضافية').boundingBox();
  const badge = await row.getByText('في الطريق إليك').boundingBox();
  expect(name!.x).toBeGreaterThan(badge!.x);
  await page.locator('[data-request="WIFI_HELP"]').getByRole('button', { name: 'إلغاء' }).click();
  await expect
    .poll(() => backend.calls.some((c) => c.path === 'guest/requests/r2/cancel'))
    .toBe(true);

  const thread = page.waitForResponse((r) => r.url().endsWith('/hotella/guest/conversation'));
  await page.goto('/ar/chat');
  await expect(page.getByRole('heading', { name: 'تحدّث مع الفندق' })).toBeVisible();
  await thread;
  // Polled as a value so a failure reports what the thread shows and any browser error raised while rendering it.
  await expect
    .poll(
      async () => ({
        thread: await page
          .locator('main ol')
          .innerText({ timeout: 1_000 })
          .catch(() => '<no thread>'),
        errors: [...errors],
      }),
      { timeout: 10_000 },
    )
    .toMatchObject({ thread: expect.stringContaining('نعمل على طلبك: مشكلة في التكييف.') });
  await expect(page.getByText('نعمل على طلبك: مشكلة في التكييف.')).toHaveAttribute(
    'data-sender',
    'SYSTEM',
  );
  await expect(page.getByTestId('attribution')).toContainText('Powered by Planova');
});

test('room QR asks for the last name first; a used link explains itself; without a session the home page says what to do', async ({
  page,
}) => {
  const backend = await mockBackend(page, { signedIn: false, locale: 'en' });
  await page.goto(`/en/q/${QR}`);
  await expect(page.getByText('Room 504')).toBeVisible();
  await page.getByLabel('Your last name, as on the booking').fill('Delta');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Your mobile number').fill('+201001112233');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page.getByLabel('Code')).toBeVisible();
  expect(backend.calls.find((c) => c.path === 'guest/activation/otp/request')?.body).toEqual({
    qrToken: QR,
    lastName: 'Delta',
    phone: '+201001112233',
  });

  await page.goto('/en/a/used-token-0123456789abcdef');
  await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
  await page.goto('/en');
  await expect(page.getByRole('heading', { name: 'Open your welcome link' })).toBeVisible();
});

test.describe('an Arabic browser', () => {
  test.use({ locale: 'ar-EG' });

  test('links without a language follow the browser; the proxy serves only guest routes and never mints sessions', async ({
    page,
    request,
  }) => {
    await mockBackend(page, { signedIn: false });
    await page.goto(`/a/${TOKEN}`);
    await expect(page).toHaveURL(new RegExp(`/ar/a/${TOKEN}$`));
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    expect((await request.get('/hotella/properties')).status()).toBe(404);
    expect(
      (await request.post('/hotella/guest/activation/otp/verify', { data: {} })).status(),
    ).toBe(404);
    expect((await request.post('/hotella/guest/activation/complete', { data: {} })).status()).toBe(
      404,
    );
    const manifest = await request.get('/ar/manifest.webmanifest');
    expect(await manifest.json()).toMatchObject({ lang: 'ar', dir: 'rtl', name: 'خدمات النزلاء' });
  });
});
