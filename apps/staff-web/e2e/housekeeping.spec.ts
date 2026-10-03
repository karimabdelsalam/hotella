import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-0000000000a1';
const BADR = '01900000-0000-7000-8000-0000000000a2';

const room = (n: string, extra: object = {}) => ({
  roomId: `room-${n}`,
  roomNumber: n,
  floorLabel: null,
  occupancy: 'VACANT',
  housekeeping: 'DIRTY',
  frontOffice: null,
  ready: false,
  signals: [],
  ...extra,
});
const job = (n: string, extra: object = {}) => ({
  id: `job-${n}`,
  roomId: `room-${n}`,
  roomNumber: n,
  floorLabel: null,
  cleaningType: 'CHECKOUT',
  credits: 1,
  status: 'OPEN',
  taskId: `task-${n}`,
  assignee: null,
  makeUpRequested: false,
  doNotDisturb: false,
  ...extra,
});

/** Mocks the BFF and the API (through the same-origin proxy); jobs move as the staff act. */
async function mockBackend(page: Page, permissions: readonly string[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const jobs = [
    job('504', { cleaningType: 'STAYOVER', credits: 0.7, makeUpRequested: true }),
    job('101', { assignee: { type: 'USER', id: ME } }),
    job('102', { status: 'DONE', cleaningType: 'DEEP_CLEAN', credits: 2 }),
  ];
  const rooms = [
    room('101'),
    room('102', { housekeeping: 'INSPECTING' }),
    room('201', { housekeeping: 'CLEAN', ready: true }),
    room('504', {
      occupancy: 'OCCUPIED',
      housekeeping: 'DIRTY',
      signals: [{ signal: 'MAKE_UP_ROOM', source: 'GUEST_PORTAL' }],
    }),
  ];
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = r.request().method();
    const body = r.request().postDataJSON?.() ?? null;
    calls.push({ method, path, body });
    const base = `/properties/${PROPERTY}`;
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: ME, tenantId: 't1' },
          memberships: [{ propertyId: PROPERTY, permissions }],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === `${base}/housekeeping/rooms`) return r.fulfill({ json: rooms });
    if (path === `${base}/housekeeping/jobs`) return r.fulfill({ json: jobs });
    if (path === `${base}/housekeeping/attendants`)
      return r.fulfill({
        json: [
          { id: ME, displayName: 'Amal Samir' },
          { id: BADR, displayName: 'Badr Nabil' },
        ],
      });
    if (path === `${base}/housekeeping/assignments/proposal`)
      return r.fulfill({
        json: {
          day: '2026-10-03',
          totalCredits: 1.7,
          plan: [
            { attendantId: ME, credits: 1, jobs: [{ jobId: 'job-101', roomNumber: '101' }] },
            { attendantId: BADR, credits: 0.7, jobs: [{ jobId: 'job-504', roomNumber: '504' }] },
          ],
        },
      });
    if (path === `${base}/housekeeping/assignments`) return r.fulfill({ json: { assigned: 2 } });
    const task = /\/tasks\/task-(\d+)\/(start|complete)$/.exec(path);
    if (task) {
      const j = jobs.findIndex((x) => x.roomNumber === task[1]);
      jobs[j] = { ...jobs[j]!, status: task[2] === 'start' ? 'IN_PROGRESS' : 'DONE' };
      return r.fulfill({ json: { id: `task-${task[1]}` } });
    }
    if (path.endsWith('/inspection')) {
      rooms[1] = { ...rooms[1]!, housekeeping: 'INSPECTED' };
      return r.fulfill({ status: 201, json: { job: { status: 'INSPECTED' }, touchUp: null } });
    }
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { calls };
}

const SUPERVISOR = ['hk.board.read', 'hk.job.manage', 'hk.inspect', 'task.accept', 'task.complete'];

test('an attendant starts and finishes their room in one tap each (English)', async ({ page }) => {
  const backend = await mockBackend(page, ['hk.board.read', 'task.accept', 'task.complete']);
  await page.goto('/en/housekeeping');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { name: 'Rooms assigned to you today' })).toBeVisible();
  const mine = page.locator('[data-job="101"]');
  await expect(mine).toContainText('Check-out clean');
  // Only their own room: 504 is not assigned to them.
  await expect(page.locator('[data-job="504"]')).toHaveCount(0);
  await mine.getByRole('button', { name: 'Start' }).click();
  await mine.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('status')).toHaveText('Marked as done.');
  expect(backend.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
    `/properties/${PROPERTY}/tasks/task-101/start`,
    `/properties/${PROPERTY}/tasks/task-101/complete`,
  ]);
  // No planning for an attendant.
  await page.getByRole('tab', { name: "Today's jobs" }).click();
  await expect(page.getByRole('heading', { name: 'Plan the day' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Housekeeping' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('a supervisor inspects, then plans the day and assigns it as proposed', async ({ page }) => {
  const backend = await mockBackend(page, SUPERVISOR);
  await page.goto('/en/housekeeping');
  await page.getByRole('tab', { name: "Today's jobs" }).click();
  await expect(page.getByRole('heading', { name: /Today's jobs · 3\.7 credits/ })).toBeVisible();
  // The room asking to be made up is first and flagged.
  await expect(page.locator('[data-job]').first()).toHaveAttribute('data-job', '504');
  await expect(page.locator('[data-job="504"]')).toContainText('Make up room');
  await page.locator('[data-job="102"]').getByRole('button', { name: 'Passed' }).click();
  await expect
    .poll(
      () =>
        backend.calls.find((c) => c.path.endsWith('/housekeeping/jobs/job-102/inspection'))?.body,
    )
    .toEqual({ result: 'PASS' });

  await page.getByLabel('Amal Samir').check();
  await page.getByLabel('Badr Nabil').check();
  await page.getByRole('button', { name: 'Propose a plan' }).click();
  await expect(page.locator(`[data-attendant="${BADR}"]`)).toContainText(
    'Badr Nabil · 0.7 credits · 504',
  );
  await page.getByRole('button', { name: 'Assign as proposed' }).click();
  await expect(page.getByRole('status')).toHaveText('The rooms are assigned.');
  expect(backend.calls.find((c) => c.path.endsWith('/assignments/proposal'))?.body).toEqual({
    attendantIds: [ME, BADR],
  });
  expect(backend.calls.find((c) => c.path.endsWith('/housekeeping/assignments'))?.body).toEqual({
    assignments: [
      { jobId: 'job-101', userId: ME },
      { jobId: 'job-504', userId: BADR },
    ],
  });
});

test('the room board in Arabic is right-to-left, by floor, and fully translated', async ({
  page,
}) => {
  await mockBackend(page, SUPERVISOR);
  await page.goto('/ar/housekeeping');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('tab', { name: 'الغرف' }).click();
  await expect(page.getByRole('heading', { name: 'الطابق 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'الطابق 5' })).toBeVisible();
  await expect(page.locator('[data-room="201"]')).toContainText('جاهزة');
  await expect(page.locator('[data-room="102"]')).toContainText('بانتظار الفحص');
  await expect(page.locator('[data-room="504"]')).toContainText('تنظيف الغرفة');
  await expect(page.locator('[data-room="504"]')).toContainText('مشغولة');
  // Mirrored: the first room of a floor sits on the right.
  const first = await page.locator('[data-room="101"]').boundingBox();
  const second = await page.locator('[data-room="102"]').boundingBox();
  expect(first!.x).toBeGreaterThan(second!.x);
  await expect(page.getByRole('link', { name: 'التدبير الفندقي' })).toBeVisible();
});
