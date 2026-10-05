import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const TENANT = 't1';
const MANAGER = [
  'iam.user.read',
  'iam.user.manage',
  'iam.membership.manage',
  'catalog.read',
  'catalog.manage',
  'catalog.publish',
];

/** The hotel's general manager (tenant-wide membership); users, roles and the catalog served from memory. */
async function mockBackend(page: Page, permissions: string[] = MANAGER) {
  const acted: Array<{ method: string; path: string; body: unknown }> = [];
  const users: Array<{
    id: string;
    email: string;
    status: string;
    mfaEnabled: boolean;
    lastLoginAt: string | null;
    givenName: string;
    familyName: string | null;
    localePref: string;
  }> = [
    {
      id: 'u1',
      email: 'gm@seabeachedge.example',
      status: 'ACTIVE',
      mfaEnabled: true,
      lastLoginAt: '2026-10-06T07:00:00Z',
      givenName: 'Mona',
      familyName: 'Adel',
      localePref: 'ar',
    },
    {
      id: 'u2',
      email: 'hk@seabeachedge.example',
      status: 'ACTIVE',
      mfaEnabled: false,
      lastLoginAt: null,
      givenName: 'Omar',
      familyName: 'Saleh',
      localePref: 'ar',
    },
  ];
  const memberships: Record<string, unknown[]> = {
    u2: [
      {
        id: 'm2',
        propertyId: PROPERTY,
        status: 'ACTIVE',
        roles: [{ id: 'r-hk', code: 'HK_SUPERVISOR', name: 'Housekeeping supervisor' }],
      },
    ],
  };
  const services = [
    {
      id: 's1',
      propertyId: PROPERTY,
      code: 'EXTRA_TOWELS',
      categoryId: 'c1',
      status: 'ACTIVE',
      version: 1,
      published: {
        id: 'v1',
        versionNo: 1,
        status: 'PUBLISHED',
        departmentCode: 'HK',
        priority: 'NORMAL',
        guestVisible: true,
        version: 1,
        translations: [
          { locale: 'en', name: 'Extra towels' },
          { locale: 'ar', name: 'مناشف إضافية' },
        ],
      },
      draft: null as unknown,
    },
  ];
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = r.request().method();
    const body = method === 'GET' ? null : (r.request().postDataJSON() as unknown);
    if (method !== 'GET') acted.push({ method, path, body });
    const base = `/tenants/${TENANT}`;
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: TENANT },
          memberships: [{ propertyId: null, permissions }],
        },
      });
    if (path === '/me/entitlements') return r.fulfill({ json: { unrestricted: true, codes: [] } });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Sea Beach Edge' }] });
    if (path === `${base}/roles`)
      return r.fulfill({
        json: [
          { id: 'r-gm', code: 'GENERAL_MANAGER', name: 'General manager', description: null },
          { id: 'r-hk', code: 'HK_SUPERVISOR', name: 'Housekeeping supervisor', description: null },
          { id: 'r-ra', code: 'ROOM_ATTENDANT', name: 'Room attendant', description: null },
        ],
      });
    if (path === `${base}/users` && method === 'GET') return r.fulfill({ json: users });
    if (path === `${base}/users` && method === 'POST') {
      const b = body as { email: string; givenName: string };
      const user = {
        id: 'u3',
        email: b.email,
        status: 'INVITED',
        mfaEnabled: false,
        lastLoginAt: null,
        givenName: b.givenName,
        familyName: null,
        localePref: 'en',
      };
      users.push(user);
      return r.fulfill({
        status: 201,
        json: {
          user,
          memberships: [],
          invitation: {
            token: 'inv_secret123',
            expiresAt: '2026-10-09T10:00:00Z',
            tenantCode: 'SEA_BEACH_EDGE',
          },
        },
      });
    }
    const user = path.match(new RegExp(`^${base}/users/(u\\d)$`));
    if (user)
      return r.fulfill({
        json: { ...users.find((u) => u.id === user[1]), memberships: memberships[user[1]!] ?? [] },
      });
    if (path === `${base}/memberships/m2/roles`) {
      memberships.u2 = [
        {
          id: 'm2',
          propertyId: PROPERTY,
          status: 'ACTIVE',
          roles: (body as { roleCodes: string[] }).roleCodes.map((c) => ({
            id: c,
            code: c,
            name: c,
          })),
        },
      ];
      return r.fulfill({ json: memberships.u2[0] });
    }
    if (path === `${base}/users/u2/status`) {
      users[1]!.status = (body as { status: string }).status;
      return r.fulfill({ json: users[1] });
    }
    if (path === '/catalog/services' && method === 'GET') return r.fulfill({ json: services });
    if (path === '/catalog/categories')
      return r.fulfill({
        json: [
          {
            id: 'c1',
            code: 'HOUSEKEEPING',
            translations: [
              { locale: 'en', name: 'Housekeeping' },
              { locale: 'ar', name: 'التدبير الفندقي' },
            ],
          },
        ],
      });
    if (path === `/properties/${PROPERTY}/departments`)
      return r.fulfill({
        json: [
          { id: 'd1', code: 'HK', name: 'التدبير الفندقي' },
          { id: 'd2', code: 'ENG', name: 'الصيانة' },
        ],
      });
    if (path === `/properties/${PROPERTY}/catalog/starter`)
      return r.fulfill({
        json: { created: ['AC_PROBLEM', 'LATE_CHECKOUT_REQUEST'], skipped: ['EXTRA_TOWELS'] },
      });
    if (path === '/catalog/services/s1/drafts') {
      services[0]!.draft = {
        ...services[0]!.published,
        id: 'v2',
        versionNo: 2,
        status: 'DRAFT',
        version: 1,
      };
      return r.fulfill({ status: 201, json: services[0]!.draft });
    }
    if (path === '/catalog/versions/v2') return r.fulfill({ json: services[0]!.draft });
    if (path === '/catalog/versions/v2/publish') {
      services[0]!.published = { ...(services[0]!.draft as object), status: 'PUBLISHED' } as never;
      services[0]!.draft = null;
      return r.fulfill({ json: services[0]!.published });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { acted };
}

test('a manager invites a person, gets the link once, and changes a role (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto('/en/staff');
  await expect(page.getByRole('heading', { name: 'Staff and roles' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '2 people' })).toBeVisible();

  const invite = page.getByRole('form', { name: 'Invite a person' });
  await invite.getByLabel('E-mail').fill('ra@seabeachedge.example');
  await invite.getByLabel('First name').fill('Sara');
  await invite.getByLabel('Role').selectOption('ROOM_ATTENDANT');
  await invite.getByLabel('Where').selectOption(PROPERTY);
  await invite.getByRole('button', { name: 'Create invitation' }).click();
  const link = page.getByRole('textbox', { name: 'Invitation link' });
  await expect(link).toHaveValue(/\/en\/invite#token=inv_secret123&hotel=SEA_BEACH_EDGE$/);
  await expect(page.getByRole('heading', { name: 'Invitation link for Sara' })).toBeVisible();
  expect(backend.acted[0]).toEqual({
    method: 'POST',
    path: `/tenants/${TENANT}/users`,
    body: {
      email: 'ra@seabeachedge.example',
      givenName: 'Sara',
      localePref: 'en',
      memberships: [{ propertyId: PROPERTY, roleCodes: ['ROOM_ATTENDANT'] }],
    },
  });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(link).toHaveCount(0);

  await page.locator('[data-user="hk@seabeachedge.example"]').click();
  const panel = page.getByRole('region', { name: 'Omar Saleh' });
  await panel.getByRole('checkbox', { name: 'Room attendant' }).check();
  await panel.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  expect(backend.acted.at(-1)).toEqual({
    method: 'PUT',
    path: `/tenants/${TENANT}/memberships/m2/roles`,
    body: { roleCodes: ['HK_SUPERVISOR', 'ROOM_ATTENDANT'] },
  });
  // A person never changes their own access.
  await page.locator('[data-user="gm@seabeachedge.example"]').click();
  await expect(page.getByRole('region', { name: 'Mona Adel' }).getByRole('button')).toHaveCount(0);
});

test('services: starter import, a draft edited and published, in Arabic (right-to-left)', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto('/ar/services');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'خدمات النزلاء' })).toBeVisible();
  await page.getByRole('button', { name: 'إضافة الخدمات الأساسية' }).click();
  await expect(page.getByRole('status')).toContainText('أُضيفت خدمتان');

  await page.locator('[data-service="EXTRA_TOWELS"]').click();
  const editor = page.getByRole('region', { name: 'مناشف إضافية' });
  await expect(editor).toContainText('منشورة الإصدار 1');
  await editor.getByRole('button', { name: 'بدء مسودة' }).click();
  await expect(editor).toContainText('مسودة الإصدار 2');
  await editor.getByLabel('الأولوية').selectOption('HIGH');
  await editor.getByLabel('الاسم (Deutsch)').fill('Zusätzliche Handtücher');
  await editor.getByRole('button', { name: 'حفظ المسودة' }).click();
  await expect(page.getByRole('status')).toHaveText('تم الحفظ.');
  const saved = backend.acted.find((a) => a.path === '/catalog/versions/v2')!.body as {
    priority: string;
    translations: Array<{ locale: string; name: string }>;
  };
  expect(saved.priority).toBe('HIGH');
  expect(saved.translations.map((x) => [x.locale, x.name])).toEqual([
    ['en', 'Extra towels'],
    ['ar', 'مناشف إضافية'],
    ['de', 'Zusätzliche Handtücher'],
  ]);
  await editor.getByRole('button', { name: 'نشر' }).click();
  await expect(page.getByRole('status')).toContainText('تم النشر');
  await expect(page.getByRole('link', { name: 'الخدمات' })).toHaveAttribute('aria-current', 'page');
});

test('without the rights, the sections are not offered', async ({ page }) => {
  await mockBackend(page, ['catalog.read', 'iam.user.read']);
  await page.goto('/en/staff');
  await expect(page.getByRole('link', { name: 'Staff' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Services' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Invite a person' })).toHaveCount(0);
});

test('an invitee sets a password from the link and is sent to sign in with the hotel code', async ({
  page,
}) => {
  let accepted: unknown = null;
  await page.route('**/bff/refresh', (r) => r.fulfill({ status: 401, json: {} }));
  await page.route('**/hotella/auth/invitations/accept', async (r) => {
    accepted = r.request().postDataJSON();
    await r.fulfill({ json: { userId: 'u3' } });
  });
  await page.goto('/en/invite#token=inv_secret123&hotel=SEA_BEACH_EDGE');
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  // The token leaves the address bar once read.
  await expect.poll(() => page.url()).not.toContain('inv_secret123');
  await page.getByLabel('New password').fill('a long pass phrase 2026');
  await page.getByLabel('Repeat the password').fill('a different one');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText('The two passwords are not the same.')).toBeVisible();
  await page.getByLabel('Repeat the password').fill('a long pass phrase 2026');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByTestId('hotel-code')).toHaveText('SEA_BEACH_EDGE');
  expect(accepted).toEqual({ token: 'inv_secret123', password: 'a long pass phrase 2026' });
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Hotel code')).toHaveValue('SEA_BEACH_EDGE');
});
