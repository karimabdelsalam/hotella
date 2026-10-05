import { expect, type Page, test } from '@playwright/test';

const PROPERTY = '01900000-0000-7000-8000-000000000001';
const INSIGHT = '01900000-0000-7000-8000-0000000000a1';

async function mockBackend(page: Page) {
  const acted: Array<{ path: string; body: unknown }> = [];
  let status: 'OPEN' | 'ACKNOWLEDGED' = 'OPEN';
  await page.route('**/bff/refresh', (r) =>
    r.fulfill({ json: { accessToken: 'access-1', expiresIn: 900 } }),
  );
  await page.route('**/hotella/**', async (r) => {
    const url = new URL(r.request().url());
    const path = url.pathname.replace(/^\/hotella/, '');
    if (path === '/me')
      return r.fulfill({
        json: {
          user: { id: 'u1', tenantId: 't1' },
          memberships: [
            {
              propertyId: PROPERTY,
              permissions: [
                'ai.insight.read',
                'ai.insight.act',
                'ai.manager.use',
                'ai.quality.read',
              ],
            },
          ],
        },
      });
    if (path === '/properties')
      return r.fulfill({ json: [{ id: PROPERTY, name: 'Red Sea Resort' }] });
    if (path === `/properties/${PROPERTY}/insights`)
      return r.fulfill({
        json: [
          {
            id: INSIGHT,
            detector: 'RECURRING_ASSET_FAILURE',
            severity: 'HIGH',
            confidence: 0.75,
            reasonKey: 'ai.insight.reason.recurring_failure_same_cause',
            reasonParams: { count: 4, days: 30, cause: 'WEAR' },
            affected: [{ type: 'ASSET', id: 'a1' }],
            suggestedAction: { key: 'ai.insight.action.preventive_check', params: {} },
            status,
            firstSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
            lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
            occurrences: 2,
            version: status === 'OPEN' ? 1 : 2,
          },
        ],
      });
    if (path.startsWith(`/properties/${PROPERTY}/insights/${INSIGHT}/`)) {
      acted.push({ path, body: r.request().postDataJSON() });
      status = 'ACKNOWLEDGED';
      return r.fulfill({ json: {} });
    }
    if (path === `/properties/${PROPERTY}/ai/manager`)
      return r.fulfill({
        json: {
          executionId: 'e1',
          outcome: 'ANSWERED',
          answer: 'The AC of room 504 failed four times this month.',
          locale: 'en',
          sources: [],
        },
      });
    if (path === `/properties/${PROPERTY}/ai/pulse`)
      return r.fulfill({
        json: {
          at: new Date().toISOString(),
          openWork: { total: 5, byDepartment: { ENG: 3, HK: 2 } },
          slaBreaches24h: { total: 1, byDepartment: { ENG: 1 } },
          openComplaints: { total: 2, bySeverity: { HIGH: 1, LOW: 1 } },
          roomsRestricted: { total: 1, byKind: { OOO: 1 } },
          arrivalsTomorrow: { day: '2026-10-06', count: 12 },
          liveInsights: { total: 1, bySeverity: { HIGH: 1 } },
        },
      });
    if (path === `/properties/${PROPERTY}/ai/quality`)
      return r.fulfill({
        json: [
          {
            day: '2026-10-04',
            agentCode: 'GUEST_CONCIERGE',
            agentVersionId: 'v5',
            metric: 'fallback_rate',
            value: 0.25,
            samples: 8,
          },
          {
            day: '2026-10-04',
            agentCode: 'GUEST_CONCIERGE',
            agentVersionId: null,
            metric: 'task_creation_accuracy',
            value: 0.9,
            samples: 10,
          },
        ],
      });
    return r.fulfill({ status: 404, json: { code: 'platform.not_found' } });
  });
  return { acted };
}

test('the manager sees insights with their reasons, acts on them and asks the assistant (English)', async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.goto('/en/intelligence');
  await expect(page.getByRole('heading', { name: 'Intelligence' })).toBeVisible();
  const card = page.locator(`[data-insight="${INSIGHT}"]`);
  await expect(card).toHaveAttribute('data-severity', 'HIGH');
  await expect(card).toContainText('Recurring equipment failure');
  await expect(card).toContainText(
    'Corrective repairs on this equipment in the last 30 days: 4, most with the same cause (WEAR).',
  );
  await expect(card).toContainText('Plan a preventive check of this equipment.');
  await expect(card).toContainText('Confidence 75%');
  await card.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(card).toContainText('Acknowledged');
  await expect(card.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  expect(backend.acted).toEqual([
    { path: `/properties/${PROPERTY}/insights/${INSIGHT}/acknowledge`, body: { version: 1 } },
  ]);
  // Dismissing needs a reason.
  await card.getByRole('button', { name: 'Dismiss' }).first().click();
  const confirm = card.locator('form').getByRole('button', { name: 'Dismiss' });
  await expect(confirm).toBeDisabled();
  await card.getByLabel('Why is this not relevant?').fill('Compressor already replaced');
  await confirm.click();
  expect(backend.acted.at(-1)).toEqual({
    path: `/properties/${PROPERTY}/insights/${INSIGHT}/dismiss`,
    body: { version: 2, reason: 'Compressor already replaced' },
  });

  await page
    .getByRole('textbox', { name: 'Ask the Manager assistant' })
    .fill('What needs my attention today?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('manager-answer')).toHaveText(
    'The AC of room 504 failed four times this month.',
  );

  await page.getByRole('tab', { name: 'Right now' }).click();
  await expect(page.locator('[data-pulse="open_work"]')).toContainText('5');
  await expect(page.locator('[data-pulse="open_work"]')).toContainText('ENG · 3');
  await expect(page.locator('[data-pulse="arrivals"]')).toContainText('12');

  await page.getByRole('tab', { name: 'AI quality' }).click();
  await expect(page.locator('[data-metric="fallback_rate"]')).toContainText('Handed to a person');
  await expect(page.locator('[data-metric="fallback_rate"]')).toContainText('25%');
  await expect(page.locator('[data-metric="task_creation_accuracy"]')).toContainText('90%');
});

test('Intelligence in Arabic is right-to-left and translated, the severity bar on the start side', async ({
  page,
}) => {
  await mockBackend(page);
  await page.goto('/ar/intelligence');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const card = page.locator(`[data-insight="${INSIGHT}"]`);
  await expect(card).toContainText('عطل متكرر في المعدات');
  await expect(card).toContainText('الإصلاحات التصحيحية لهذه المعدة خلال آخر 30 يومًا');
  await expect(card).toContainText('خطّط لفحص وقائي لهذه المعدة.');
  await expect(page.getByRole('link', { name: 'الذكاء التشغيلي' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const box = await card.boundingBox();
  const bar = await card.locator('span[aria-hidden]').first().boundingBox();
  // In RTL the start side is the right.
  expect(bar!.x + bar!.width).toBeGreaterThan(box!.x + box!.width - 2);
  await page.getByRole('tab', { name: 'الآن' }).click();
  await expect(page.locator('[data-pulse="restricted"]')).toContainText('غرف خارج الخدمة');
});
