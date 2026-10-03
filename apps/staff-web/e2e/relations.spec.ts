import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const NOISE = '01900000-0000-7000-8000-0000000000d1';
const CLEAN = '01900000-0000-7000-8000-0000000000d2';
const ROOM = '01900000-0000-7000-8000-0000000000e1';

type Status = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
interface Recovery {
  id: string;
  kind: string;
  amountMinor: number | null;
  currency: string | null;
  note: string | null;
  status: 'DONE' | 'PENDING_APPROVAL' | 'REJECTED';
}

/** Mocks the API: one AI suggestion that becomes complaint #7 when confirmed. */
async function mockBackend(page: Page, permissions: readonly string[], confirmed = false) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let candidate = !confirmed;
  let status: Status = 'OPEN';
  let version = 1;
  const recovery: Recovery[] = [];
  const notes: string[] = [];
  const names = (locale: string) =>
    locale === 'ar'
      ? { NOISE: 'الضوضاء', CLEANLINESS: 'النظافة' }
      : { NOISE: 'Noise', CLEANLINESS: 'Cleanliness' };
  const complaint = (locale: string) => ({
    id: 'c-7',
    number: 7,
    categoryName: names(locale).CLEANLINESS,
    severity: 'HIGH',
    status,
    source: 'AI_CANDIDATE',
    summary: 'Room not cleaned for two days',
    description: null,
    openedAt: '2026-10-03T09:00:00Z',
    roomNumber: '504',
    stayId: 's1',
    version,
    evidence: [
      {
        id: 'e1',
        kind: 'MESSAGE',
        text: 'الأوضة متنضفتش من يومين',
        createdAt: '2026-10-03T09:00:00Z',
      },
      {
        id: 'e2',
        kind: 'AI_REASON',
        text: 'Angry about cleaning (92%)',
        createdAt: '2026-10-03T09:00:00Z',
      },
      ...notes.map((text, i) => ({
        id: `n${i}`,
        kind: 'NOTE',
        text,
        createdAt: '2026-10-03T09:10:00Z',
      })),
    ],
    history: [
      {
        id: 'h1',
        fromStatus: null,
        toStatus: 'OPEN',
        note: null,
        createdAt: '2026-10-03T09:00:00Z',
      },
    ],
    recovery,
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
    calls.push({ method, path: path + url.search, body });
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
    if (path === '/relations/categories')
      return r.fulfill({
        json: [
          {
            id: NOISE,
            code: 'NOISE',
            name: names(locale).NOISE,
            defaultSeverity: 'MEDIUM',
            active: true,
          },
          {
            id: CLEAN,
            code: 'CLEANLINESS',
            name: names(locale).CLEANLINESS,
            defaultSeverity: 'MEDIUM',
            active: true,
          },
        ],
      });
    if (path === `${base}/rooms`)
      return r.fulfill({ json: [{ locationId: ROOM, roomNumber: '504' }] });
    if (path === `${base}/complaint-candidates`)
      return r.fulfill({
        json: candidate
          ? [
              {
                id: 'cand-1',
                categoryName: names(locale).CLEANLINESS,
                severity: 'HIGH',
                confidence: 0.92,
                summary: 'Room not cleaned for two days',
                reason: 'Guest is angry the room was not cleaned',
                guestWords: 'الأوضة متنضفتش من يومين',
                createdAt: '2026-10-03T09:00:00Z',
                version: 1,
              },
            ]
          : [],
      });
    if (path === `${base}/complaint-candidates/cand-1/confirm`) {
      candidate = false;
      return r.fulfill({ status: 201, json: { complaint: { id: 'c-7' } } });
    }
    if (path === `${base}/complaints` && method === 'GET')
      return r.fulfill({ json: candidate ? [] : [complaint(locale)] });
    if (path === `${base}/complaints/c-7`) return r.fulfill({ json: complaint(locale) });
    if (path === `${base}/complaints/c-7/status`) {
      status = (body as { to: Status }).to;
      version++;
      return r.fulfill({ json: complaint(locale) });
    }
    if (path === `${base}/complaints/c-7/notes`) {
      notes.push((body as { text: string }).text);
      return r.fulfill({ status: 201, json: {} });
    }
    if (path === `${base}/complaints/c-7/recovery`) {
      const b = body as { kind: string; amountMinor?: number; note?: string };
      recovery.push({
        id: `r${recovery.length}`,
        kind: b.kind,
        amountMinor: b.amountMinor ?? null,
        currency: b.amountMinor ? 'EGP' : null,
        note: b.note ?? null,
        status: b.amountMinor ? 'PENDING_APPROVAL' : 'DONE',
      });
      return r.fulfill({ status: 201, json: recovery.at(-1) });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

const GUEST_RELATIONS = ['complaint.read', 'complaint.manage', 'complaint.recovery.manage'];

test('guest relations confirms the concierge’s suggestion, handles it and offers recovery (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, GUEST_RELATIONS);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/en/relations');
  await expect(page.getByRole('link', { name: 'Guest relations' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('heading', { name: '1 suggestion from the concierge' }),
  ).toBeVisible();
  const suggestion = page.locator('[data-candidate="cand-1"]');
  await expect(suggestion).toContainText('92% sure');
  await expect(suggestion).toContainText('الأوضة متنضفتش من يومين');
  await suggestion.getByRole('button', { name: 'Confirm complaint' }).click();
  await expect(page.getByRole('status')).toHaveText('The complaint was opened.');
  await expect(page.getByRole('heading', { name: '#7 · Cleanliness' })).toBeVisible();
  await expect(page.locator('[data-evidence="MESSAGE"]')).toContainText('Guest’s words');
  await expect(page.locator('[data-evidence="AI_REASON"]')).toContainText('AI reason');
  expect(backend.calls.find((c) => c.path.endsWith('/confirm'))?.body).toEqual({ version: 1 });

  await page.getByRole('button', { name: 'Start handling' }).click();
  await expect(page.getByTestId('status')).toContainText('In progress');
  await page.getByLabel('Add a note…').fill('Housekeeping sent at once.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('[data-evidence="NOTE"]')).toContainText('Housekeeping sent at once.');

  const form = page.getByRole('form', { name: 'Add recovery' });
  await form.getByRole('button', { name: 'Add recovery' }).click();
  await expect(page.locator('[data-recovery="APOLOGY"]')).toContainText('Done');
  await form.getByRole('combobox', { name: 'Gesture' }).selectOption('DISCOUNT');
  await expect(form).toContainText('waits for a manager’s approval');
  await form.getByLabel('Amount').fill('250');
  await form.getByLabel('Note').fill('One night 10%');
  await form.getByRole('button', { name: 'Add recovery' }).click();
  await expect(page.getByRole('status')).toHaveText('Sent for approval.');
  await expect(page.locator('[data-recovery="DISCOUNT"]')).toContainText('Waiting for approval');
  expect(backend.calls.filter((c) => c.path.endsWith('/recovery')).map((c) => c.body)).toEqual([
    { kind: 'APOLOGY' },
    { kind: 'DISCOUNT', amountMinor: 25_000, note: 'One night 10%' },
  ]);
  expect(backend.calls.find((c) => c.path.endsWith('/status'))?.body).toEqual({
    to: 'IN_PROGRESS',
    version: 1,
  });
});

test('a complaint in Arabic is right-to-left and read-only for viewers', async ({ page }) => {
  await mockBackend(page, ['complaint.read'], true);
  await page.goto('/ar/relations');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('form', { name: 'تسجيل شكوى' })).toHaveCount(0);
  await page.locator('[data-complaint="7"]').click();
  await expect(page.getByRole('heading', { name: 'رقم 7 · النظافة' })).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('مفتوحة');
  await expect(page.locator('[data-evidence="MESSAGE"]')).toContainText('كلام النزيل');
  await expect(page.getByRole('button', { name: 'بدء المعالجة' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'إضافة ترضية' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'علاقات النزلاء' })).toBeVisible();
});
