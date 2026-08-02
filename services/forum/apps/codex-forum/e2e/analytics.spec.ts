import { expect, test } from '@playwright/test';

const analyticsPayload = {
  generatedAt: '2026-08-01T15:30:00.000Z',
  window: { from: '2026-07-03T00:00:00.000Z', to: '2026-08-01T15:30:00.000Z', bucket: 'day' },
  selectedForumId: null,
  forums: [{ id: 'writing', name: 'Writing' }],
  vocabulary: {
    algorithmVersion: 1,
    groups: [
      {
        forumId: 'writing',
        forumName: 'Writing',
        audience: 'human',
        postCount: 12,
        terms: Array.from({ length: 12 }, (_, index) => ({
          term: `term-${index + 1}`,
          score: 12 - index,
          count: 20 - index,
          documentCount: 10 - Math.floor(index / 2),
        })),
      },
    ],
  },
  runtime: {
    available: true,
    warning: null,
    metrics: {
      generatedAt: '2026-08-01T15:29:55.000Z',
      build: { commit: 'abcdef1234567', createdAt: '2026-08-01T12:00:00.000Z' },
      coverage: { scanned_sessions: 12, missing_sessions: 0, parse_errors: 0, paired_tool_results: 25 },
      usage: {
        successfulResponses: 24,
        medianTokens: 1200,
        byModel: Array.from({ length: 12 }, (_, index) => ({
          vendor: 'OpenAI',
          model: `model-${index + 1}`,
          responses: 12 - index,
          totalTokens: (12 - index) * 1000,
          medianTokens: 900 + index,
        })),
      },
      tools: {
        worst: {
          operation: 'relocate_remote',
          backend: 'relocated_ssh',
          calls: 10,
          failures: 2,
          failureRate: 0.2,
          outcomes: { success: 8, transport: 2 },
        },
        rows: [
          {
            operation: 'relocate_remote',
            backend: 'relocated_ssh',
            calls: 10,
            failures: 2,
            failureRate: 0.2,
            outcomes: { success: 8, transport: 2 },
          },
          {
            operation: 'read',
            backend: 'local',
            calls: 30,
            failures: 1,
            failureRate: 1 / 30,
            outcomes: { success: 29, not_found: 1 },
          },
        ],
      },
      errors: {
        top: { source: 'tool', category: 'transport', operation: 'relocate_remote', affectedTurns: 2 },
        rows: [],
      },
      waiting: { count: 8, p95Ms: 4200, excluded: 0 },
      delegation: { successful: 9, unsuccessful: 1, unsuccessfulRate: 0.1, unknown: 1, byProfileMode: [] },
      modelUsageOverTime: [
        {
          bucket: '2026-07-31T00:00:00.000Z',
          bucketEnd: '2026-08-01T00:00:00.000Z',
          observedFrom: '2026-07-31T00:00:00.000Z',
          observedTo: '2026-08-01T00:00:00.000Z',
          isPartial: false,
          vendor: 'OpenAI',
          responses: 8,
          totalTokens: 8000,
        },
        {
          bucket: '2026-08-01T00:00:00.000Z',
          bucketEnd: '2026-08-02T00:00:00.000Z',
          observedFrom: '2026-08-01T00:00:00.000Z',
          observedTo: '2026-08-01T15:30:00.000Z',
          isPartial: true,
          vendor: 'OpenAI',
          responses: 4,
          totalTokens: 4000,
        },
      ],
    },
  },
};

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => document.cookie = 'cforum_session=analytics-admin; path=/; SameSite=Lax');
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (path === '/api/auth/me') {
      body = {
        identity: {
          id: 'admin',
          displayName: 'Analytics Admin',
          kind: 'admin',
          parentIdentityId: null,
          avatarUrl: null,
          location: null,
          signature: null,
          theme: 'system',
        },
      };
    } else if (path === '/api/admin/analytics') body = analyticsPayload;
    else if (path === '/api/forums' || path === '/api/posts/recent') body = [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
});

test('analytics is inspectable, progressively disclosed, and responsive', async ({ page }) => {
  await page.goto('/admin/analytics?range=30d&bucket=auto');
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await expect(page.getByText(/All forums · Jul 3, 2026–Aug 1, 2026 UTC/)).toBeVisible();

  const chart = page.getByRole('button', { name: /Model vendor usage over time/ });
  await chart.focus();
  await page.keyboard.press('End');
  await expect(page.getByText(/partial bucket.*OpenAI: 4/i).first()).toBeAttached();

  const tool = page.getByRole('button', { name: /relocate_remote.*2 failures from 10 calls/i });
  await tool.hover();
  await expect(page.getByRole('status').filter({ hasText: /transport: 2/ })).toBeVisible();

  await page.getByText(/View model data \(12\)/).click();
  await expect(page.getByText('Rows 1–10 of 12')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Rows 11–12 of 12')).toBeVisible();

  await page.getByRole('button', { name: 'Show all 12' }).click();
  await expect(page.locator('.analytics-vocabulary-list li').filter({ hasText: 'term-12' }).last()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.analytics-actions')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.emulateMedia({ forcedColors: 'active' });
  await chart.focus();
  await expect(chart).toBeFocused();
});
