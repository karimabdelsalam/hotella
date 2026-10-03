import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const FCU = '01900000-0000-7000-8000-0000000000f1';
const CHILLER = '01900000-0000-7000-8000-0000000000f2';

const code = (kind: string, c: string, en: string, ar: string) => ({
  id: `${kind}-${c}`,
  kind,
  code: c,
  active: true,
  translations: [
    { locale: 'en', name: en },
    { locale: 'ar', name: ar },
  ],
});
const CODES = [
  code('SYMPTOM', 'NOT_COOLING', 'Not cooling', 'لا يبرّد'),
  code('FAILURE_MODE', 'COMPRESSOR_NOT_STARTING', 'Compressor not starting', 'الضاغط لا يعمل'),
  code('CAUSE', 'CAPACITOR_FAILED', 'Capacitor failed', 'تلف المكثف'),
  code('RESOLUTION', 'CAPACITOR_REPLACED', 'Capacitor replaced', 'تم تغيير المكثف'),
];
const order = (n: number, extra: object = {}) => ({
  id: `wo-${n}`,
  number: n,
  type: 'CORRECTIVE',
  source: 'GUEST_REQUEST',
  status: 'OPEN',
  assetId: FCU,
  locationId: 'room-504',
  roomNumber: '504',
  assetNumber: 'FCU-504',
  assetName: 'Room 504 fan-coil',
  reportedAt: '2026-10-03T09:00:00Z',
  symptomCode: 'NOT_COOLING',
  diagnosis: null,
  failureModeCode: null,
  causeCode: null,
  resolutionCode: null,
  downtimeStartedAt: null,
  downtimeEndedAt: null,
  downtimeMinutes: null,
  codingMissing: ['FAILURE_MODE', 'CAUSE', 'RESOLUTION'],
  version: 3,
  ...extra,
});

async function mockBackend(page: Page, permissions: readonly string[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let open = [order(7)];
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = r.request().method();
    const body = method === 'GET' ? null : (r.request().postDataJSON() ?? null);
    calls.push({ method, path: `${path}${url.search}`, body });
    const base = `/properties/${PROPERTY}/eng`;
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [{ propertyId: PROPERTY, permissions }],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === '/eng/failure-codes') return r.fulfill({ json: CODES });
    if (path === `${base}/assets`)
      return r.fulfill({
        json: [
          {
            id: FCU,
            assetNumber: 'FCU-504',
            name: 'Room 504 fan-coil',
            locationId: 'room-504',
            status: 'ACTIVE',
            criticality: 'MEDIUM',
            warrantyUntil: '2027-06-30',
          },
          {
            id: CHILLER,
            assetNumber: 'CH-01',
            name: 'Chiller 1',
            locationId: 'plant',
            status: 'ACTIVE',
            criticality: 'CRITICAL',
            warrantyUntil: null,
          },
        ],
      });
    if (path === `${base}/work-orders` && url.searchParams.get('assetId'))
      return r.fulfill({
        json: [
          order(7),
          order(3, {
            status: 'DONE',
            failureModeCode: 'COMPRESSOR_NOT_STARTING',
            codingMissing: [],
          }),
        ],
      });
    if (path === `${base}/work-orders`) return r.fulfill({ json: open });
    if (path === `${base}/work-orders/wo-7/complete`) {
      open = [];
      return r.fulfill({ json: order(7, { status: 'DONE' }) });
    }
    if (path === `${base}/copilot`)
      return r.fulfill({
        json: {
          executionId: 'x1',
          outcome: 'ANSWERED',
          answer:
            'This model failed twice on its capacitor. Isolate the unit, then check the capacitor.',
          locale: 'en',
          sources: [{ documentId: 'd1', title: 'Carrier 42N service manual', versionNo: 3 }],
        },
      });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

const ENGINEER = ['eng.asset.read', 'eng.work_order.read', 'eng.work_order.manage', 'task.accept'];

test('an engineer codes and closes a work order, then asks the copilot about the unit (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, ENGINEER);
  await page.goto('/en/engineering');
  await expect(page.getByRole('heading', { name: '1 open work order' })).toBeVisible();
  const card = page.locator('[data-order="7"]');
  await expect(card).toContainText('Room 504');
  await expect(card).toContainText('FCU-504 · Room 504 fan-coil');
  await expect(card).toContainText('Not cooling');
  await expect(card).toContainText('Coding missing');
  await expect(page.getByRole('link', { name: 'Engineering' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await card.click();
  await expect(page.getByRole('heading', { name: 'Work order #7' })).toBeVisible();
  await page.getByLabel('Failure mode').selectOption('COMPRESSOR_NOT_STARTING');
  await page.getByLabel('Cause').selectOption('CAPACITOR_FAILED');
  await page.getByLabel('Resolution').selectOption('CAPACITOR_REPLACED');
  await page.getByLabel('What you found').fill('Capacitor swollen');
  await page.getByRole('button', { name: 'Close the work order' }).click();
  await expect(page.getByRole('status')).toHaveText('The work order is closed.');
  expect(backend.calls.find((c) => c.path.endsWith('/complete'))?.body).toEqual({
    symptomCode: 'NOT_COOLING',
    failureModeCode: 'COMPRESSOR_NOT_STARTING',
    causeCode: 'CAPACITOR_FAILED',
    resolutionCode: 'CAPACITOR_REPLACED',
    diagnosis: 'Capacitor swollen',
    downtimeStartedAt: null,
    downtimeEndedAt: null,
  });
  await expect(page.getByText('Nothing open right now.')).toBeVisible();

  await page.getByRole('tab', { name: 'Equipment' }).click();
  await page.locator('[data-asset="FCU-504"]').click();
  await expect(page.locator('[data-history="3"]')).toContainText('Compressor not starting');
  await page.getByLabel('Your question').fill('Why does this unit keep stopping?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  const answer = page.getByTestId('copilot-answer');
  await expect(answer).toContainText('AI suggestion — check it before you act');
  await expect(answer).toContainText('failed twice on its capacitor');
  await expect(answer).toContainText('Carrier 42N service manual (v3)');
  expect(backend.calls.find((c) => c.path.endsWith('/copilot'))?.body).toEqual({
    question: 'Why does this unit keep stopping?',
    assetId: FCU,
  });
});

test('the engineering screen in Arabic is right-to-left; read-only staff see no close-out', async ({
  page,
}) => {
  await mockBackend(page, ['eng.work_order.read']);
  await page.goto('/ar/engineering');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'أمر عمل مفتوح واحد' })).toBeVisible();
  await expect(page.locator('[data-order="7"]')).toContainText('لا يبرّد');
  await page.locator('[data-order="7"]').click();
  await expect(page.getByRole('heading', { name: 'أمر العمل رقم 7' })).toBeVisible();
  await expect(page.getByLabel('نمط العطل')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'إغلاق أمر العمل' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'اسأل المساعد' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'الصيانة' })).toBeVisible();
  // Sections follow permissions: no inbox or housekeeping for this person.
  await expect(page.getByRole('link', { name: 'صندوق الرسائل' })).toHaveCount(0);
});
