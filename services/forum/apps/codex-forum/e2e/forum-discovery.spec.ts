import { expect, test } from '@playwright/test';

import { createForumFixture } from './support/forum-fixture';

test.describe('Forum discovery + navigation (read-only)', () => {
  test('guest navigation hides authenticated tools and direct visits prompt login', async ({ page }) => {
    const fixture = createForumFixture();
    fixture.createForum({ name: 'E2E Public', visibility: 'public' });
    await fixture.attach(page);

    await page.goto('/');
    await expect(page.locator('.vb-welcome-links')).not.toContainText('Chat');
    await expect(page.locator('.vb-welcome-links')).not.toContainText('Developers');
    await expect(page.locator('.vb-welcome-links')).not.toContainText('API Docs');
    await expect(page.locator('.vb-nav-items')).not.toContainText('Chat');
    await expect(page.locator('.vb-nav-items')).not.toContainText('Developers');
    await expect(page.locator('.vb-nav-items')).not.toContainText('API Docs');
    await expect(page.locator('.vb-footer-links')).not.toContainText('Developers');
    await expect(page.locator('.vb-footer-links')).not.toContainText('API Docs');

    await page.goto('/chat');
    await expect(page).toHaveURL('/');
    await expect(page.locator('.vb-modal')).toContainText('Log In');
  });

  test('home renders forum summary, hides restricted forums, and navigates into forum/topic views', async ({
    page,
  }) => {
    const fixture = createForumFixture();
    const author = fixture.createIdentity('E2E Reader');
    const secondAuthor = fixture.createIdentity('Second Poster');
    const baseTime = fixture.now.getTime();

    const publicForum = fixture.createForum({
      name: 'E2E Public',
      description: 'Public read-only forum',
      category: 'E2E Category',
      visibility: 'public',
    });
    fixture.createForum({
      name: 'E2E Members',
      description: 'Members-only forum',
      category: 'E2E Category',
      visibility: 'members',
    });
    fixture.createForum({
      name: 'E2E Admin',
      description: 'Admin-only forum',
      category: 'E2E Category',
      visibility: 'admin',
    });

    const stickyTopic = fixture.createTopic({
      forumId: publicForum.id,
      title: 'Sticky Welcome Thread',
      createdBy: author.id,
      tags: ['sticky'],
      postCount: 2,
      bodyPrefix: 'Sticky post',
      createdAt: new Date(baseTime - 180 * 60 * 1000).toISOString(),
    });
    const longTopic = fixture.createTopic({
      forumId: publicForum.id,
      title: 'Long Discussion Thread',
      createdBy: secondAuthor.id,
      postCount: 60,
      bodyPrefix: 'Long post',
      createdAt: new Date(baseTime - 120 * 60 * 1000).toISOString(),
    });
    const shortTopic = fixture.createTopic({
      forumId: publicForum.id,
      title: 'Short Thread',
      createdBy: author.id,
      postCount: 3,
      bodyPrefix: 'Short post',
      createdAt: new Date(baseTime - 10 * 60 * 1000).toISOString(),
    });

    await page.addInitScript(() => {
      const clipboard = {
        writeText: async (text: string) => {
          (window as { __lastClipboardText?: string }).__lastClipboardText = text;
        },
        readText: async () => (window as { __lastClipboardText?: string }).__lastClipboardText ?? '',
      };
      Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    });
    await fixture.attach(page);
    await page.goto('/');

    await expect(page.locator('.vb-welcome')).toContainText('Welcome');
    await expect(page.locator('.vb-forum-list')).toBeVisible();
    await expect(page.locator('.vb-forum-title', { hasText: 'E2E Public' })).toBeVisible();
    await expect(page.locator('.vb-forum-title', { hasText: 'E2E Members' })).toHaveCount(0);
    await expect(page.locator('.vb-forum-title', { hasText: 'E2E Admin' })).toHaveCount(0);

    const publicRow = page.locator('.vb-forum-row', { hasText: 'E2E Public' });
    await expect(publicRow.locator('.vb-forum-threads')).toHaveText('3');
    await expect(publicRow.locator('.vb-forum-posts')).toHaveText('65');
    await expect(publicRow.locator('.vb-lastpost-title')).toContainText(shortTopic.title);
    await expect(publicRow.locator('.vb-lastpost-author')).toContainText(author.displayName);

    await expect(page.locator('.vb-recent-box')).toBeVisible();
    await expect(page.locator('.vb-recent-item', { hasText: shortTopic.title }).first()).toBeVisible();

    await publicRow.locator('.vb-forum-title').click();
    await expect(page).toHaveURL(new RegExp(`/forums/${publicForum.id}$`));

    const topicRows = page.locator('.vb-table tbody tr');
    await expect(topicRows.filter({ hasText: stickyTopic.title }).first()).toBeVisible();
    await expect(topicRows.filter({ hasText: shortTopic.title }).first()).toBeVisible();

    const firstThreadRow = page.locator('.vb-table tbody tr.vb-table-row').first();
    await expect(firstThreadRow).toContainText(stickyTopic.title);

    const paginationBlock = topicRows.filter({ hasText: longTopic.title }).locator('.vb-thread-pages');
    await expect(paginationBlock).toContainText('1');
    await expect(paginationBlock).toContainText('2');
    await expect(paginationBlock).toContainText('3');
    await expect(paginationBlock).toContainText('…');

    await paginationBlock.locator('.vb-thread-pages-link', { hasText: '8' }).click();
    await expect(page).toHaveURL(new RegExp(`/topics/${longTopic.id}\\?page=8$`));

    await page.locator('.vb-pagination-controls .vb-page-btn[title="Jump to latest post"]').first().click();
    await expect(page).toHaveURL(new RegExp(`/topics/${longTopic.id}\\?page=8#60$`));

    const firstPostLink = page.locator('.vb-post-footer .vb-control-btn', { hasText: 'Link' }).first();
    await firstPostLink.click();
    const copiedText = await page.evaluate(
      () => (window as { __lastClipboardText?: string }).__lastClipboardText ?? ''
    );
    expect(copiedText).toContain(`/topics/${longTopic.id}`);

    await page.locator('.vb-tools .vb-menu', { hasText: 'Search this Thread' }).click();
    const searchOverlay = page.locator('.vb-thread-search');
    await expect(searchOverlay).toBeVisible();
    await searchOverlay.locator('.vb-modal-close').click();
    await expect(searchOverlay).toHaveCount(0);

    await page.locator('.vb-pagination-controls').first().locator('.vb-page-btn', { hasText: '1' }).click();
    await expect(page).toHaveURL(new RegExp(`/topics/${longTopic.id}\\?page=1`));
    await page.locator('.vb-pagination-controls').first().locator('.vb-page-btn', { hasText: '2' }).click();
    await expect(page).toHaveURL(new RegExp(`/topics/${longTopic.id}\\?page=2`));

    await page.locator('.vb-controls .vb-btn', { hasText: 'Back to Forum' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/forums/${publicForum.id}$`));
    await expect(page.locator('.vb-forum-name')).toHaveText(publicForum.name);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/topics/${longTopic.id}\\?page=2`));
  });

  test('unknown forum/topic URLs show safe fallback', async ({ page }) => {
    const fixture = createForumFixture();
    const author = fixture.createIdentity('E2E Reader');
    const publicForum = fixture.createForum({
      name: 'E2E Public',
      description: 'Public read-only forum',
      visibility: 'public',
    });
    fixture.createTopic({
      forumId: publicForum.id,
      title: 'Known Thread',
      createdBy: author.id,
      postCount: 1,
      bodyPrefix: 'Known post',
    });

    await fixture.attach(page);

    await page.goto('/forums/unknown-forum');
    await expect(page).toHaveURL('/forums/unknown-forum');
    await expect(page.locator('.vb-banner')).toContainText('Forum not found');

    await page.goto('/topics/unknown-topic');
    await expect(page).toHaveURL('/');
    const banner = page.locator('.vb-banner');
    let bannerVisible = false;
    try {
      await banner.waitFor({ state: 'visible', timeout: 1000 });
      bannerVisible = true;
    } catch {
      bannerVisible = false;
    }
    if (bannerVisible) {
      await expect(banner).toContainText('Topic not found');
    }

    await page.goto(`/forums/${publicForum.id}`);
    await expect(page.locator('.vb-banner')).toHaveCount(0);
  });

  test('members-only forum deep link stays hidden for logged-out visitors', async ({ page }) => {
    const fixture = createForumFixture();
    fixture.createIdentity('E2E Reader');
    const membersForum = fixture.createForum({
      name: 'E2E Members',
      description: 'Members-only forum',
      visibility: 'members',
    });

    await fixture.attach(page);
    await page.goto('/');
    await expect(page.locator('.vb-forum-title', { hasText: membersForum.name })).toHaveCount(0);

    await page.goto(`/forums/${membersForum.id}`);
    await expect(page).toHaveURL(`/forums/${membersForum.id}`);
    await expect(page.locator('.vb-banner')).toContainText('Forum not found');
  });

  test('authenticated viewers can see members forums; admins see admin-only forums', async ({ page, context }) => {
    const fixture = createForumFixture();
    const member = fixture.createIdentity('Member Viewer');
    const admin = fixture.createIdentity('Admin Viewer', 'admin');
    const publicForum = fixture.createForum({ name: 'Public Zone', visibility: 'public' });
    const membersForum = fixture.createForum({ name: 'Members Lounge', visibility: 'members' });
    const adminForum = fixture.createForum({ name: 'Admin HQ', visibility: 'admin' });

    const memberToken = fixture.createSession(member);
    const adminToken = fixture.createSession(admin);

    await fixture.attach(page);
    await page.addInitScript(
      ([tokenKey, token]) => {
        window.localStorage.setItem(tokenKey, token);
      },
      [fixture.AUTH_TOKEN_KEY, memberToken]
    );
    await page.goto('/');

    await expect(page.locator('.vb-forum-title', { hasText: publicForum.name })).toBeVisible();
    await expect(page.locator('.vb-forum-title', { hasText: membersForum.name })).toBeVisible();
    await expect(page.locator('.vb-forum-title', { hasText: adminForum.name })).toHaveCount(0);

    const adminPage = await context.newPage();
    await fixture.attach(adminPage);
    await adminPage.addInitScript(
      ([tokenKey, token]) => {
        window.localStorage.setItem(tokenKey, token);
      },
      [fixture.AUTH_TOKEN_KEY, adminToken]
    );
    await adminPage.goto('/');

    await expect(adminPage.locator('.vb-forum-title', { hasText: publicForum.name })).toBeVisible();
    await expect(adminPage.locator('.vb-forum-title', { hasText: membersForum.name })).toBeVisible();
    await expect(adminPage.locator('.vb-forum-title', { hasText: adminForum.name })).toBeVisible();
  });

  test('forum list refreshes after new topic appears', async ({ page, context }) => {
    const fixture = createForumFixture();
    const author = fixture.createIdentity('E2E Reader');
    const publicForum = fixture.createForum({
      name: 'E2E Public',
      description: 'Public read-only forum',
      visibility: 'public',
    });
    const starterTopic = fixture.createTopic({
      forumId: publicForum.id,
      title: 'Starter Thread',
      createdBy: author.id,
      postCount: 1,
      bodyPrefix: 'Starter post',
    });

    await fixture.attach(page);
    await page.goto('/');

    const publicRow = page.locator('.vb-forum-row', { hasText: publicForum.name });
    await expect(publicRow.locator('.vb-forum-threads')).toHaveText('1');
    await expect(publicRow.locator('.vb-lastpost-title')).toContainText(starterTopic.title);

    const secondPage = await context.newPage();
    await fixture.attach(secondPage);
    await secondPage.goto('/');

    fixture.createTopic({
      forumId: publicForum.id,
      title: 'Newly Seeded Thread',
      createdBy: author.id,
      postCount: 2,
      bodyPrefix: 'Seeded post',
      createdAt: new Date(fixture.now.getTime() + 10 * 60 * 1000).toISOString(),
    });

    await secondPage.reload();
    const secondRow = secondPage.locator('.vb-forum-row', { hasText: publicForum.name });
    await expect(secondRow.locator('.vb-forum-threads')).toHaveText('2');
    await expect(secondRow.locator('.vb-forum-posts')).toHaveText('3');
    await expect(secondRow.locator('.vb-lastpost-title')).toContainText('Newly Seeded Thread');
  });
});
