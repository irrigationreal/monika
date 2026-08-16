import { expect, test } from '@playwright/test';

import type {
  AuthIdentityDto,
  IdentityDto,
  InviteInfoDto,
  RegistrationModeDto,
} from '@irrigationreal/codex-forum-contracts';
import type { BrowserContext, Page, Request } from '@playwright/test';

type IdentityRecord = IdentityDto & {
  username?: string;
  password?: string;
  quickReplyDockedByDefault?: boolean;
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
  headers?: Record<string, string>;
};

class MockAuthApi {
  private identityCounter = 1;
  private tokenCounter = 1;
  private identities = new Map<string, IdentityRecord>();
  private identitiesByUsername = new Map<string, IdentityRecord>();
  private sessions = new Map<string, string>();
  private invites = new Map<string, InviteRecord>();
  private verificationTokens = new Map<string, VerificationRecord>();
  private notepadEntries: Array<{
    id: string;
    contentFormat: 'plaintext-v1';
    title: string | null;
    body: string;
    tags: string[];
    pinned: boolean;
    revision: number;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
  }> = [];
  private baseUrl: string;
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

  setNotepadBody(body: string): void {
    const now = new Date().toISOString();
    this.notepadEntries = [
      {
        id: 'note-rendering-fixture',
        contentFormat: 'plaintext-v1',
        title: 'Rendering fixture',
        body,
        tags: ['fixture'],
        pinned: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
      },
    ];
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
          publicRegistrationEnabled: this.registrationMode === 'public',
          passwordLoginEnabled: true,
        } satisfies RegistrationModeDto,
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
          expiresAt: invite.expiresAt,
        },
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
          headers: this.sessionHeaders(session),
          body: { identity: this.toAuthIdentity(identity) },
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
          emailSent: false,
        },
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
      return { status: 200, headers: this.sessionHeaders(session), body: { identity: this.toAuthIdentity(identity) } };
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
      return { status: 200, headers: this.sessionHeaders(session), body: { identity: this.toAuthIdentity(identity) } };
    }

    if (method === 'POST' && path === '/auth/logout') {
      const token = this.getSessionToken(request);
      if (token) this.sessions.delete(token);
      return { status: 200, headers: { 'set-cookie': 'cforum_session=; Path=/; Max-Age=0' }, body: { ok: true } };
    }

    if (method === 'GET' && path === '/me/webauthn/credentials') {
      return { status: this.getIdentityFromAuth(request) ? 200 : 401, body: { items: [] } };
    }

    if (method === 'GET' && path === '/notepad/draft') {
      return this.getIdentityFromAuth(request)
        ? { status: 200, body: { draft: null } }
        : { status: 401, body: { message: 'Please log in to continue.' } };
    }

    if (method === 'GET' && path === '/notepad') {
      return this.getIdentityFromAuth(request)
        ? {
            status: 200,
            body: { entries: this.notepadEntries, tags: [{ tag: 'fixture', count: 1 }], nextCursor: null },
          }
        : { status: 401, body: { message: 'Please log in to continue.' } };
    }

    if (method === 'GET' && path === '/auth/me') {
      const identity = this.getIdentityFromAuth(request);
      if (!identity) {
        return { status: 200, body: { identity: null } };
      }
      return { status: 200, body: { identity: this.toAuthIdentity(identity, true) } };
    }

    if (method === 'PATCH' && path === '/me/preferences/quick-reply') {
      const identity = this.getIdentityFromAuth(request);
      if (!identity) return { status: 401, body: { message: 'Please log in to continue.' } };
      const body = (await request.postDataJSON()) as { quickReplyDockedByDefault?: boolean };
      identity.quickReplyDockedByDefault = Boolean(body.quickReplyDockedByDefault);
      return {
        status: 200,
        body: { ok: true, quickReplyDockedByDefault: identity.quickReplyDockedByDefault },
      };
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
          message: 'Avatar updated.',
        },
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
      updatedAt: now,
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

  private issueSession(identityId: string): string {
    const token = `token-${this.tokenCounter++}`;
    this.sessions.set(token, identityId);
    return token;
  }

  private sessionHeaders(token: string): Record<string, string> {
    return { 'set-cookie': `cforum_session=${token}; Path=/; HttpOnly; SameSite=Lax` };
  }

  private getSessionToken(request: Request): string | null {
    const cookie = request.headers()['cookie'] ?? '';
    return (
      cookie
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('cforum_session='))
        ?.slice(15) ?? null
    );
  }

  private getIdentityFromAuth(request: Request): IdentityRecord | null {
    const token = this.getSessionToken(request);
    if (!token) return null;
    const identityId = this.sessions.get(token);
    if (!identityId) return null;
    return this.identities.get(identityId) ?? null;
  }

  private toAuthIdentity(identity: IdentityRecord, includePrivate = false): AuthIdentityDto {
    return {
      id: identity.id,
      displayName: identity.displayName,
      username: identity.username ?? null,
      kind: identity.kind,
      parentIdentityId: identity.parentIdentityId ?? null,
      avatarUrl: identity.avatarUrl,
      location: identity.location,
      signature: identity.signature,
      theme: identity.theme,
      hasPrivateEmail: includePrivate ? false : undefined,
      hasPassword: Boolean(identity.password),
      quickReplyDockedByDefault: identity.quickReplyDockedByDefault ?? false,
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
      updatedAt: identity.updatedAt,
    };
  }
}

async function attachMockApi(context: BrowserContext, api: MockAuthApi): Promise<void> {
  await context.route('**/api/**', async (route) => {
    const response = await api.handle(route.request());
    await route.fulfill({
      status: response.status,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
      body: JSON.stringify(response.body ?? {}),
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
    await expect(page.locator('.vb-welcome-links a')).toHaveText([
      'User CP',
      'Drafts',
      'Notepad',
      'Files',
      'Message Templates',
    ]);
    await expect(page.locator('.vb-welcome-links')).toContainText('Log Out');
    await expect(page.locator('.vb-nav-items a')).toHaveText(['Forum Home', 'Chat', 'Developers', 'API Docs']);

    await page.reload();
    await expect(page.locator('.vb-welcome')).toContainText('Riley Walker');

    await page.locator('.vb-welcome-links a', { hasText: 'User CP' }).click();
    await expect(page).toHaveURL('/profile');
    await expect(page.locator('.vb-table-header')).toContainText('User Control Panel');

    await page.setInputFiles('input[type="file"]', {
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: avatarPng,
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
    await expect(page.locator('#quickReplyStyle')).toHaveValue('false');
    await page.locator('#quickReplyStyle').selectOption('true');

    await page.locator('button', { hasText: 'Save Changes' }).click();
    await expect(page.locator('.vb-success-banner')).toContainText('Profile updated successfully.');
    await expect(page.locator('.vb-profile-row', { hasText: 'Display Name:' })).toContainText('Riley Updated');
    await expect(page.locator('.vb-profile-row', { hasText: 'Location:' })).toContainText('Seattle, WA');
    await expect(page.locator('.vb-profile-row', { hasText: 'Signature:' })).toContainText('See you in the threads.');
    await expect(page.locator('.vb-profile-row', { hasText: 'Theme:' })).toContainText('Classic RoboBB');
    await expect(page.locator('.vb-profile-row', { hasText: 'Quick Reply Style:' })).toContainText('Docked');
    await expect(page.locator('.vb-welcome')).toContainText('Riley Updated');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic-dark');
    await expect(page.locator('.vb-theme-toggle')).toHaveAttribute('title', 'Theme: Classic RoboBB (Dark)');

    await page.reload();
    await expect(page.locator('.vb-profile-row', { hasText: 'Display Name:' })).toContainText('Riley Updated');
    await expect(page.locator('.vb-profile-row', { hasText: 'Location:' })).toContainText('Seattle, WA');
    await expect(page.locator('.vb-profile-row', { hasText: 'Signature:' })).toContainText('See you in the threads.');
    await expect(page.locator('.vb-profile-row', { hasText: 'Quick Reply Style:' })).toContainText('Docked');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic-dark');

    const identityId = api.getIdentityByDisplayName('Riley Updated')?.id ?? '';
    await page.goto(`/users/${identityId}`);
    await expect(page.locator('.vb-table-header')).toContainText('User Profile');
    await expect(page.locator('.vb-profile-name')).toContainText('Riley Updated');
    await expect(page.locator('.vb-profile-row', { hasText: 'Location' })).toContainText('Seattle, WA');
    await expect(page.locator('.vb-profile-row', { hasText: 'Signature' })).toContainText('See you in the threads.');
    await expect(page.locator('.vb-profile-row', { hasText: 'Theme' })).toContainText('classic-dark');
    await expect(page.locator('.vb-profile-avatar')).toHaveAttribute('src', /cdn\.example\.test/);

    await page.setViewportSize({ width: 390, height: 720 });
    const forumMenu = page.getByRole('button', { name: 'Toggle forum navigation' });
    await expect(forumMenu).toHaveAttribute('aria-expanded', 'false');
    await forumMenu.click();
    await expect(forumMenu).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.vb-nav-item', { hasText: 'Forum Home' }).click();
    await expect(page).toHaveURL('/');
    await expect(forumMenu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.vb-welcome')).toContainText('Riley Updated');
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.locator('.vb-welcome-links a', { hasText: 'User CP' }).click();
    await page.locator('button', { hasText: 'Edit Profile' }).click();
    await page.locator('#editLocation').fill('Portland, OR');
    await page.locator('button', { hasText: 'Save Changes' }).click();
    await expect(page.locator('.vb-profile-row', { hasText: 'Location:' })).toContainText('Portland, OR');
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
    const loginTrigger = page.locator('.vb-welcome-links .vb-link-btn', { hasText: 'Log In' });
    await loginTrigger.click();
    const loginDialog = page.getByRole('dialog', { name: 'Log In' });
    const loginForm = loginDialog.locator('form');
    const usernameInput = page.locator('#login-username');
    const passwordInput = page.locator('#login-password');
    await expect(loginDialog).toBeVisible();
    await expect(loginForm).toBeVisible();
    await expect(usernameInput).toBeFocused();
    await expect(usernameInput).toHaveAttribute('name', 'username');
    await expect(usernameInput).toHaveAttribute('autocomplete', 'username');
    await expect(usernameInput).toHaveClass(/vb-text-input/);
    await expect(passwordInput).toHaveAttribute('name', 'password');
    await expect(passwordInput).toHaveAttribute('autocomplete', 'current-password');
    await expect(passwordInput).toHaveClass(/vb-text-input/);

    const cancelButton = loginDialog.getByRole('button', { name: 'Cancel' });
    const closeButton = loginDialog.getByRole('button', { name: 'Close login dialog' });
    await cancelButton.focus();
    await cancelButton.press('Tab');
    await expect(closeButton).toBeFocused();
    await closeButton.press('Escape');
    await expect(loginDialog).toBeHidden();
    await expect(loginTrigger).toBeFocused();
    await loginTrigger.click();
    await expect(usernameInput).toBeFocused();

    await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    const loginAlert = loginDialog.getByRole('alert');
    await expect(loginAlert).toContainText('Please enter username and password');
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
    await expect(page.context().cookies()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'cforum_session', value: expect.stringMatching(/.+/) })])
    );

    await page.locator('.vb-link-btn', { hasText: 'Log In' }).click();
    await page.locator('.vb-modal input[type="text"]').fill('invite-user');
    await page.locator('.vb-modal input[type="password"]').fill('wrongpass');
    await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await expect(page.locator('.vb-modal .vb-login-error')).toContainText('Invalid credentials');
    await expect(page.locator('.vb-welcome')).toContainText('Guest_User');

    await page.locator('.vb-modal input[type="password"]').fill('supersecret');
    await page.locator('.vb-modal input[type="password"]').press('Enter');
    await expect(page.locator('.vb-welcome')).toContainText('Invite Tester');
    await expect(page.locator('.vb-welcome-links .vb-link-btn', { hasText: 'Log Out' })).toBeFocused();

    await page.locator('.vb-welcome-links a', { hasText: 'User CP' }).click();
    const passkeyNameInput = page.locator('#passkey-name');
    await expect(passkeyNameInput).toHaveAttribute('name', 'passkeyName');
    await expect(passkeyNameInput).toHaveClass(/vb-text-input/);
    await expect(page.locator('#current-password')).toHaveClass(/vb-text-input/);
    await expect(page.locator('#new-password')).toHaveClass(/vb-text-input/);
    await expect(page.locator('#confirm-new-password')).toHaveClass(/vb-text-input/);
    const changePasswordCard = page.locator('.vb-card', { hasText: 'Change Password' });
    await expect(changePasswordCard.locator('input[name="username"]')).toHaveAttribute('autocomplete', 'username');
    await expect(changePasswordCard.locator('form #current-password')).toBeVisible();
    await expect(changePasswordCard.locator('button[type="submit"]')).toBeVisible();
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

  test('renders Notepad Markdown with the shared forum presentation and Mermaid enhancement', async ({ page }) => {
    const baseUrl = test.info().project.use.baseURL ?? 'http://localhost:5173';
    const api = new MockAuthApi(baseUrl);
    api.createVerifiedIdentity('Notepad User', 'notepad-user', 'sharedpass');
    api.setNotepadBody(
      [
        '# Heading',
        '',
        'Before the divider.',
        '',
        '---',
        '',
        'After the divider.',
        '',
        '- one',
        '- two',
        '',
        '> quoted text',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| Alpha | 1 |',
        '',
        '```ts',
        'const answer = 42;',
        '```',
        '',
        '[Forum](https://example.com)',
        '',
        '![Pixel](data:image/png;base64,iVBORw0KGgo=)',
        '',
        `long-${'x'.repeat(300)}`,
        '',
        '```mermaid',
        'flowchart LR',
        '  Notes --> Forum',
        '```',
      ].join('\n')
    );
    await attachMockApi(page.context(), api);

    await page.goto('/');
    await page.locator('.vb-link-btn', { hasText: 'Log In' }).click();
    await page.locator('.vb-modal input[type="text"]').fill('notepad-user');
    await page.locator('.vb-modal input[type="password"]').fill('sharedpass');
    await page.locator('.vb-modal .vb-btn', { hasText: 'Log In' }).click();
    await page.goto('/notepad');

    const body = page.locator('.vb-note-body');
    await expect(body).toHaveClass(/vb-rendered-content/);
    await expect(body).toHaveClass(/vb-post-text/);
    await expect(body.locator('h1')).toHaveText('Heading');
    await expect(body.locator('li')).toHaveText(['one', 'two']);
    await expect(body.locator('blockquote')).toContainText('quoted text');
    await expect(body.locator('table')).toContainText('Alpha');
    await expect(body.locator('.vb-code-content')).toContainText('const answer = 42;');
    await expect(body.getByRole('link', { name: 'Forum' })).toHaveAttribute('target', '_blank');
    await expect(body.locator('img.vb-user-image')).toHaveAttribute('alt', 'Pixel');
    await expect(body).toHaveCSS('display', 'block');
    await expect(body).toHaveCSS('overflow-wrap', 'anywhere');

    const ruleBox = await body.locator('hr').boundingBox();
    if (!ruleBox) throw new Error('Notepad horizontal rule has no layout box');
    expect(ruleBox.width).toBeGreaterThan(ruleBox.height * 10);

    const mermaid = body.locator('.vb-mermaid-block');
    await mermaid.scrollIntoViewIfNeeded();
    await expect(mermaid).toHaveAttribute('data-mermaid-state', 'rendered', { timeout: 20_000 });
    await expect(mermaid.locator('.vb-mermaid-render iframe')).toHaveAttribute('sandbox', '');
  });

  test('keeps parallel cookie sessions consistent after reload', async ({ browser }) => {
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

    // Second session remains stale until it reloads.
    await expect(pageB.locator('.vb-welcome')).toContainText('Parallel User');
    await pageB.reload();
    await expect(pageB.locator('.vb-welcome')).toContainText('Parallel Updated');

    await contextA.close();
    await contextB.close();
  });
});
