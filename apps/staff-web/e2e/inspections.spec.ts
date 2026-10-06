import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const TEMPLATE = '01900000-0000-7000-8000-0000000000c1';
const ROOM = '01900000-0000-7000-8000-0000000000e1';
/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const item = (code: string, en: string, ar: string, rule: object, optionLabels = {}) => ({
  code,
  en,
  ar,
  rule: { required: true, failSeverity: 'MINOR', ...rule },
  optionLabels,
});
const ITEMS = [
  item('EXTINGUISHER', 'Extinguisher charged', 'طفاية الحريق مشحونة', {
    kind: 'PASS_FAIL',
    failSeverity: 'CRITICAL',
  }),
  item('SIGNAGE', 'Exit signs lit', 'علامات الخروج مضاءة', { kind: 'YES_NO' }),
  item('CHLORINE', 'Chlorine (ppm)', 'الكلور (جزء في المليون)', { kind: 'NUMBER', min: 1, max: 3 }),
  item(
    'SURFACES',
    'Surfaces',
    'الأسطح',
    { kind: 'MULTI_SELECT', options: ['OK', 'MOULD'] },
    { OK: 'Clean', MOULD: 'Mould' },
  ),
  item('PANEL', 'Photo of the panel', 'صورة اللوحة', { kind: 'PHOTO', required: false }),
];

/** Mocks the API: one inspection that fills in as the inspector answers. */
async function mockBackend(page: Page, permissions: readonly string[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const answers = new Map<string, { kind: string; value: unknown }>();
  let status: 'IN_PROGRESS' | 'COMPLETED' = 'IN_PROGRESS';
  let started = false;
  const detail = (locale: string) => ({
    id: 'insp-1',
    number: 4,
    templateName: locale === 'ar' ? 'جولة السلامة' : 'Safety round',
    roomNumber: '504',
    status,
    result: status === 'COMPLETED' ? 'FAIL' : null,
    score: status === 'COMPLETED' ? 50 : null,
    startedAt: '2026-10-03T09:00:00Z',
    checklist: {
      sections: [
        {
          id: 's1',
          code: 'EQUIPMENT',
          title: locale === 'ar' ? 'المعدات' : 'Equipment',
          items: ITEMS.map((i) => ({
            id: `i-${i.code}`,
            code: i.code,
            label: locale === 'ar' ? i.ar : i.en,
            help: null,
            optionLabels: i.optionLabels,
            rule: i.rule,
          })),
        },
      ],
    },
    answers: [...answers.entries()].map(([itemCode, answer]) => ({ itemCode, answer })),
    findings:
      status === 'COMPLETED'
        ? [{ id: 'f1', itemCode: 'EXTINGUISHER', severity: 'CRITICAL', status: 'LINKED' }]
        : [],
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
    calls.push({ method, path, body });
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
    if (path === `${base}/inspection-templates`)
      return r.fulfill({
        json: [
          {
            id: TEMPLATE,
            code: 'SAFETY',
            name: 'Safety round',
            scope: 'ROOM',
            publishedVersionNo: 1,
          },
        ],
      });
    if (path === `${base}/rooms`)
      return r.fulfill({ json: [{ locationId: ROOM, roomNumber: '504' }] });
    if (path === `${base}/inspections` && method === 'POST') {
      started = true;
      return r.fulfill({ status: 201, json: { id: 'insp-1' } });
    }
    if (path === `${base}/inspections`)
      return r.fulfill({ json: started || status === 'COMPLETED' ? [detail(locale)] : [] });
    if (path === `${base}/inspections/insp-1`) return r.fulfill({ json: detail(locale) });
    if (path === `${base}/inspections/insp-1/answers`) {
      const b = body as { itemCode: string; answer: { kind: string; value: unknown } };
      answers.set(b.itemCode, b.answer);
      return r.fulfill({ json: b });
    }
    if (path === `${base}/inspections/insp-1/photos`)
      return r.fulfill({
        status: 201,
        json: { key: 'inspection/t1/insp-1/01900000-0000-7000-8000-0000000000aa.png' },
      });
    if (path.startsWith(`${base}/inspections/insp-1/photos/`))
      return r.fulfill({ body: PNG, contentType: 'image/png' });
    if (path === `${base}/inspections/insp-1/complete`) {
      status = 'COMPLETED';
      return r.fulfill({ json: detail(locale) });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls, setCompleted: () => (status = 'COMPLETED') };
}

const INSPECTOR = ['inspection.read', 'inspection.perform'];

test('an inspector starts a checklist on a room, answers it on the spot and completes it (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, INSPECTOR);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/en/inspections');
  // On a phone the sections are in the menu drawer.
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await expect(page.getByRole('link', { name: 'Inspections' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: 'Close the menu' }).click();
  await page.getByRole('combobox', { name: 'Checklist' }).selectOption(TEMPLATE);
  await page.getByRole('combobox', { name: 'Room' }).selectOption(ROOM);
  await page.getByRole('button', { name: 'Start inspection' }).click();
  await expect(page.getByRole('heading', { name: '#4 · Safety round' })).toBeVisible();
  expect(backend.calls.find((c) => c.method === 'POST')?.body).toEqual({
    templateId: TEMPLATE,
    locationId: ROOM,
  });

  const extinguisher = page.locator('[data-item="EXTINGUISHER"]');
  await extinguisher.getByRole('button', { name: 'Fail' }).click();
  await expect(extinguisher.getByRole('button', { name: 'Fail' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.locator('[data-item="SIGNAGE"]').getByRole('button', { name: 'Yes' }).click();
  await page.getByLabel('Chlorine (ppm)').fill('2.5');
  await page.locator('[data-item="CHLORINE"]').getByRole('button', { name: 'Save' }).click();
  await page.locator('[data-item="SURFACES"]').getByRole('button', { name: 'Clean' }).click();
  await page
    .getByTestId('photo-PANEL')
    .setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('[data-item="PANEL"] img')).toHaveCount(1);
  const answered = backend.calls.filter((c) => c.path.endsWith('/answers')).map((c) => c.body);
  expect(answered).toEqual([
    { itemCode: 'EXTINGUISHER', answer: { kind: 'PASS_FAIL', value: 'FAIL' } },
    { itemCode: 'SIGNAGE', answer: { kind: 'YES_NO', value: 'YES' } },
    { itemCode: 'CHLORINE', answer: { kind: 'NUMBER', value: 2.5 } },
    { itemCode: 'SURFACES', answer: { kind: 'MULTI_SELECT', value: ['OK'] } },
    {
      itemCode: 'PANEL',
      answer: {
        kind: 'PHOTO',
        value: ['inspection/t1/insp-1/01900000-0000-7000-8000-0000000000aa.png'],
      },
    },
  ]);

  await page.getByRole('button', { name: 'Complete inspection' }).click();
  await expect(page.getByRole('status')).toHaveText('The inspection is complete.');
  await expect(page.getByTestId('result')).toHaveText('Failed · 50%');
  await expect(page.locator('[data-finding="EXTINGUISHER"]')).toContainText('Critical');
  await expect(page.locator('[data-finding="EXTINGUISHER"]')).toContainText('Work opened');
});

test('a completed inspection in Arabic is right-to-left and read-only for viewers', async ({
  page,
}) => {
  const backend = await mockBackend(page, ['inspection.read']);
  backend.setCompleted();
  await page.goto('/ar/inspections');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'بدء الفحص' })).toHaveCount(0);
  await page.locator('[data-inspection="4"]').click();
  await expect(page.getByRole('heading', { name: 'رقم 4 · جولة السلامة' })).toBeVisible();
  await expect(page.getByTestId('result')).toHaveText('راسب · 50%');
  await expect(
    page.locator('[data-item="EXTINGUISHER"]').getByRole('button', { name: 'غير مطابق' }),
  ).toBeDisabled();
  await expect(page.locator('[data-finding="EXTINGUISHER"]')).toContainText('حرجة');
  await expect(page.getByRole('link', { name: 'الفحص' })).toBeVisible();
});
