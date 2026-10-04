import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const ROOM = '01900000-0000-7000-8000-0000000000e1';
const DRAFTER = '01900000-0000-7000-8000-00000000aa01';
const NEXT = '01900000-0000-7000-8000-00000000aa02';

/** Mocks the API: the housekeeping evening shift, its entries and (optionally) a drafted handover. */
async function mockBackend(page: Page, userId: string, drafted: boolean) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const entries: Array<Record<string, unknown>> = [
    {
      id: 'e1',
      kind: 'NOTE',
      text: 'Linen delivery late',
      roomNumber: null,
      correctsEntryId: null,
      createdAt: '2026-10-04T13:00:00Z',
    },
  ];
  let handover: Record<string, unknown> | null = drafted
    ? {
        id: 'h1',
        departmentCode: 'HK',
        shiftDate: '2026-10-04',
        shift: 'EVENING',
        summary: 'One urgent job: leak in 504.',
        source: 'AI',
        edited: false,
        status: 'DRAFT',
        draftedById: DRAFTER,
        acknowledgedAt: null,
        version: 1,
      }
    : null;
  const facts = {
    work: { open: 3, urgent: 1, overdue: 0 },
    complaints: { open: 2, high_or_critical: 1 },
    rooms_out_of_order: [{ room: '504', kind: 'OOO' }],
    lost_found: { found_waiting: 2, lost_reports_open: 1, matches_to_decide: 0, past_retention: 0 },
    entries: {
      total: entries.length,
      incidents: entries.filter((e) => e.kind === 'INCIDENT').length,
    },
  };
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
          user: { id: userId, tenantId: 't1' },
          memberships: [
            {
              propertyId: PROPERTY,
              permissions: ['logbook.read', 'logbook.write', 'logbook.handover.acknowledge'],
            },
          ],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === `${base}/departments`)
      return r.fulfill({
        json: [
          {
            id: 'd1',
            code: 'HK',
            name: locale === 'ar' ? 'التدبير الفندقي' : 'Housekeeping',
            status: 'ACTIVE',
          },
        ],
      });
    if (path === `${base}/rooms`)
      return r.fulfill({ json: [{ locationId: ROOM, roomNumber: '504' }] });
    if (path === `${base}/logbook/shift`)
      return r.fulfill({
        json: {
          departmentCode: 'HK',
          shiftDate: '2026-10-04',
          shift: 'EVENING',
          window: { from: '2026-10-04T12:00:00Z', to: '2026-10-04T20:00:00Z' },
          facts: {
            ...facts,
            entries: {
              total: entries.length,
              incidents: entries.filter((e) => e.kind === 'INCIDENT').length,
            },
          },
          entries,
          handover,
        },
      });
    if (path === `${base}/logbook/entries`) {
      const b = body as { kind: string; text: string; roomId?: string };
      entries.push({
        id: `e${entries.length + 1}`,
        kind: b.kind,
        text: b.text,
        roomNumber: b.roomId ? '504' : null,
        correctsEntryId: null,
        createdAt: '2026-10-04T14:00:00Z',
      });
      return r.fulfill({ status: 201, json: {} });
    }
    if (path === `${base}/logbook/handovers` && method === 'POST') {
      handover = {
        id: 'h1',
        departmentCode: 'HK',
        shiftDate: '2026-10-04',
        shift: 'EVENING',
        summary: 'Incident: leak in 504. 3 open jobs, 1 urgent.',
        source: 'AI',
        edited: false,
        status: 'DRAFT',
        draftedById: userId,
        acknowledgedAt: null,
        version: 1,
      };
      return r.fulfill({ json: handover });
    }
    if (path === `${base}/logbook/handovers/h1` && method === 'PUT') {
      handover = {
        ...handover!,
        summary: (body as { summary: string }).summary,
        edited: true,
        version: 2,
      };
      return r.fulfill({ json: handover });
    }
    if (path === `${base}/logbook/handovers/h1/acknowledge`) {
      handover = {
        ...handover!,
        status: 'ACKNOWLEDGED',
        acknowledgedAt: '2026-10-04T20:05:00Z',
        version: 3,
      };
      return r.fulfill({ json: handover });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

test('the outgoing supervisor logs an incident and drafts the handover, but does not acknowledge it (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, DRAFTER, false);
  await page.goto('/en/logbook');
  await expect(page.getByRole('link', { name: 'Logbook' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('shift')).toContainText('Evening shift');
  await expect(page.locator('[data-fact="open_work"]')).toContainText('3');
  await expect(page.locator('[data-fact="out_of_order"]')).toContainText('1');

  const form = page.getByRole('form', { name: 'Add to logbook' });
  await form.getByRole('button', { name: 'Incident' }).click();
  await form.getByLabel('What happened').fill('Water leak from the ceiling');
  await form.getByRole('combobox', { name: 'Room' }).selectOption(ROOM);
  await form.getByRole('button', { name: 'Add to logbook' }).click();
  await expect(page.getByRole('status')).toHaveText('Added to the logbook.');
  await expect(page.locator('[data-entry="INCIDENT"]')).toContainText('Room 504');
  expect(backend.calls.find((c) => c.path.endsWith('/logbook/entries'))?.body).toEqual({
    departmentCode: 'HK',
    kind: 'INCIDENT',
    text: 'Water leak from the ceiling',
    roomId: ROOM,
  });

  await page.getByRole('button', { name: 'Draft the handover' }).click();
  await expect(page.getByRole('status')).toHaveText('The handover draft is ready to read.');
  await expect(page.getByRole('textbox', { name: 'Handover', exact: true })).toHaveValue(
    'Incident: leak in 504. 3 open jobs, 1 urgent.',
  );
  await expect(page.getByTestId('handover-status')).toContainText('AI draft');
  await expect(page.getByRole('button', { name: 'Acknowledge and take over' })).toHaveCount(0);
  await expect(page.getByText('The person taking the shift over acknowledges it.')).toBeVisible();
});

test('in Arabic, the incoming supervisor corrects the draft and takes the shift over, right-to-left', async ({
  page,
}) => {
  const backend = await mockBackend(page, NEXT, true);
  await page.goto('/ar/logbook');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('shift')).toContainText('وردية المساء');
  const text = page.getByRole('textbox', { name: 'التسليم', exact: true });
  await expect(text).toHaveValue('One urgent job: leak in 504.');
  await text.fill('مهمة عاجلة واحدة: تسرب مياه في 504، والغرفة خارج الخدمة.');
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByRole('status')).toHaveText('تم الحفظ.');
  await page.getByRole('button', { name: 'تأكيد واستلام الوردية' }).click();
  await expect(page.getByRole('status')).toHaveText('تم تأكيد التسليم.');
  await expect(page.getByTestId('summary')).toContainText('تسرب مياه في 504');
  await expect(page.getByTestId('handover-status')).toContainText('مؤكَّد');
  expect(backend.calls.filter((c) => c.path.includes('/handovers/h1')).map((c) => c.body)).toEqual([
    { version: 1, summary: 'مهمة عاجلة واحدة: تسرب مياه في 504، والغرفة خارج الخدمة.' },
    { version: 2 },
  ]);
  await expect(page.getByRole('link', { name: 'السجل' })).toBeVisible();
});
