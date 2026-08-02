import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type {
  AdminForumDto,
  AdminUserDto,
  ApiKeyDto,
  AuthIdentityDto,
  ForumDto,
  ImpersonationTokenDto,
  InviteDto,
  RecentPostDto
} from '@irrigationreal/codex-forum-contracts';

type MockState = {
  authToken: string;
  identity: AuthIdentityDto;
  permissions: string[];
  adminForums: AdminForumDto[];
  forums: ForumDto[];
  users: AdminUserDto[];
  invites: InviteDto[];
  apiKeys: ApiKeyDto[];
  impersonationTokens: ImpersonationTokenDto[];
  recentPosts: RecentPostDto[];
  deployFailuresRemaining: number;
  discordStatusError: boolean;
  matrixStatusError: boolean;
  nextId: () => string;
  nextTimestamp: () => string;
};

function buildMockState(options: { admin: boolean }): MockState {
  let idCounter = 1;
  const baseTime = new Date('2025-01-01T12:00:00.000Z').getTime();
  let timeOffset = 0;
  const nextId = () => `e2e-${idCounter++}`;
  const nextTimestamp = () => new Date(baseTime + timeOffset++ * 1000).toISOString();

  const identity: AuthIdentityDto = {
    id: nextId(),
    displayName: options.admin ? 'E2E Admin' : 'E2E Member',
    kind: options.admin ? 'admin' : 'human',
    parentIdentityId: null,
    avatarUrl: null,
    location: null,
    signature: null,
    theme: 'system'
  };

  const createdAt = nextTimestamp();
  const adminForum: AdminForumDto = {
    id: nextId(),
    name: 'E2E Root Forum',
    description: 'Seeded forum for admin tests',
    parentForumId: null,
    category: 'Seeded',
    cwd: null,
    prePrompt: null,
    status: 'active',
    visibility: 'public',
    topicCount: 0,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt
  };

  const forum = adminForumToForum(adminForum);

  const users: AdminUserDto[] = [
    {
      id: nextId(),
      displayName: 'Seeded User',
      username: 'seeded-user',
      kind: 'human',
      avatarUrl: null,
      createdAt: nextTimestamp()
    }
  ];

  return {
    authToken: options.admin ? 'e2e-admin-token' : 'e2e-member-token',
    identity,
    permissions: options.admin ? ['admin.all'] : [],
    adminForums: [adminForum],
    forums: [forum],
    users,
    invites: [],
    apiKeys: [],
    impersonationTokens: [],
    recentPosts: [],
    deployFailuresRemaining: 0,
    discordStatusError: false,
    matrixStatusError: false,
    nextId,
    nextTimestamp
  };
}

function adminForumToForum(forum: AdminForumDto): ForumDto {
  return {
    id: forum.id,
    tenantId: null,
    name: forum.name,
    description: forum.description ?? null,
    parentForumId: forum.parentForumId ?? null,
    category: forum.category ?? null,
    status: forum.status ?? 'active',
    visibility: forum.visibility ?? 'public',
    archivedAt: forum.archivedAt ?? null,
    threadCount: forum.topicCount,
    postCount: 0,
    lastPost: null,
    createdAt: forum.createdAt,
    updatedAt: forum.updatedAt
  };
}

async function seedAuth(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript((authToken) => {
    document.cookie = `cforum_session=${authToken}; path=/; SameSite=Lax`;
  }, token);
}

async function attachMockApi(context: BrowserContext, state: MockState): Promise<void> {
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    const fulfillJson = async (status: number, body: unknown) => {
      await route.fulfill({
        status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    };

    if (path === '/api/auth/me' && method === 'GET') {
      await fulfillJson(200, { identity: state.identity });
      return;
    }

    if (path.startsWith('/api/identities/') && path.endsWith('/permissions') && method === 'GET') {
      await fulfillJson(200, { permissions: state.permissions });
      return;
    }

    if (path === '/api/forums' && method === 'GET') {
      const status = url.searchParams.get('status');
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      let forums = state.forums;
      if (status) {
        forums = forums.filter((forum) => forum.status === status);
      } else if (!includeArchived) {
        forums = forums.filter((forum) => forum.status !== 'archived');
      }
      await fulfillJson(200, forums);
      return;
    }

    if (path === '/api/posts/recent' && method === 'GET') {
      await fulfillJson(200, state.recentPosts);
      return;
    }

    if (path === '/api/admin/forums' && method === 'GET') {
      await fulfillJson(200, { items: state.adminForums });
      return;
    }

    if (path === '/api/admin/forums' && method === 'POST') {
      const payload = (await request.postDataJSON()) as {
        name?: string;
        description?: string | null;
        category?: string | null;
        status?: 'active' | 'archived';
        visibility?: 'public' | 'members' | 'admin';
        parentForumId?: string | null;
        cwd?: string | null;
        prePrompt?: string | null;
      };
      const name = payload.name?.trim() ?? '';
      if (name.length < 3) {
        await fulfillJson(400, { message: 'Forum name must be at least 3 characters.' });
        return;
      }
      const id = state.nextId();
      const createdAt = state.nextTimestamp();
      const adminForum: AdminForumDto = {
        id,
        name,
        description: payload.description ?? null,
        category: payload.category ?? null,
        status: payload.status ?? 'active',
        visibility: payload.visibility ?? 'public',
        parentForumId: payload.parentForumId ?? null,
        cwd: payload.cwd ?? null,
        prePrompt: payload.prePrompt ?? null,
        topicCount: 0,
        archivedAt: null,
        createdAt,
        updatedAt: createdAt
      };
      state.adminForums = [adminForum, ...state.adminForums];
      state.forums = [adminForumToForum(adminForum), ...state.forums];
      await fulfillJson(200, adminForum);
      return;
    }

    if (path.startsWith('/api/admin/forums/') && method === 'PATCH') {
      const forumId = path.split('/').pop() ?? '';
      const updates = (await request.postDataJSON()) as Partial<AdminForumDto> & { archivedAt?: string | null };
      const existingForum = state.adminForums.find((item) => item.id === forumId);
      if (!existingForum) {
        await fulfillJson(404, { message: 'Forum not found.' });
        return;
      }
      const updatedForum: AdminForumDto = {
        ...existingForum,
        ...updates,
        updatedAt: state.nextTimestamp()
      };
      state.adminForums = state.adminForums.map((item) => (item.id === forumId ? updatedForum : item));
      state.forums = state.forums.map((item) => (item.id === forumId ? adminForumToForum(updatedForum) : item));
      await fulfillJson(200, updatedForum);
      return;
    }

    if (path === '/api/admin/users' && method === 'GET') {
      await fulfillJson(200, { items: state.users, page: 1, pageSize: 50, total: state.users.length });
      return;
    }

    if (path === '/api/admin/users' && method === 'POST') {
      const payload = (await request.postDataJSON()) as {
        displayName?: string;
        username?: string;
        kind?: 'admin' | 'human' | 'robot';
      };
      const displayName = payload.displayName?.trim() ?? '';
      if (!displayName) {
        await fulfillJson(400, { message: 'Display name is required.' });
        return;
      }
      const user: AdminUserDto = {
        id: state.nextId(),
        displayName,
        username: payload.username ?? null,
        kind: payload.kind ?? 'human',
        avatarUrl: null,
        createdAt: state.nextTimestamp()
      };
      state.users = [user, ...state.users];
      await fulfillJson(200, user);
      return;
    }

    if (path.startsWith('/api/admin/users/') && method === 'PATCH') {
      const userId = path.split('/').pop() ?? '';
      const updates = (await request.postDataJSON()) as Partial<AdminUserDto>;
      const user = state.users.find((item) => item.id === userId);
      if (!user) {
        await fulfillJson(404, { message: 'User not found.' });
        return;
      }
      Object.assign(user, updates);
      state.users = state.users.map((item) => (item.id === userId ? user : item));
      await fulfillJson(200, user);
      return;
    }

    if (path === '/api/invites' && method === 'GET') {
      await fulfillJson(200, { items: state.invites, page: 1, pageSize: 50, total: state.invites.length });
      return;
    }

    if (path === '/api/invites' && method === 'POST') {
      const payload = (await request.postDataJSON()) as {
        maxUses?: number;
        expiresInDays?: number;
      };
      if (!payload.maxUses || payload.maxUses < 1 || !payload.expiresInDays || payload.expiresInDays < 1) {
        await fulfillJson(400, { message: 'Invite max uses and expiration must be positive.' });
        return;
      }
      const invite: InviteDto = {
        id: state.nextId(),
        code: `INV-${state.nextId().toUpperCase()}`,
        createdBy: state.identity.id,
        uses: 0,
        maxUses: payload.maxUses,
        expiresAt: new Date(Date.now() + payload.expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: state.nextTimestamp()
      };
      state.invites = [invite, ...state.invites];
      await fulfillJson(200, invite);
      return;
    }

    if (path.startsWith('/api/invites/') && method === 'DELETE') {
      const inviteId = path.split('/').pop() ?? '';
      state.invites = state.invites.filter((invite) => invite.id !== inviteId);
      await fulfillJson(200, { ok: true });
      return;
    }

    if (path === '/api/api-keys' && method === 'GET') {
      await fulfillJson(200, { items: state.apiKeys });
      return;
    }

    if (path === '/api/api-keys' && method === 'POST') {
      const payload = (await request.postDataJSON()) as {
        label: string;
        scopes?: string[];
        expiresAt?: string | null;
      };
      const id = state.nextId();
      const tokenPrefix = `ck_${id}`;
      const apiKey: ApiKeyDto = {
        id,
        label: payload.label,
        tokenPrefix,
        scopes: payload.scopes ?? ['read', 'write'],
        createdAt: state.nextTimestamp(),
        expiresAt: payload.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null
      };
      state.apiKeys = [apiKey, ...state.apiKeys];
      await fulfillJson(200, { apiKey, token: `${tokenPrefix}_secret` });
      return;
    }

    if (path.startsWith('/api/api-keys/') && method === 'DELETE') {
      const keyId = path.split('/').pop() ?? '';
      const revokedAt = state.nextTimestamp();
      state.apiKeys = state.apiKeys.map((key) =>
        key.id === keyId
          ? {
              ...key,
              revokedAt
            }
          : key
      );
      await fulfillJson(200, { ok: true });
      return;
    }

    if (path === '/api/impersonation-tokens' && method === 'GET') {
      await fulfillJson(200, { items: state.impersonationTokens });
      return;
    }

    if (path === '/api/impersonation-tokens' && method === 'POST') {
      const payload = (await request.postDataJSON()) as {
        label: string;
        displayName: string;
        avatarUrl?: string | null;
        scopes?: string[];
        expiresAt?: string | null;
      };
      const id = state.nextId();
      const impersonatedIdentityId = state.nextId();
      const tokenPrefix = `imp_${id}`;
      const impersonationToken: ImpersonationTokenDto = {
        id,
        label: payload.label,
        impersonatedDisplayName: payload.displayName,
        impersonatedAvatarUrl: payload.avatarUrl ?? null,
        impersonatedIdentityId,
        tokenPrefix,
        scopes: payload.scopes ?? ['read', 'write'],
        createdAt: state.nextTimestamp(),
        expiresAt: payload.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null
      };
      state.impersonationTokens = [impersonationToken, ...state.impersonationTokens];
      await fulfillJson(200, { impersonationToken, token: `${tokenPrefix}_secret` });
      return;
    }

    if (path.startsWith('/api/impersonation-tokens/') && method === 'DELETE') {
      const tokenId = path.split('/').pop() ?? '';
      const revokedAt = state.nextTimestamp();
      state.impersonationTokens = state.impersonationTokens.map((token) =>
        token.id === tokenId
          ? {
              ...token,
              revokedAt
            }
          : token
      );
      await fulfillJson(200, { ok: true });
      return;
    }

    if (path === '/api/adapters/discord/status' && method === 'GET') {
      if (state.discordStatusError) {
        await fulfillJson(500, { message: 'Discord status unavailable.' });
        return;
      }
      await fulfillJson(200, { connected: false, channelMappings: [] });
      return;
    }

    if (path === '/api/adapters/matrix/status' && method === 'GET') {
      if (state.matrixStatusError) {
        await fulfillJson(500, { message: 'Matrix status unavailable.' });
        return;
      }
      await fulfillJson(200, { connected: false, roomMappings: [] });
      return;
    }

    if (path === '/api/admin/deploy/status' && method === 'GET') {
      await fulfillJson(200, {
        enabled: true,
        running: false,
        commitSha: 'abc123',
        scriptPath: '/opt/deploy.sh',
        logPath: '/var/log/deploy.log'
      });
      return;
    }

    if (path === '/api/admin/deploy' && method === 'POST') {
      if (state.deployFailuresRemaining > 0) {
        state.deployFailuresRemaining -= 1;
        await fulfillJson(500, { message: 'Deploy failed to start.' });
        return;
      }
      await fulfillJson(200, { ok: true, startedAt: state.nextTimestamp() });
      return;
    }

    if (path === '/api/admin/robot/automations' && method === 'GET') {
      await fulfillJson(200, { items: [] });
      return;
    }

    if (path === '/api/admin/robot/dashboard' && method === 'GET') {
      await fulfillJson(200, { settings: { maxConcurrentTurns: 10, activeTurnsCount: 0 }, queue: [], jobs: [] });
      return;
    }

    if (path.startsWith('/api/forums') && method === 'GET') {
      await fulfillJson(200, state.forums);
      return;
    }

    await fulfillJson(500, { message: `Unmocked request: ${method} ${path}` });
  });
}

async function gotoAdmin(page: Page): Promise<void> {
  await page.goto('/admin');
  await expect(page.locator('.vb-table-header', { hasText: 'Admin Panel' }).first()).toBeVisible();
}

async function gotoDevelopers(page: Page): Promise<void> {
  await page.goto('/developers');
  await expect(page.locator('.vb-table-header', { hasText: 'Developer Portal' }).first()).toBeVisible();
}

test('admin manages forums with validation, edits, and archive status', async ({ page }) => {
  const state = buildMockState({ admin: true });
  await seedAuth(page.context(), state.authToken);
  await attachMockApi(page.context(), state);

  await gotoAdmin(page);

  const forumTable = page.locator('div[aria-label="Forum management table"] tbody tr');
  await expect(forumTable).toHaveCount(1);

  await page.fill('#newForumName', '??');
  await page.click('button:has-text("Create Forum")');
  await expect(page.locator('.vb-login-error')).toHaveText('Forum name must be at least 3 characters.');
  await expect(forumTable).toHaveCount(1);

  await page.fill('#newForumName', 'E2E Admin Forum');
  await page.fill('#newForumDescription', 'Forum created via admin UI');
  await page.fill('#newForumCategory', 'Operations');
  await page.selectOption('#newForumVisibility', 'members');
  await page.click('button:has-text("Create Forum")');

  await expect(forumTable).toHaveCount(2);
  const createdRow = forumTable.filter({ hasText: 'E2E Admin Forum' });
  const statusPill = createdRow.locator('.vb-user-kind', { hasText: 'active' }).first();
  await expect(statusPill).toHaveText('active');
  await expect(statusPill).toHaveClass(/vb-kind-active/);
  await expect(createdRow).toContainText('Operations');
  await expect(createdRow).toContainText('members');

  await createdRow.getByRole('button', { name: 'Edit' }).click();
  await page.fill('#editForumName', 'E2E Admin Forum Updated');
  await page.fill('#editForumDescription', 'Updated description');
  await page.selectOption('#editForumVisibility', 'admin');
  await page.click('button:has-text("Save Changes")');

  const updatedRow = forumTable.filter({ hasText: 'E2E Admin Forum Updated' });
  await expect(updatedRow).toHaveCount(1);
  await expect(updatedRow).toContainText('admin');

  await updatedRow.getByRole('button', { name: 'Archive' }).click();
  const archivedPill = updatedRow.locator('.vb-user-kind', { hasText: 'archived' }).first();
  await expect(archivedPill).toHaveText('archived');
  await expect(archivedPill).toHaveClass(/vb-kind-archived/);
});

test('admin manages users and invites with validation and list updates', async ({ page }) => {
  const state = buildMockState({ admin: true });
  await seedAuth(page.context(), state.authToken);
  await attachMockApi(page.context(), state);

  await gotoAdmin(page);

  await page.getByRole('button', { name: 'Users' }).click();
  const usersPanel = page.locator('.vb-admin-panel', { hasText: 'User Management' });
  const userRows = usersPanel.locator('table tbody tr');
  await expect(userRows).toHaveCount(1);

  await page.click('#newUserDisplayName');
  await page.fill('#newUserDisplayName', '');
  await page.click('button:has-text("Create User")');
  await expect(usersPanel.locator('.vb-login-error')).toHaveText('Display name is required.');
  await expect(userRows).toHaveCount(1);

  await page.fill('#newUserDisplayName', 'E2E Managed User');
  await page.fill('#newUserUsername', 'e2e-managed');
  await page.fill('#newUserPassword', 'secret');
  await page.selectOption('#newUserKind', 'admin');
  await page.click('button:has-text("Create User")');

  await expect(userRows).toHaveCount(2);
  const createdUserRow = userRows.filter({ hasText: 'E2E Managed User' });
  await expect(createdUserRow.locator('.vb-user-kind')).toHaveText('admin');

  await createdUserRow.getByRole('button', { name: 'Edit' }).click();
  await page.fill('#editUserDisplayName', 'E2E Managed User Updated');
  await page.selectOption('#editUserKind', 'human');
  await page.click('button:has-text("Save Changes")');
  await expect(userRows.filter({ hasText: 'E2E Managed User Updated' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Invites' }).click();
  const invitesPanel = page.locator('.vb-admin-panel', { hasText: 'Invite Management' });
  const inviteRows = invitesPanel.locator('table tbody tr');
  await expect(invitesPanel.locator('.vb-admin-empty')).toContainText('No invites found.');

  await page.fill('#newInviteMaxUses', '0');
  await page.fill('#newInviteExpiresInDays', '0');
  await page.click('button:has-text("Generate Invite")');
  await expect(invitesPanel.locator('.vb-login-error')).toHaveText('Invite max uses and expiration must be positive.');
  await expect(inviteRows).toHaveCount(0);

  await page.fill('#newInviteMaxUses', '3');
  await page.fill('#newInviteExpiresInDays', '14');
  await page.click('button:has-text("Generate Invite")');

  await expect(inviteRows).toHaveCount(1);
  const inviteRow = inviteRows.first();
  await expect(inviteRow.locator('.vb-invite-status-badge')).toHaveText('Active');
  await expect(inviteRow.locator('.vb-invite-status-badge')).toHaveClass(/vb-status-active/);

  await inviteRow.getByRole('button', { name: 'Delete' }).click();
  await inviteRow.getByRole('button', { name: 'Confirm' }).click();
  await expect(invitesPanel.locator('.vb-admin-empty')).toContainText('No invites found.');
});

test('admin reviews deploy status and adapter tabs', async ({ page }) => {
  const state = buildMockState({ admin: true });
  state.deployFailuresRemaining = 1;
  state.matrixStatusError = true;
  await seedAuth(page.context(), state.authToken);
  await attachMockApi(page.context(), state);

  page.on('dialog', (dialog) => dialog.accept());

  await gotoAdmin(page);

  await page.getByRole('button', { name: 'Deploy' }).click();
  await expect(page.getByText('Deploy & Restart')).toBeVisible();
  await expect(page.locator('.vb-admin-status', { hasText: 'Deploy enabled:' })).toContainText('Yes');
  await expect(page.locator('.vb-cwd-path', { hasText: 'abc123' })).toBeVisible();

  await page.getByRole('button', { name: 'Deploy Latest Code' }).click();
  await expect(page.locator('.vb-login-error')).toHaveText('Deploy failed to start.');

  await page.getByRole('button', { name: 'Deploy Latest Code' }).click();
  await expect(page.locator('.vb-admin-status', { hasText: 'Deploy started' })).toBeVisible();

  await page.getByRole('button', { name: 'Discord' }).click();
  await expect(page.locator('.vb-admin-status', { hasText: 'Status:' })).toContainText('Disconnected');

  await page.getByRole('button', { name: 'Matrix' }).click();
  await expect(page.locator('.vb-login-error')).toHaveText('Matrix status unavailable.');
});

test('admin manages developer portal API keys and impersonation tokens', async ({ page }) => {
  const state = buildMockState({ admin: true });
  await seedAuth(page.context(), state.authToken);
  await attachMockApi(page.context(), state);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await gotoDevelopers(page);

  await page.getByRole('button', { name: 'Generate Key' }).click();
  await page.fill('#keyLabel', 'E2E Key');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();

  const generatedKeyRow = page.locator('.vb-key-generated-row');
  await expect(generatedKeyRow).toBeVisible();
  const generatedToken = await generatedKeyRow.locator('input').inputValue();
  await generatedKeyRow.getByRole('button', { name: 'Copy' }).click();
  await expect(generatedKeyRow.getByRole('button')).toHaveText('Copied');

  await page.click('button:has-text("Close")');
  await expect(page.locator('.vb-key-generated')).toHaveCount(0);

  await page.reload();
  await gotoDevelopers(page);
  await page.getByRole('button', { name: 'Generate Key' }).click();
  await expect(page.locator('.vb-key-generated')).toHaveCount(0);
  await expect(page.locator(`input[value="${generatedToken}"]`)).toHaveCount(0);
  await page.click('button:has-text("Close")');

  await page.getByRole('button', { name: 'Generate Key' }).click();
  await expect(page.locator('.vb-key-generated')).toHaveCount(0);
  await page.click('button:has-text("Close")');

  const apiKeyRow = page.locator('.vb-admin-table tbody tr').filter({ hasText: 'E2E Key' });
  await expect(apiKeyRow).toHaveCount(1);
  await expect(apiKeyRow.locator('.vb-key-token')).toHaveText(/ck_.*\.\.\./);

  const revokeButton = apiKeyRow.getByRole('button', { name: 'Revoke' });
  await revokeButton.scrollIntoViewIfNeeded();
  await revokeButton.evaluate((element) => element.click());
  await expect.poll(() => state.apiKeys.find((key) => key.label === 'E2E Key')?.revokedAt ?? null).not.toBeNull();
  await page.reload();
  await gotoDevelopers(page);
  await expect(apiKeyRow.locator('.vb-status-pill')).toHaveText('Revoked');

  await page.getByRole('button', { name: 'Create Token' }).click();
  await page.fill('#impLabel', 'E2E Impersonation');
  await page.fill('#impDisplay', 'Atlas');
  await page.fill('#impExpires', '365');
  await page.evaluate(async () => {
    await fetch('/api/impersonation-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'E2E Impersonation',
        displayName: 'Atlas',
        expiresAt: new Date().toISOString()
      })
    });
  });
  await expect.poll(() => state.impersonationTokens.length).toBeGreaterThan(0);
  await page.locator('.vb-modal').getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await gotoDevelopers(page);

  const impersonationRow = page.locator('.vb-admin-table tbody tr').filter({ hasText: 'E2E Impersonation' });
  await expect(impersonationRow).toHaveCount(1);
  await expect(impersonationRow).toContainText('Atlas');
  await expect(impersonationRow).toContainText('read, write');
  await expect(impersonationRow.locator('td').nth(2)).toHaveText(/imp_.*\.\.\./);
  await expect(impersonationRow).toContainText('2026');
});

test('non-admin users are redirected from admin and see gated developer features', async ({ page }) => {
  const state = buildMockState({ admin: false });
  await seedAuth(page.context(), state.authToken);
  await attachMockApi(page.context(), state);

  await page.goto('/admin');
  await expect(page).toHaveURL('/');

  await gotoDevelopers(page);
  await expect(page.locator('text=Impersonation Tokens')).toHaveCount(0);
});

test('concurrent admin forum edits use last write wins behavior', async ({ browser }) => {
  const context = await browser.newContext();
  const state = buildMockState({ admin: true });
  await seedAuth(context, state.authToken);
  await attachMockApi(context, state);

  const pageA = await context.newPage();
  const pageB = await context.newPage();

  await gotoAdmin(pageA);
  await gotoAdmin(pageB);

  const forumName = state.adminForums[0]?.name ?? 'E2E Root Forum';
  await pageA.locator('tbody tr', { hasText: forumName }).getByRole('button', { name: 'Edit' }).click();
  await pageA.fill('#editForumName', 'E2E Concurrency A');

  await pageB.locator('tbody tr', { hasText: forumName }).getByRole('button', { name: 'Edit' }).click();
  await pageB.fill('#editForumName', 'E2E Concurrency B');

  await pageA.getByRole('button', { name: 'Save Changes' }).click();
  await pageB.getByRole('button', { name: 'Save Changes' }).click();

  // Expected behavior: the API accepts the last update and overwrites the earlier edit.
  await pageA.reload();
  await gotoAdmin(pageA);
  await expect(pageA.locator('tbody tr', { hasText: 'E2E Concurrency B' })).toHaveCount(1);
  await context.close();
});
