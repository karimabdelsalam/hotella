import { expect, type Page, test } from '@playwright/test';

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const PLAN = '01900000-0000-7000-8000-0000000000b1';
const DRAFT = '01900000-0000-7000-8000-0000000000b2';
const PUBLISHED = '01900000-0000-7000-8000-0000000000b3';
const PROPERTY = '01900000-0000-7000-8000-0000000000c1';
const FIAS = '01900000-0000-7000-8000-0000000000c2';

/** Mocks the control-plane API for a platform administrator (or a hotel manager when `admin` is false). */
async function mockBackend(page: Page, admin = true) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let subscribed = false;
  let hidden = false;
  let draftItems: string[] = ['CORE'];
  let rollback: string | null = null;
  let verified = false;
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = req.method();
    const body = (await req.headerValue('content-type'))?.includes('json')
      ? req.postDataJSON()
      : null;
    calls.push({ method, path, body });
    const ar = ((await req.headerValue('accept-language')) ?? 'en').startsWith('ar');
    const base = `/control/tenants/${TENANT}`;
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: admin ? null : 't1', isPlatformAdmin: admin },
          memberships: admin ? [] : [{ propertyId: null, permissions: ['branding.manage'] }],
        },
      });
    if (path === '/me/entitlements')
      return r.fulfill({ json: { propertyId: null, unrestricted: admin, codes: ['CORE'] } });
    if (path === '/tenants')
      return r.fulfill({ json: [{ id: TENANT, code: 'NILE', name: 'Nile Hotels' }] });
    if (path === '/control/subscriptions')
      return r.fulfill({
        json: subscribed
          ? [{ tenantId: TENANT, status: 'ACTIVE', plan: { code: 'PRO', versionNo: 1 } }]
          : [],
      });
    if (path === '/control/license/catalog')
      return r.fulfill({
        json: {
          capabilities: [
            {
              code: 'CORE',
              kind: 'MODULE',
              status: 'ACTIVE',
              name: ar ? 'المنصة الأساسية' : 'Core platform',
            },
            {
              code: 'HOUSEKEEPING',
              kind: 'MODULE',
              status: 'ACTIVE',
              name: ar ? 'التدبير الفندقي' : 'Housekeeping',
            },
            {
              code: 'WHITE_LABEL',
              kind: 'ADDON',
              status: 'ACTIVE',
              name: ar ? 'العلامة البيضاء' : 'White label',
            },
          ],
          metrics: [
            {
              code: 'AI_INPUT_TOKENS',
              name: ar ? 'رموز إدخال الذكاء الاصطناعي' : 'AI input tokens',
            },
          ],
        },
      });
    if (path === '/control/license/plans' && method === 'GET')
      return r.fulfill({
        json: [
          {
            id: PLAN,
            code: 'PRO',
            translations: [
              { locale: 'en', name: 'Professional' },
              { locale: 'ar', name: 'الاحترافية' },
            ],
            versions: [
              { id: DRAFT, versionNo: 2, status: 'DRAFT' },
              { id: PUBLISHED, versionNo: 1, status: 'PUBLISHED' },
            ],
          },
        ],
      });
    if (path === '/control/license/plans' && method === 'POST')
      return r.fulfill({
        status: 201,
        json: {
          id: 'new-plan',
          code: (body as { code: string }).code,
          translations: [],
          versions: [],
        },
      });
    if (path === `/control/license/plans/${PLAN}`)
      return r.fulfill({
        json: {
          id: PLAN,
          code: 'PRO',
          translations: [
            { locale: 'en', name: 'Professional' },
            { locale: 'ar', name: 'الاحترافية' },
          ],
          versions: [
            { id: DRAFT, versionNo: 2, status: 'DRAFT', version: 3, items: draftItems },
            { id: PUBLISHED, versionNo: 1, status: 'PUBLISHED', version: 2, items: ['CORE'] },
          ],
        },
      });
    if (path === `/control/license/plans/${PLAN}/versions/${DRAFT}` && method === 'PUT') {
      draftItems = (body as { items: string[] }).items;
      return r.fulfill({ json: { id: DRAFT, items: draftItems } });
    }
    if (path === `/control/license/plans/${PLAN}/versions/${DRAFT}/publish`)
      return r.fulfill({ json: { id: DRAFT, status: 'PUBLISHED' } });
    if (path === `${base}/subscriptions` && method === 'POST') {
      subscribed = true;
      return r.fulfill({ status: 201, json: { id: 's1' } });
    }
    if (path === `${base}/subscriptions`)
      return r.fulfill({
        json: subscribed
          ? [
              {
                id: 's1',
                tenantId: TENANT,
                status: 'ACTIVE',
                scope: 'TENANT',
                version: 1,
                plan: { code: 'PRO', versionNo: 1 },
              },
            ]
          : [],
      });
    if (path === `${base}/grants` && method === 'POST')
      return r.fulfill({ status: 201, json: { id: 'g1' } });
    if (path === `${base}/grants`) return r.fulfill({ json: [] });
    if (path === `${base}/entitlements`)
      return r.fulfill({
        json: {
          entitlements: subscribed ? [{ code: 'CORE' }, { code: 'HOUSEKEEPING' }] : [],
          limits: [],
        },
      });
    if (path === `${base}/usage`)
      return r.fulfill({
        json: { rows: subscribed ? [{ metricCode: 'AI_INPUT_TOKENS', quantity: 1200 }] : [] },
      });
    if (path === `${base}/attribution` && method === 'PUT') {
      hidden = !(body as { showPoweredBy: boolean }).showPoweredBy;
      return r.fulfill({ json: { show: !hidden, whiteLabelEntitled: true } });
    }
    if (path === `${base}/attribution`)
      return r.fulfill({ json: { show: !hidden, whiteLabelEntitled: subscribed } });
    // ---- commissioning (BUILD_PLAN 10.9) ----
    const integration = `/properties/${PROPERTY}/integration`;
    if (path === '/properties' && url.searchParams.get('tenantId') === TENANT)
      return r.fulfill({ json: [{ id: PROPERTY, code: 'NILE-CAI', name: 'Nile Cairo' }] });
    if (path === `${integration}/commissioning`)
      return r.fulfill({
        json: {
          ready: false,
          checklist: [
            {
              item: 'ROLLBACK_AGREED',
              state: rollback === 'MATCH' ? 'DONE' : 'OPEN',
              reasons:
                rollback === 'MATCH'
                  ? []
                  : [{ code: 'SHEET_ROW_MISSING', subject: 'SITE_ROLLBACK' }],
            },
            {
              item: 'MAPPINGS_CONFIRMED',
              state: 'OPEN',
              reasons: [{ code: 'OPEN_EXCEPTIONS', count: 2 }],
            },
            { item: 'OWS_KNOWN', state: 'NOT_APPLICABLE', reasons: [] },
          ],
          sheet: [
            {
              requirement: 'SITE_ROLLBACK',
              scope: 'SITE',
              required: true,
              current: rollback ? { status: rollback, hotelValue: 'Front office manager' } : null,
            },
          ],
          instances: [
            {
              id: FIAS,
              connectorCode: 'OPERA5_FIAS',
              name: 'IFC8',
              health: 'HEALTHY',
              commissionedAt: null,
              unverified: verified ? [] : ['CHECKIN_EVENT'],
              lastRun: { status: 'PASSED' },
              profileGaps: [{ record: 'GI', gaps: ['GL', 'GV'] }],
            },
          ],
        },
      });
    if (path === `${integration}/commissioning/sheet/SITE_ROLLBACK` && method === 'PUT') {
      rollback = (body as { status: string }).status;
      return r.fulfill({ json: { id: 'row1', requirement: 'SITE_ROLLBACK', status: rollback } });
    }
    if (path === `${integration}/commissioning/runs` && method === 'POST')
      return r.fulfill({ json: { id: 'run1', status: 'PASSED', checks: [] } });
    if (path === `${integration}/capabilities/CHECKIN_EVENT/verify` && method === 'POST') {
      verified = true;
      return r.fulfill({ json: { verified: true } });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

test('a platform administrator licenses a tenant and hides the attribution only once entitled (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto('/en/control');
  await expect(page.getByRole('navigation').locator('a[href$="/control"]')).toBeVisible();
  await expect(page.getByText('Licences and plans only — no guest data here.')).toBeVisible();
  const tenant = page.locator('[data-tenant="NILE"]');
  await expect(tenant).toContainText('No licence');
  await tenant.click();
  await expect(
    page.getByText("No subscription: the hotel's staff cannot use the platform yet."),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide' })).toBeDisabled();

  await page.getByRole('combobox', { name: 'Plan' }).selectOption(PUBLISHED);
  await page.getByLabel('Reason for the change').fill('Signed contract');
  await page.getByRole('button', { name: 'Subscribe' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  expect(
    backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/subscriptions'))?.body,
  ).toEqual({
    planVersionId: PUBLISHED,
    reason: 'Signed contract',
  });
  await expect(tenant).toContainText('Active');
  await expect(page.locator('[data-entitlement="HOUSEKEEPING"]')).toHaveText('Housekeeping');
  await expect(page.locator('[data-usage="AI_INPUT_TOKENS"]')).toContainText('1200');

  await page.getByLabel('Reason for the change').fill('White-label add-on');
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(page.getByTestId('attribution-state')).toHaveText('Hidden (white label).');
  expect(
    backend.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/attribution'))?.body,
  ).toEqual({
    showPoweredBy: false,
    reason: 'White-label add-on',
  });
});

test('a draft plan is edited and published from the plans tab', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto('/en/control');
  await page.getByRole('tab', { name: 'Plans' }).click();
  await page.locator('[data-plan="PRO"]').click();
  await expect(
    page.getByText('Draft version 2: choose what it grants, then publish.'),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'Housekeeping' }).check();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft saved.');
  expect(backend.calls.find((c) => c.method === 'PUT')?.body).toEqual({
    version: 3,
    items: ['CORE', 'HOUSEKEEPING'],
  });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Published. This version can no longer change.',
  );
});

test('in Arabic, the control plane is right-to-left', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/ar/control');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'لوحة التحكم' })).toBeVisible();
  await expect(page.locator('[data-tenant="NILE"]')).toContainText('بدون ترخيص');
  await page.getByRole('tab', { name: 'الباقات' }).click();
  await expect(page.locator('[data-plan="PRO"]')).toContainText('الاحترافية');
});

test('an installer commissions a property: checklist, sheet, verification run and capability sign-off', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto('/en/control');
  await page.getByRole('tab', { name: 'Integrations' }).click();
  await page.locator('[data-tenant="NILE"]').click();
  await page.locator('[data-property="NILE-CAI"]').click();
  await expect(page.getByText('Not ready', { exact: true })).toBeVisible();
  const rollback = page.locator('[data-item="ROLLBACK_AGREED"]');
  await expect(rollback).toContainText('Rollback contacts and steps agreed');
  await expect(rollback).toContainText('Not stated yet: SITE_ROLLBACK');
  await expect(page.locator('[data-item="MAPPINGS_CONFIRMED"]')).toContainText(
    '2 open integration exceptions',
  );
  await expect(page.locator('[data-item="OWS_KNOWN"]')).toContainText('Not applicable');
  const fias = page.locator('[data-instance="OPERA5_FIAS"]');
  await expect(fias).toContainText('Last run: passed');
  await expect(fias).toContainText('Profile gaps: GI — GL GV');

  // The Interface Sheet: one statement, kept as history on the platform.
  const row = page.locator('[data-requirement="SITE_ROLLBACK"]');
  await row.getByRole('combobox').selectOption('MATCH');
  await row.getByPlaceholder("Hotel's value").fill('Front office manager');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Statement recorded.');
  expect(backend.calls.find((c) => c.method === 'PUT')?.body).toEqual({
    status: 'MATCH',
    hotelValue: 'Front office manager',
  });
  await expect(rollback).toContainText('Done');

  // A verification run, then a capability verified with evidence (disabled without it).
  await page.getByPlaceholder('Test confirmation number (optional)').fill('771234');
  await fias.getByRole('button', { name: 'Run verification' }).click();
  await expect(page.getByRole('status')).toHaveText('Verification run recorded.');
  expect(
    backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/commissioning/runs'))?.body,
  ).toEqual({ instanceId: FIAS, sample: { confirmationNumber: '771234' } });
  const verify = fias.locator('[data-verify="CHECKIN_EVENT"]');
  await expect(verify).toBeDisabled();
  await page.getByLabel('Evidence reference').fill('COMM-12 check-in seen in OPERA');
  await verify.click();
  await expect(page.getByRole('status')).toHaveText('Capability verified.');
  expect(
    backend.calls.find((c) => c.path.endsWith('/capabilities/CHECKIN_EVENT/verify'))?.body,
  ).toEqual({ instanceId: FIAS, evidenceRef: 'COMM-12 check-in seen in OPERA' });
  await expect(fias).toContainText('All capabilities verified');
});

test('in Arabic, commissioning reads right-to-left with Arabic plurals', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/ar/control');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('tab', { name: 'التكاملات' }).click();
  await page.locator('[data-tenant="NILE"]').click();
  await page.locator('[data-property="NILE-CAI"]').click();
  await expect(page.getByText('غير جاهز', { exact: true })).toBeVisible();
  await expect(page.locator('[data-item="MAPPINGS_CONFIRMED"]')).toContainText('استثناءان مفتوحان');
  await expect(page.locator('[data-requirement="SITE_ROLLBACK"]')).toContainText(
    'الاتفاق على جهات الاتصال وخطوات التراجع',
  );
});

test('hotel staff never see the control plane', async ({ page }) => {
  await mockBackend(page, false);
  await page.goto('/en/control');
  await expect(
    page.getByText("Only Planova's platform administrators can open the control plane."),
  ).toBeVisible();
  await expect(page.getByRole('navigation').locator('a[href$="/control"]')).toHaveCount(0);
});
