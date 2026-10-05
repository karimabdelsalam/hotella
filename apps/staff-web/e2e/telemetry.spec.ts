import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const POINT = '01900000-0000-7000-8000-0000000000b1';
const IGNORED = '01900000-0000-7000-8000-0000000000b2';
const RULE = '01900000-0000-7000-8000-0000000000c1';
const ALARM = '01900000-0000-7000-8000-0000000000d1';

async function mockBackend(page: Page, permissions: string[]) {
  const acted: Array<{ path: string; body: unknown }> = [];
  let status: 'OPEN' | 'ACKNOWLEDGED' = 'OPEN';
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const base = `/properties/${PROPERTY}/eng/telemetry`;
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [{ propertyId: PROPERTY, permissions }],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === `${base}/points`)
      return r.fulfill({
        json: [
          {
            id: POINT,
            externalCode: 'CH-1.SUPPLY_T',
            name: 'Chilled water supply',
            assetId: 'a1',
            locationId: null,
            quantity: 'TEMPERATURE',
            unit: '°C',
            status: 'ACTIVE',
            lastValue: 9.5,
            lastAt: new Date(Date.now() - 60_000).toISOString(),
            version: 1,
          },
          {
            id: IGNORED,
            externalCode: 'AHU-2.RH',
            name: null,
            assetId: null,
            locationId: 'l1',
            quantity: 'HUMIDITY',
            unit: '%',
            status: 'IGNORED',
            lastValue: null,
            lastAt: null,
            version: 2,
          },
        ],
      });
    if (path === `${base}/rules`)
      return r.fulfill({
        json: [
          {
            id: RULE,
            pointId: POINT,
            kind: 'THRESHOLD',
            severity: 'CRITICAL',
            action: 'WORK_ORDER',
            status: 'ACTIVE',
          },
        ],
      });
    if (path === `${base}/alarms`)
      return r.fulfill({
        json: [
          {
            id: ALARM,
            pointId: POINT,
            ruleId: RULE,
            status,
            raisedAt: new Date(Date.now() - 600_000).toISOString(),
            value: 9.5,
            peak: 10.25,
            workOrderId: 'w1',
            version: status === 'OPEN' ? 2 : 3,
          },
        ],
      });
    if (path === `${base}/alarms/${ALARM}/acknowledge`) {
      acted.push({ path, body: r.request().postDataJSON() });
      status = 'ACKNOWLEDGED';
      return r.fulfill({ json: {} });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { acted };
}

test('engineering sees the live alarm with its reading and acknowledges it; sensors list their latest values (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, [
    'eng.telemetry.read',
    'eng.telemetry.acknowledge',
    'eng.work_order.read',
  ]);
  await page.goto('/en/telemetry');
  await expect(page.getByRole('heading', { name: 'Building telemetry' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Telemetry' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const alarm = page.locator(`[data-alarm="${ALARM}"]`);
  await expect(alarm).toHaveAttribute('data-severity', 'CRITICAL');
  await expect(alarm).toContainText('Chilled water supply');
  await expect(alarm).toContainText('Beyond its limit · Temperature');
  await expect(alarm).toContainText('9.5 °C');
  await expect(alarm).toContainText('Peak 10.25 °C');
  await expect(alarm).toContainText('Work order opened');
  await alarm.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(alarm).toContainText('Acknowledged');
  await expect(alarm.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  expect(backend.acted).toEqual([
    {
      path: `/properties/${PROPERTY}/eng/telemetry/alarms/${ALARM}/acknowledge`,
      body: { version: 2 },
    },
  ]);
  const sensors = page.getByRole('table');
  await expect(sensors.locator('[data-point="CH-1.SUPPLY_T"]')).toContainText('9.5 °C');
  await expect(sensors.locator('[data-point="AHU-2.RH"]')).toContainText('Ignored');
  await expect(sensors.locator('[data-point="AHU-2.RH"]')).toContainText('No reading yet');
});

test('without the acknowledge permission there is no button; Arabic is right-to-left with the bar on the start side', async ({
  page,
}) => {
  await mockBackend(page, ['eng.telemetry.read', 'eng.work_order.read']);
  await page.goto('/ar/telemetry');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'حساسات المبنى' })).toBeVisible();
  const alarm = page.locator(`[data-alarm="${ALARM}"]`);
  await expect(alarm).toContainText('تجاوز الحد المسموح · درجة الحرارة');
  await expect(alarm).toContainText('حرج');
  await expect(alarm.getByRole('button')).toHaveCount(0);
  const box = await alarm.boundingBox();
  const bar = await alarm.locator('span[aria-hidden]').first().boundingBox();
  // In RTL the start side is the right.
  expect(bar!.x + bar!.width).toBeGreaterThan(box!.x + box!.width - 2);
  // Readings stay left-to-right inside the Arabic page.
  await expect(alarm.locator('p[dir="ltr"]')).toHaveText('9.5 °C');
});
