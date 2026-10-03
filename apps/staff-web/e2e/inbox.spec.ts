import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const CONVERSATION = '01900000-0000-7000-8000-0000000000c1';

const summary = {
  id: CONVERSATION,
  status: 'WAITING_STAFF',
  aiMode: 'OFF',
  replyChannelType: 'WHATSAPP',
  assignedUserId: null,
  version: 3,
  lastMessageAt: new Date(Date.now() - 120_000).toISOString(),
  verified: true,
  contact: '+20*******567',
  guest: { id: 'g1', givenName: 'Mona', familyName: 'Delta', role: 'PRIMARY' },
  stay: {
    id: 's1',
    status: 'IN_HOUSE',
    expectedDeparture: '2030-12-31',
    room: { id: 'r1', number: '504' },
  },
  lastMessage: { direction: 'INBOUND', preview: 'الجو حر أوي هنا', at: new Date().toISOString() },
};
const detail = {
  ...summary,
  openWork: [
    {
      id: 'w1',
      kind: 'GUEST_COMPLAINT',
      status: 'OPEN',
      priority: 'NORMAL',
      departmentCode: 'ENG',
    },
  ],
  aiSummary: null,
  aiDraft: {
    id: 'd1',
    body: 'آسفين على الإزعاج، فريق الصيانة في الطريق.',
    agentCode: 'GUEST_CONCIERGE',
    createdAt: new Date().toISOString(),
  },
  messages: [
    {
      id: 'm1',
      direction: 'INBOUND',
      senderType: 'GUEST',
      channelType: 'WHATSAPP',
      type: 'TEXT',
      body: 'الجو حر أوي هنا',
      deliveryStatus: 'DELIVERED',
      guestVisible: true,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      id: 'm2',
      direction: 'OUTBOUND',
      senderType: 'STAFF',
      channelType: 'WHATSAPP',
      type: 'TEXT',
      body: 'Engineering is on the way.',
      deliveryStatus: 'READ',
      guestVisible: true,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
};

/** Mocks the BFF, the API (through the same-origin proxy) and the realtime socket in the browser. */
async function mockBackend(page: Page, opts: { signedIn: boolean }) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let signedIn = opts.signedIn;
  await page.route('**/bff/refresh', (r) =>
    signedIn
      ? r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } })
      : r.fulfill({ status: 401, json: { code: 'platform.unauthorized' } }),
  );
  await page.route('**/bff/login', async (r) => {
    calls.push({ method: 'POST', path: '/bff/login', body: r.request().postDataJSON() });
    signedIn = true;
    await r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } });
  });
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    const method = r.request().method();
    calls.push({
      method,
      path: `${path}${url.search}`,
      body: r.request().postDataJSON?.() ?? null,
    });
    expect(r.request().headers()['authorization']).toBe('Bearer access-1');
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [{ propertyId: PROPERTY, permissions: ['inbox.read', 'inbox.reply'] }],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === `/properties/${PROPERTY}/conversations`) return r.fulfill({ json: [summary] });
    if (path === `/properties/${PROPERTY}/conversations/${CONVERSATION}`)
      return r.fulfill({ json: detail });
    if (method === 'POST')
      return r.fulfill({ status: 201, json: { id: 'm3', deliveryStatus: 'QUEUED' } });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  let pushNotice: (() => void) | null = null;
  await page.routeWebSocket('**/realtime-mock', (ws) => {
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw)) as {
        type: string;
        token?: string;
        propertyId?: string;
      };
      if (frame.type === 'auth' && frame.token === 'access-1')
        ws.send(JSON.stringify({ type: 'ready', as: 'staff' }));
      if (frame.type === 'subscribe')
        ws.send(JSON.stringify({ type: 'subscribed', propertyId: frame.propertyId }));
    });
    pushNotice = () =>
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'comms.message.received',
          conversationId: CONVERSATION,
          propertyId: PROPERTY,
        }),
      );
  });
  return { calls, notify: () => pushNotice?.() };
}

test('signs in and works a conversation in English (left-to-right)', async ({ page }) => {
  const backend = await mockBackend(page, { signedIn: false });
  await page.goto('/en/inbox');
  await expect(page).toHaveURL(/\/en\/login$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.getByLabel('Hotel code').fill('PILOT');
  await page.getByLabel('Email').fill('gm@pilot.example');
  await page.getByLabel('Password').fill('a long enough passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/en\/inbox$/);
  expect(backend.calls[0]).toMatchObject({
    path: '/bff/login',
    body: { tenantCode: 'PILOT', email: 'gm@pilot.example' },
  });

  await expect(page.getByRole('heading', { name: 'Guest inbox' })).toBeVisible();
  await expect(page.getByTestId('live')).toHaveText('Live');
  await page.getByRole('button', { name: /Mona Delta/ }).click();
  await expect(page.getByText('GUEST_COMPLAINT')).toBeVisible();
  await expect(page.getByText('Room 504').first()).toBeVisible();

  // Inbound messages sit on the start side (left in English), replies on the end side.
  const inbound = await page.locator('[data-direction="INBOUND"]').boundingBox();
  const outbound = await page.locator('[data-direction="OUTBOUND"]').boundingBox();
  expect(inbound!.x).toBeLessThan(outbound!.x);

  await page.getByLabel('Write a reply…').fill('We are sending towels now.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(
      () => backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages'))?.body,
    )
    .toEqual({ body: 'We are sending towels now.' });
  // The AI suggested a reply: staff use it (and may edit it); the draft id goes with what is sent.
  await expect(page.getByTestId('ai-draft')).toContainText('AI suggestion');
  await page.getByRole('button', { name: 'Use suggestion' }).click();
  await expect(page.getByLabel('Write a reply…')).toHaveValue(
    'آسفين على الإزعاج، فريق الصيانة في الطريق.',
  );
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(
      () =>
        backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages')).at(-1)
          ?.body,
    )
    .toEqual({ body: 'آسفين على الإزعاج، فريق الصيانة في الطريق.', draftId: 'd1' });
  await page.getByLabel('AI assistant').selectOption('AUTO');
  await expect
    .poll(() => backend.calls.find((c) => c.path.endsWith('/ai-mode'))?.body)
    .toEqual({ mode: 'AUTO' });
  await page.getByRole('button', { name: 'Take over' }).click();
  await expect.poll(() => backend.calls.some((c) => c.path.endsWith('/takeover'))).toBe(true);

  // A realtime notice refreshes the list and the open thread.
  const before = backend.calls.filter((c) =>
    c.path.startsWith(`/properties/${PROPERTY}/conversations?`),
  ).length;
  backend.notify();
  await expect
    .poll(
      () =>
        backend.calls.filter((c) => c.path.startsWith(`/properties/${PROPERTY}/conversations?`))
          .length,
    )
    .toBeGreaterThan(before);
  await expect(
    page.getByTestId('attribution').getByRole('link', { name: 'Powered by Planova' }),
  ).toHaveAttribute('href', 'https://planova.com.eg');
});

test('the same inbox in Arabic is right-to-left and fully translated', async ({ page }) => {
  await mockBackend(page, { signedIn: true });
  await page.goto('/ar/inbox');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { name: 'صندوق محادثات الضيوف' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'بانتظارنا' })).toBeVisible();
  await page.getByRole('button', { name: /Mona Delta/ }).click();
  await expect(page.getByText('غرفة 504').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'تولّي المحادثة' })).toBeVisible();
  await expect(page.getByTestId('ai-draft')).toContainText('اقتراح الذكاء الاصطناعي');
  await expect(page.getByRole('button', { name: 'استخدام الاقتراح' })).toBeVisible();
  await expect(page.getByLabel('مساعد الذكاء الاصطناعي')).toHaveValue('OFF');
  // Mirrored: inbound on the right (start in Arabic), replies on the left.
  const inbound = await page.locator('[data-direction="INBOUND"]').boundingBox();
  const outbound = await page.locator('[data-direction="OUTBOUND"]').boundingBox();
  expect(inbound!.x).toBeGreaterThan(outbound!.x);
  // The conversation list sits on the start side too.
  const nav = await page.getByRole('navigation').boundingBox();
  const thread = await page.locator('section').boundingBox();
  expect(nav!.x).toBeGreaterThan(thread!.x);
  await expect(page.getByTestId('attribution')).toContainText('Powered by Planova');
});

test('switching language keeps the page; signing out returns to sign-in', async ({ page }) => {
  await mockBackend(page, { signedIn: true });
  await page.route('**/bff/logout', (r) => r.fulfill({ status: 204 }));
  await page.goto('/en/inbox');
  await page.getByLabel('Language').selectOption('ar');
  await expect(page).toHaveURL(/\/ar\/inbox$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/bff/refresh', (r) => r.fulfill({ status: 401, json: {} }));
  await page.route('**/bff/logout', (r) => r.fulfill({ status: 204 }));
  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/ar\/login$/);
});
