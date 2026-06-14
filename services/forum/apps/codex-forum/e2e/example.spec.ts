import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
  test('should display welcome message', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vb-welcome')).toContainText('Welcome');
  });

  test('should have correct title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Forum Home - RoboBB Forum/i);
  });
});

test.describe('Unknown routes', () => {
  test('should redirect to home for unknown routes', async ({ page }) => {
    await page.goto('/unknown-route');
    await expect(page).toHaveURL('/');
    await expect(page.locator('.vb-welcome')).toContainText('Welcome');
  });
});
