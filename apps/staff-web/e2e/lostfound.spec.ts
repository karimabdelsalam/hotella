import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const ROOM = '01900000-0000-7000-8000-0000000000e1';

const item = (over: Record<string, unknown>) => ({
  id: 'f-1',
  number: 1,
  kind: 'FOUND',
  category: 'PHONE',
  colour: 'BLACK',
  brand: 'Samsung',
  description: 'Black Samsung phone under the bed',
  roomNumber: '504',
  placeNote: null,
  occurredAt: '2026-10-03T09:00:00Z',
  storageLocation: 'Front office safe',
  photoKeys: [],
  valuable: true,
  status: 'REGISTERED',
  retentionUntil: '2027-01-01',
  retentionDue: false,
  version: 1,
  ...over,
});

/** Mocks the API: a found phone (#1) that matches a guest's lost report (#2); an old umbrella (#3) past retention. */
async function mockBackend(page: Page, permissions: readonly string[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let found = item({});
  let lost = item({
    id: 'l-1',
    number: 2,
    kind: 'LOST',
    description: 'Guest lost a black Samsung',
    storageLocation: null,
    retentionUntil: null,
  });
  let umbrella = item({
    id: 'u-1',
    number: 3,
    category: 'OTHER',
    colour: 'BLUE',
    brand: null,
    description: 'Blue umbrella in the lobby',
    roomNumber: null,
    placeNote: 'Lobby',
    valuable: false,
    retentionUntil: '2026-09-01',
    retentionDue: true,
  });
  let matched = false;
  let released = false;
  const detail = (i: ReturnType<typeof item>) => ({
    ...i,
    ai: null,
    matches:
      i.id === 'u-1'
        ? []
        : [
            {
              id: 'm-1',
              score: 100,
              reasons: ['CATEGORY', 'COLOUR', 'BRAND'],
              status: matched ? 'CONFIRMED' : 'PROPOSED',
              other: i.id === 'f-1' ? lost : found,
            },
          ],
    claim: released
      ? {
          claimantName: 'Mona Delta',
          idDocument: 'PASSPORT',
          handover: 'IN_PERSON',
          releasedAt: '2026-10-03T12:00:00Z',
        }
      : null,
    history: [{ id: 'h1', event: 'REGISTERED', note: null, createdAt: '2026-10-03T09:00:00Z' }],
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
    if (path === `${base}/rooms`)
      return r.fulfill({ json: [{ locationId: ROOM, roomNumber: '504' }] });
    if (path === `${base}/lostfound/items` && method === 'POST')
      return r.fulfill({ status: 201, json: { id: 'new-1' } });
    if (path === `${base}/lostfound/items`) {
      if (url.searchParams.get('due') === 'true')
        return r.fulfill({ json: umbrella.status === 'DISPOSED' ? [] : [umbrella] });
      return r.fulfill({
        json: url.searchParams.get('kind') === 'LOST' ? [lost] : released ? [] : [found],
      });
    }
    if (path === `${base}/lostfound/matches`)
      return r.fulfill({
        json: matched
          ? []
          : [
              {
                id: 'm-1',
                score: 100,
                reasons: ['CATEGORY', 'COLOUR', 'BRAND'],
                status: 'PROPOSED',
                version: 1,
                found,
                lost,
              },
            ],
      });
    if (path === `${base}/lostfound/matches/m-1/confirm`) {
      matched = true;
      found = { ...found, status: 'MATCHED', version: 2 };
      lost = { ...lost, status: 'MATCHED', version: 2 };
      return r.fulfill({ json: {} });
    }
    if (path === `${base}/lostfound/items/f-1/release`) {
      released = true;
      found = { ...found, status: 'RELEASED', version: 3 };
      return r.fulfill({ json: { item: found } });
    }
    if (path === `${base}/lostfound/items/u-1/dispose`) {
      umbrella = { ...umbrella, status: 'DISPOSED', retentionDue: false };
      return r.fulfill({ json: umbrella });
    }
    if (path === `${base}/lostfound/items/f-1`) return r.fulfill({ json: detail(found) });
    if (path === `${base}/lostfound/items/u-1`) return r.fulfill({ json: detail(umbrella) });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

const DESK = ['lostfound.read', 'lostfound.register', 'lostfound.manage', 'lostfound.release'];

test('an attendant hands in a found item from the phone, without seeing anyone’s items (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, ['lostfound.register']);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/en/lostfound');
  await expect(page.getByRole('link', { name: 'Lost & Found' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('tab')).toHaveCount(0);
  const form = page.getByRole('form', { name: 'Hand in a found item' });
  await form.getByRole('combobox', { name: 'What is it' }).selectOption('WATCH');
  await form.getByRole('combobox', { name: 'Colour' }).selectOption('GOLD');
  await form.getByRole('combobox', { name: 'Room' }).selectOption(ROOM);
  await form.getByLabel('Description').fill('Gold watch on the bathroom shelf');
  await form.getByRole('button', { name: 'Hand in a found item' }).click();
  await expect(page.getByRole('status')).toHaveText('Thank you — the item was registered.');
  expect(backend.calls.find((c) => c.method === 'POST')?.body).toEqual({
    kind: 'FOUND',
    category: 'WATCH',
    colour: 'GOLD',
    locationId: ROOM,
    description: 'Gold watch on the bathroom shelf',
  });
  expect(backend.calls.some((c) => c.path.includes('/lostfound/matches'))).toBe(false);
});

test('the desk confirms a proposed match and hands the phone back against a claim (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page, DESK);
  await page.goto('/en/lostfound');
  const match = page.locator('[data-match="m-1"]');
  await expect(match).toContainText('#1 · Phone');
  await expect(match).toContainText('#2 · Phone');
  await expect(match).toContainText('100% match');
  await expect(match).toContainText('Same brand');
  await match.getByRole('button', { name: 'Same item' }).click();
  await expect(page.getByRole('status')).toHaveText('The match was confirmed.');
  await expect(page.getByRole('heading', { name: '#1 · Phone' })).toBeVisible();
  await expect(page.locator('[data-linked="CONFIRMED"]')).toContainText('#2 · Phone');

  const release = page.getByRole('form', { name: 'Hand back to owner' });
  await release.getByLabel('Who takes it').fill('Mona Delta');
  await release.getByLabel('How the owner was verified').fill('Unlocked the phone at the desk');
  await release.getByRole('button', { name: 'Hand back to owner' }).click();
  await expect(page.getByRole('status')).toHaveText('The item was handed back.');
  await expect(page.getByTestId('claim')).toContainText('Handed over to Mona Delta');
  expect(backend.calls.find((c) => c.path.endsWith('/release'))?.body).toEqual({
    claimantName: 'Mona Delta',
    idDocument: 'PASSPORT',
    verificationNote: 'Unlocked the phone at the desk',
    version: 2,
  });
});

test('in Arabic, an item past retention is disposed of with a reason, right-to-left', async ({
  page,
}) => {
  const backend = await mockBackend(page, DESK);
  await page.goto('/ar/lostfound');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('tab', { name: 'انتهت مدة حفظها' }).click();
  await page.locator('[data-item="3"]').click();
  await expect(page.getByRole('heading', { name: 'رقم 3 · أخرى' })).toBeVisible();
  const form = page.getByRole('form', { name: 'التصرف في الغرض' });
  await form.getByLabel('السبب').fill('لم يطالب به أحد');
  await form.getByRole('button', { name: 'التصرف في الغرض' }).click();
  await expect(page.getByRole('status')).toHaveText('تم التصرف في الغرض.');
  expect(backend.calls.find((c) => c.path.endsWith('/dispose'))?.body).toEqual({
    method: 'DONATED',
    note: 'لم يطالب به أحد',
    version: 1,
  });
  await expect(page.getByRole('link', { name: 'المفقودات' })).toBeVisible();
});
