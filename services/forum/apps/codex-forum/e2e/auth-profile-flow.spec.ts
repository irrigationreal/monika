import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import type { AuthIdentityDto, IdentityDto, InviteInfoDto, RegistrationModeDto } from '@irrigationreal/codex-forum-contracts';

type IdentityRecord = IdentityDto & {
  username?: string;
  password?: string;
};

type InviteRecord = InviteInfoDto & {
  remainingUses: number;
};

type VerificationRecord = {
  identityId: string;
  expiresAt: string;
  used: boolean;
};

type MockResponse = {
  status: number;
  body?: unknown;
};

class MockAuthApi {
  private identityCounter = 1;
  private tokenCounter = 1;
  private identities = new Map<string, IdentityRecord>();
  private identitiesByUsername = new Map<string, IdentityRecord>();
  private sessions = new Map<string, string>();
  private refreshSessions = new Map<string, string>();
  private invites = new Map<string, InviteRecord>();
  private verificationTokens = new Map<string, VerificationRecord>();
  private baseUrl: string;
  private refreshCallCount = 0;
  private registrationMode: RegistrationModeDto['mode'];

  constructor(baseUrl: string, registrationMode: RegistrationModeDto['mode'] = 'public') {
    this.baseUrl = baseUrl;
    this.registrationMode = registrationMode;
  }

  createInvite(code = `INVITE-${this.identityCounter}`): InviteRecord {
    const record: InviteRecord = { code, valid: true, remainingUses: 3, expiresAt: null };
    this.invites.set(code, record);
    return record;
  }

  createVerifiedIdentity(displayName: string, username: string, password: string): IdentityRecord {
    const identity = this.createIdentity(displayName, username, password);
    return identity;
  }

  createPendingIdentity(displayName: string): { identity: IdentityRecord; verifyUrl: string } {
    const identity = this.createIdentity(displayName);
    const token = this.issueVerificationToken(identity.id);
    return { identity, verifyUrl: new URL(`/verify/${token}`, this.baseUrl).toString() };
  }

  getIdentityByDisplayName(displayName: string): IdentityRecord | null {
    for (const identity of this.identities.values()) {
      if (identity.displayName === displayName) return identity;
    }
    return null;
  }

  get refreshCalls(): number {
    return this.refreshCallCount;
  }

  async handle(request: Request): Promise<MockResponse> {
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method().toUpperCase();

    if (method === 'GET' && path === '/forums') {
      return { status: 200, body: [] };
    }

    if (method === 'GET' && path === '/posts/recent') {
      return { status: 200, body: [] };
    }

    if (method === 'GET' && path === '/auth/registration') {
      return {
        status: 200,
        body: {
          mode: this.registrationMode,
          registrationEnabled: this.registrationMode !== 'disabled',
          inviteRegistrationEnabled: this.registrationMode !== 'disabled',
          publicRegistrationEnabled: this.registrationMode === 'public'
        } satisfies RegistrationModeDto
      };
    }

    if (method === 'GET' && path.startsWith('/auth/invite/')) {
      const code = decodeURIComponent(path.split('/').pop() ?? '');
      const invite = this.invites.get(code);
      if (!invite || invite.remainingUses <= 0) {
        return { status: 404, body: { message: 'Invite not found' } };
      }
      return {
        status: 200,
        body: {
          code: invite.code,
          valid: true,
          remainingUses: invite.remainingUses,
          expiresAt: invite.expiresAt
        }
      };
    }

    if (method === 'POST' && path === '/auth/register') {
      const body = (await request.postDataJSON()) as {
        displayName?: string;
        username?: string;
        password?: string;
        inviteCode?: string;
      };
      if (!body?.displayName) {
        return { status: 400, body: { message: 'displayName is required' } };
      }
      if (body.inviteCode) {
        const invite = this.invites.get(body.inviteCode);
        if (!invite || invite.remainingUses <= 0) {
          return { status: 400, body: { message: 'Invalid invite code' } };
        }
        if (!body.username || !body.password) {
          return { status: 400, body: { message: 'Username and password are required for invite registration' } };
        }
        invite.remainingUses -= 1;
        const identity = this.createIdentity(body.displayName, body.username, body.password);
        const session = this.issueSession(identity.id);
        return {
          status: 200,
          body: { ...session, identity: this.toAuthIdentity(identity) }
        };
      }

      const identity = this.createIdentity(body.displayName);
      const token = this.issueVerificationToken(identity.id);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      this.verificationTokens.set(token, { identityId: identity.id, expiresAt, used: false });
      return {
        status: 200,
        body: {
          identity: this.toAuthIdentity(identity),
          verifyUrl: new URL(`/verify/${token}`, this.baseUrl).toString(),
          expiresAt,
          emailSent: false
        }
      };
    }

    if (method === 'GET' && path.startsWith('/auth/verify/')) {
      const token = decodeURIComponent(path.split('/').pop() ?? '');
      const verification = this.verificationTokens.get(token);
      if (!verification || verification.used || new Date() > new Date(verification.expiresAt)) {
        return { status: 400, body: { message: 'Invalid or expired verification link' } };
      }
      verification.used = true;
      const identity = this.identities.get(verification.identityId);
      if (!identity) {
        return { status: 404, body: { message: 'User not found' } };
      }
      const session = this.issueSession(identity.id);
      return { status: 200, body: { ...session, identity: this.toAuthIdentity(identity) } };
    }

    if (method === 'POST' && path === '/auth/login') {
      const body = (await request.postDataJSON()) as { username?: string; password?: string };
      if (!body?.username || !body?.password) {
        return { status: 400, body: { message: 'username and password are required' } };
      }
      const identity = this.identitiesByUsername.get(body.username);
      if (!identity || identity.password !== body.password) {
        return { status: 401, body: { message: 'Invalid credentials' } };
      }
      const session = this.issueSession(identity.id);
      return { status: 200, body: { ...session, identity: this.toAuthIdentity(identity) } };
    }

    if (method === 'POST' && path === '/auth/logout') {
      const authHeader = request.headers()['authorization'];
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        this.sessions.delete(token);
      }
      const refresh = request.headers()['x-refresh-token'];
      if (refresh) {
        this.refreshSessions.delete(Array.isArray(refresh) ? refresh[0] : refresh);
      }
      return { status: 200, body: { ok: true } };
    }

    if (method === 'POST' && path === '/auth/refresh') {
      this.refreshCallCount += 1;
      const refresh = request.headers()['x-refresh-token'];
      const refreshToken = Array.isArray(refresh) ? refresh[0] : refresh;
      if (!refreshToken || !this.refreshSessions.has(refreshToken)) {
        return { status: 401, body: { message: 'Invalid refresh token' } };
      }
      const identityId = this.refreshSessions.get(refreshToken) ?? '';
      const session = this.issueSession(identityId);
      return { status: 200, body: session };
    }

    if (method === 'GET' && path === '/auth/me') {
      const identity = this.getIdentityFromAuth(request);
      if (!identity) {
        return { status: 200, body: { identity: null } };
      }
      return { status: 200, body: { identity: this.toAuthIdentity(identity, true) } };
    }

    if (method === 'PATCH' && path.startsWith('/identities/')) {
      const identityId = path.split('/')[2];
      const identity = this.identities.get(identityId);
      if (!identity) {
        return { status: 404, body: { message: 'identity not found' } };
      }
      if (!this.getIdentityFromAuth(request)) {
        return { status: 401, body: { message: 'Please log in to continue.' } };
      }
      const updates = (await request.postDataJSON()) as Partial<
        Pick<IdentityRecord, 'displayName' | 'avatarUrl' | 'location' | 'signature' | 'theme'>
      >;
      if (updates.displayName !== undefined) identity.displayName = updates.displayName;
      if (updates.avatarUrl !== undefined) identity.avatarUrl = updates.avatarUrl ?? null;
      if (updates.location !== undefined) identity.location = updates.location ?? null;
      if (updates.signature !== undefined) identity.signature = updates.signature ?? null;
      if (updates.theme !== undefined) identity.theme = updates.theme ?? null;
      identity.updatedAt = new Date().toISOString();
      return { status: 200, body: this.toIdentityDto(identity) };
    }

    if (method === 'POST' && path.endsWith('/avatar')) {
      const identityId = path.split('/')[2];
      const identity = this.identities.get(identityId);
      if (!identity) {
        return { status: 404, body: { message: 'identity not found' } };
      }
      if (!this.getIdentityFromAuth(request)) {
        return { status: 401, body: { message: 'Please log in to continue.' } };
      }
      identity.avatarUrl = `https://cdn.example.test/avatars/${identityId}.png`;
      identity.updatedAt = new Date().toISOString();
      return {
        status: 200,
        body: {
          id: identity.id,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          message: 'Avatar updated.'
        }
      };
    }

    if (method === 'GET' && path.startsWith('/identities/') && path.endsWith('/permissions')) {
      return { status: 200, body: { permissions: [] } };
    }

    if (method === 'GET' && path.startsWith('/profiles/') && path.endsWith('/posts')) {
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 25);
      return { status: 200, body: { page, pageSize, total: 0, items: [] } };
    }

    if (method === 'GET' && path.startsWith('/profiles/')) {
      const identityId = path.split('/')[2];
      const identity = this.identities.get(identityId);
      if (!identity) {
        return { status: 404, body: { message: 'Profile not found' } };
      }
      return { status: 200, body: this.toIdentityDto(identity) };
    }

    return { status: 404, body: { message: 'Unmocked request' } };
  }

  private createIdentity(displayName: string, username?: string, password?: string): IdentityRecord {
    const id = `identity-${this.identityCounter++}`;
    const now = new Date().toISOString();
    const identity: IdentityRecord = {
      id,
      tenantId: null,
      displayName,
      kind: 'human',
      parentIdentityId: null,
      username,
      password,
      avatarUrl: null,
      location: null,
      signature: null,
      theme: null,
      postCount: 0,
      rank: 'Member',
      joinDate: now,
      createdAt: now,
      updatedAt: now
    };
    this.identities.set(id, identity);
    if (username) {
      this.identitiesByUsername.set(username, identity);
    }
    return identity;
  }

  private issueVerificationToken(identityId: string): string {
    const token = `verify-${this.tokenCounter++}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    this.verificationTokens.set(token, { identityId, expiresAt, used: false });
    return token;
  }

  private issueSession(identityId: string): { token: string; refreshToken: string } {
    const token = `token-${this.tokenCounter++}`;
    const refreshToken = `refresh-${this.tokenCounter++}`;
    this.sessions.set(token, identityId);
    this.refreshSessions.set(refreshToken, identityId);
    return { token, refreshToken };
  }

  private getIdentityFromAuth(request: Request): IdentityRecord | null {
    const authHeader = request.headers()['authorization'];
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const identityId = this.sessions.get(token);
    if (!identityId) return null;
    return this.identities.get(identityId) ?? null;
  }

  private toAuthIdentity(identity: IdentityRecord, includePrivate = false): AuthIdentityDto {
    return {
      id: identity.id,
      displayName: identity.displayName,
      kind: identity.kind,
      parentIdentityId: identity.parentIdentityId ?? null,
      avatarUrl: identity.avatarUrl,
      location: identity.location,
      signature: identity.signature,
      theme: identity.theme,
      hasPrivateEmail: includePrivate ? false : undefined
    };
  }

  private toIdentityDto(identity: IdentityRecord): IdentityDto {
    return {
      id: identity.id,
      tenantId: identity.tenantId ?? null,
      displayName: identity.displayName,
      kind: identity.kind,
      parentIdentityId: identity.parentIdentityId ?? null,
      avatarUrl: identity.avatarUrl,
      location: identity.location,
      signature: identity.signature,
      theme: identity.theme,
      postCount: identity.postCount,
      rank: identity.rank,
      joinDate: identity.joinDate,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt
    };
  }
}

async function attachMockApi(context: BrowserContext, api: MockAuthApi): Promise<void> {
  await context.route('**/api/**', async (route) => {
    const response = await api.handle(route.request());
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(response.body ?? {})
    });
  });
}

const avatarPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
  'base64'
);

test.describe('Auth registration and profile flows', () => {
  test('registers without invite, verifies, and updates profile details', async ({ page }) => {
    const baseUrl = test.info().project.use.baseURL ?? 'http://localhost:5173';
    const api = new MockAuthApi(baseUrl);
    await attachMockApi(page.context(), api);

    await page.goto('/register');
    await page.locator('#displayName').fill('Riley Walker');
    await page.locator('.vb-modal-actions .vb-btn', { hasText: 'Register' }).click();

    const verifyLink = page.locator('.vb-verify-link a');
    await expect(verifyLink).toBeVisible();
    await expect(page.locator('.vb-register-success')).toContainText('Registration Successful');

    await verifyLink.click();
    await expect(page).toHaveURL(/\/verify\//);
    await expect(page.locator('.vb-verify-success')).toContainText('Verification Successful');

    await page.locator('button', { hasText: 'Go to Forum Now' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.locator('.vb-welcome')).toContainText('Riley Walker');
    await expect(page.locator('.vb-welcome-links')).toContainText('Log Out');

    await page.reload();
    await expect(page.locator('.vb-welcome')).toContainText('Riley Walker');

    await page.locator('.vb-welcome-links a', { hasText: 'User CP' }).click();
    await expect(page).toHaveURL('/profile');
    await expect(page.locator('.vb-table-header')).toContainText('User Control Panel');

    await page.setInputFiles('input[type="file"]', {
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: avatarPng
    });
    await page.locator('button', { hasText: 'Upload' }).click();
    await expect(page.locator('.vb-success-banner')).toContainText('Avatar updated.');
    await expect(page.locator('.vb-avatar-large')).toHaveAttribute('src', /cdn\.example\.test/);

    await page.locator('button', { hasText: 'Edit Profile' }).click();
    const displayNameInput = page.locator('#editDisplayName');
    await displayNameInput.fill('');
    await expect(page.locator('button', { hasText: 'Save Changes' })).toBeDisabled();

    await displayNameInput.fill('Riley Updated');
    await page.locator('#editLocation').fill('Seattle, WA');
    await page.locator('#editSignature').fill('See you in the threads.');
    await page.locator('#editTheme').selectOption('classic-dark');

    await page.locator('button', { hasText: 'Save Changes' }).click();
    await expect(page.locator('.vb-success-banner')).toContainText('Profile updated successfully.');
    await expect(page.locator('.vb-profile-row', { hasText: 'Display Name:' })).toContainText('Riley Updated');
    await expect(page.locator('.vb-profile-row', { hasText: 'Location:' })).toContainText('Seattle, WA');
    await expect(page.locator('.vb-profile-row', { hasText: 'Signature:' })).toContainText('See you in the threads.');
    await expect(page.locator('.vb-profile-row', { hasText: 'Theme:' })).toContainText('Classic RoboBB');
    await expect(page.locator('.vb-welcome')).toContainText('Riley Updated');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic-dark');
    await expect(page.locator('.vb-theme-toggle')).toHaveAttribute('title', 'Theme: Classic RoboBB (Dark)');

    await page.reload();
    await expect(page.locator('.vb-profile-row', { hasText: 'Display Name:' })).toContainText('Riley Updated');
    await expect(page.locator('.vb-profile-row', { hasText: 'Location:' })).toContainText('Seattle, WA');
    await expect(page.locator('.vb-profile-row', { hasText: 'Signature:' })).toContainText('See you in the threads.');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic-dark');

    const identityId = api.getIdentityByDisplayName('Riley Updated')?.id ?? '';
    await page.goto(`/users/${identityId}`);
    await expect(page.locator('.vb-table-header')).toContainText('User Profile');
    await expect(page.locator('.vb-profile-name')).toContainText('Riley Updated');
    await expect(page.locator('.vb-profile-row', { hasText: 'Location' })).toContainText('Seattle, WA');
    await expect(page.locator('.vb-profile-row', { hasText: 'Signature' })).toContainText('See you in the threads.');
    await expect(page.locator('.vb-profile-row', { hasText: 'Theme' })).toContainText('classic-dark');
    await expect(page.locator('.vb-profile-avatar')).toHaveAttribute('src', /cdn\.example\.test/);

    await page.locator('.vb-nav-item', { hasText: 'Forum Home' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.locator('.vb-welcome')).toContainText('Riley Updated');

    await page.locator('.vb-welcome-links a', { hasText: 'User CP' }).click();
    await page.locator('button', { hasText: 'Edit Profile' }).click();
    await page.evaluate(() => {
      localStorage.setItem('cforum_auth_token', 'expired-token');
    });
    await page.locator('#editLocation').fill('Portland, OR');
    await page.locator('button', { hasText: 'Save Changes' }).click();
    await expect(page.locator('.vb-profile-row', { hasText: 'Location:' })).toContainText('Portland, OR');
    expect(api.refreshCalls).toBeGreaterThan(0);
  });

  test('disabled registration hides register UI and shows closed state', async ({ page }) => {
    const baseUrl = test.info().project.use.baseURL ?? 'http://localhost:5173';
    const api = new MockAuthApi(baseUrl, 'disabled');
    await attachMockApi(page.context(), api);

    await page.goto('/');
    await expect(page.locator('.vb-welcome-links').getByText('Register', { exact: true })).toHaveCount(0);
    await expect(page.locator('.vb-nav').getByText('Register', { exact: true })).toHaveCount(0);

    await page.goto('/register');
    await expect(page.locator('.vb-register-form')).toContainText('Registration Closed');
    await expect(page.locator('#displayName')).toHaveCount(0);
    await expect(page.getByText('Public account registration is currently closed')).toBeVisible();
  });

  test('invite-only registration requires a valid invite before credential signup', async ({ page }) => {
    const baseUrl = test.info().project.use.baseURL ?? 'http://localhost:5173';
    const api = new MockAuthApi(baseUrl, 'invite-only');
    const invite = api.createInvite('INVITE-ONLY');
    await attachMockApi(page.context(), api);

    await page.goto('/register');
    await expect(page.locator('.vb-register-note-top')).toContainText('Registration is invite-only');
    await page.locator('#displayName').fill('Invite Only Tester');
    await page.locator('.vb-modal-actions .vb-btn', { hasText: 'Register' }).click();
    await expect(page.locator('.vb-login-error')).toContainText('Please enter a valid invite code.');

    await page.locator('#inviteCode').fill(invite.code);
    await expect(page.locator('.vb-invite-status.vb-valid')).toBeVisible();
    await expect(page.locator('#username')).toBeVisible();
    await page.locator('#username').fill('invite-only-user');
    await page.locator('#password').fill('password123');
    await page.locator('#confirmPassword').fill('password123');
    await page.locator('.vb-modal-actions .vb-btn', { hasText: 'Register' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.vb-welcome-main')).toContainText('Invite Only Tester');
  });

  test('invite registration and login modal error handling', async ({ page }) => {
    const baseUrl = test.info().project.use.baseURL ?? 'http://localhost:5173';
    const api = new MockAuthApi(baseUrl);
    const invite = api.createInvite('INVITE-123');
    await attachMockApi(page.context(), api);

    await page.goto('/');
    await page.locator('.vb-link-btn', { hasText: 'Log In' }).click();
    await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await expect(page.locator('.vb-modal .vb-login-error')).toContainText('Please enter username and password');
    await expect(page.locator('.vb-welcome')).toContainText('Guest_User');

    await page.goto('/register');
    await page.locator('#displayName').fill('Invite Tester');
    await page.locator('#inviteCode').fill(invite.code);
    await expect(page.locator('.vb-invite-status.vb-valid')).toBeVisible();
    await page.locator('#username').fill('invite-user');
    await page.locator('.vb-modal-actions .vb-btn', { hasText: 'Register' }).click();
    await expect(page.locator('.vb-login-error')).toContainText('Please enter a password.');

    await page.locator('#password').fill('supersecret');
    await page.locator('#confirmPassword').fill('supersecret');
    await page.locator('.vb-modal-actions .vb-btn', { hasText: 'Register' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.locator('.vb-welcome')).toContainText('Invite Tester');

    await page.locator('.vb-link-btn', { hasText: 'Log Out' }).click();
    await expect(page.locator('.vb-welcome')).toContainText('Guest_User');
    await expect(page.evaluate(() => localStorage.getItem('cforum_auth_token'))).resolves.toBeNull();
    await expect(page.evaluate(() => localStorage.getItem('cforum_refresh_token'))).resolves.toBeNull();

    await page.locator('.vb-link-btn', { hasText: 'Log In' }).click();
    await page.locator('.vb-modal input[type="text"]').fill('invite-user');
    await page.locator('.vb-modal input[type="password"]').fill('wrongpass');
    await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await expect(page.locator('.vb-modal .vb-login-error')).toContainText('Invalid credentials');
    await expect(page.locator('.vb-welcome')).toContainText('Guest_User');

    await page.locator('.vb-modal input[type="password"]').fill('supersecret');
    await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await expect(page.locator('.vb-welcome')).toContainText('Invite Tester');
  });

  test('shows verification errors and redirects profile when logged out', async ({ page }) => {
    const baseUrl = test.info().project.use.baseURL ?? 'http://localhost:5173';
    const api = new MockAuthApi(baseUrl);
    await attachMockApi(page.context(), api);

    await page.goto('/verify/expired-token');
    await expect(page.locator('.vb-verify-error')).toBeVisible();
    await expect(page.locator('.vb-verify-error .vb-login-error')).toContainText(
      'This verification link is invalid or has expired.'
    );

    await page.goto('/profile');
    await expect(page).toHaveURL('/');
    await expect(page.locator('.vb-welcome')).toContainText('Guest_User');
  });

  test('keeps parallel sessions consistent after refresh', async ({ browser }) => {
    const baseUrl = test.info().project.use.baseURL ?? 'http://localhost:5173';
    const api = new MockAuthApi(baseUrl);
    api.createVerifiedIdentity('Parallel User', 'parallel-user', 'sharedpass');

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    await attachMockApi(contextA, api);
    await attachMockApi(contextB, api);

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto('/');
    await pageB.goto('/');

    await pageA.locator('.vb-link-btn', { hasText: 'Log In' }).click();
    await pageA.locator('.vb-modal input[type="text"]').fill('parallel-user');
    await pageA.locator('.vb-modal input[type="password"]').fill('sharedpass');
    await pageA.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await expect(pageA.locator('.vb-welcome')).toContainText('Parallel User');

    await pageB.locator('.vb-link-btn', { hasText: 'Log In' }).click();
    await pageB.locator('.vb-modal input[type="text"]').fill('parallel-user');
    await pageB.locator('.vb-modal input[type="password"]').fill('sharedpass');
    await pageB.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await expect(pageB.locator('.vb-welcome')).toContainText('Parallel User');

    await pageA.locator('.vb-welcome-links a', { hasText: 'User CP' }).click();
    await pageA.locator('button', { hasText: 'Edit Profile' }).click();
    await pageA.locator('#editDisplayName').fill('Parallel Updated');
    await pageA.locator('button', { hasText: 'Save Changes' }).click();
    await expect(pageA.locator('.vb-welcome')).toContainText('Parallel Updated');

    // Second session remains stale until it refreshes.
    await expect(pageB.locator('.vb-welcome')).toContainText('Parallel User');
    await pageB.reload();
    await expect(pageB.locator('.vb-welcome')).toContainText('Parallel Updated');

    await contextA.close();
    await contextB.close();
  });
});
