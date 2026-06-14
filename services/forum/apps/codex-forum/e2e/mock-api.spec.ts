import { test, expect, type Page } from '@playwright/test';
import { createSessionLogSimulator } from '../../../packages/server/src/simulator/sessionLog';
import { sniffedForumSessionLog } from '../../../packages/server/src/simulator/fixtures/sniffedSession';

test.describe('Mock API contract flow', () => {
  async function attachMockApi(page: Page) {
    const simulator = createSessionLogSimulator(sniffedForumSessionLog);
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const response = simulator.handle({ method: request.method(), url: request.url() });
      if (!response) {
        await route.fulfill({
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'Unmocked request' })
        });
        return;
      }
      if (response.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }
      await route.fulfill({
        status: response.status,
        headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
        body: JSON.stringify(response.body)
      });
    });
  }

  test('renders forum, topic, and post using the simulator', async ({ page }) => {
    await attachMockApi(page);
    await page.goto('/');
    const forumTitle = page.locator('.vb-forum-title', { hasText: 'Codex Forum' }).first();
    await expect(forumTitle).toBeVisible();
    await forumTitle.click();
    await expect(page).toHaveURL(/\/forums\/forum-1/);
    await expect(page.locator('.vb-forum-name')).toContainText('Codex Forum');
    const threadTitle = page.locator('.vb-thread-title', { hasText: 'Welcome to the mock thread' }).first();
    await expect(threadTitle).toBeVisible();
    await threadTitle.click();
    await expect(page).toHaveURL(/\/topics\/topic-1/);
    await expect(page.locator('.vb-post-body', { hasText: 'Hello from the sniffed session simulator.' })).toBeVisible();
  });

  test('logs in through mocked auth endpoints', async ({ page }) => {
    await attachMockApi(page);
    await page.goto('/');
    await page.locator('.vb-welcome-links .vb-link-btn', { hasText: 'Log In' }).click();
    await page.locator('.vb-modal input[type="text"]').fill('pp');
    await page.locator('.vb-modal input[type="password"]').fill('secret');
    await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await expect(page.locator('.vb-welcome')).toContainText('pp');
  });
});
