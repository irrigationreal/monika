import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db';
import { ForumStore } from '../store';
import { SqliteOneTimeLinkIssuer } from './oneTimeLinks';

/**
 * Comprehensive unit tests for the Codex Forum authentication system.
 *
 * Tests cover:
 * 1. OneTimeLinkIssuer - Token issuance, verification, expiry, and cleanup
 * 2. Identity management - Creation, retrieval, and updates
 * 3. Invite system - Code generation, usage, expiration, and exhaustion
 */

describe('SqliteOneTimeLinkIssuer', () => {
  let db: Database.Database;
  let store: ForumStore;
  let issuer: SqliteOneTimeLinkIssuer;
  let testUserId: string;
  const baseUrl = 'https://example.com';

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    issuer = new SqliteOneTimeLinkIssuer(db, baseUrl);
    // Create a test identity to satisfy foreign key constraints
    const testUser = store.createIdentity('Test User', 'human');
    testUserId = testUser.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('issue()', () => {
    it('creates a valid token with correct URL format', async () => {
      const link = await issuer.issue(testUserId);

      expect(link.token).toBeDefined();
      expect(link.token).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(link.url).toBe(`${baseUrl}/auth/verify/${link.token}`);
      expect(link.expiresAt).toBeDefined();
    });

    it('creates token with default 24-hour expiry', async () => {
      const now = new Date();
      const link = await issuer.issue(testUserId);

      const expiresAt = new Date(link.expiresAt);
      const expectedExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Allow 5 second tolerance for test execution time
      expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(5000);
    });

    it('creates token with custom TTL', async () => {
      const ttlSeconds = 3600; // 1 hour
      const now = new Date();
      const link = await issuer.issue(testUserId, ttlSeconds);

      const expiresAt = new Date(link.expiresAt);
      const expectedExpiry = new Date(now.getTime() + ttlSeconds * 1000);

      // Allow 5 second tolerance for test execution time
      expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(5000);
    });

    it('stores the token in the database', async () => {
      const link = await issuer.issue(testUserId);

      const row = issuer.getLink(link.token);
      expect(row).not.toBeNull();
      expect(row?.identity_id).toBe(testUserId);
      expect(row?.used_at).toBeNull();
      expect(row?.expires_at).toBe(link.expiresAt);
    });

    it('generates unique tokens for each issuance', async () => {
      const link1 = await issuer.issue(testUserId);
      const link2 = await issuer.issue(testUserId);

      expect(link1.token).not.toBe(link2.token);
    });
  });

  describe('verify()', () => {
    it('succeeds for valid unused token', async () => {
      const link = await issuer.issue(testUserId);

      const result = await issuer.verify(link.token);

      expect(result.ok).toBe(true);
      expect(result.userId).toBe(testUserId);
    });

    it('marks token as used after successful verification', async () => {
      const link = await issuer.issue(testUserId);

      await issuer.verify(link.token);

      const row = issuer.getLink(link.token);
      expect(row?.used_at).not.toBeNull();
    });

    it('fails for already used token', async () => {
      const link = await issuer.issue(testUserId);

      // First verification should succeed
      const firstResult = await issuer.verify(link.token);
      expect(firstResult.ok).toBe(true);

      // Second verification should fail
      const secondResult = await issuer.verify(link.token);
      expect(secondResult.ok).toBe(false);
      expect(secondResult.userId).toBeUndefined();
    });

    it('fails for expired token', async () => {
      // Issue with 1 second TTL
      const link = await issuer.issue(testUserId, 1);

      // Wait for token to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = await issuer.verify(link.token);

      expect(result.ok).toBe(false);
      expect(result.userId).toBeUndefined();
    });

    it('fails for non-existent token', async () => {
      const result = await issuer.verify('non-existent-token');

      expect(result.ok).toBe(false);
      expect(result.userId).toBeUndefined();
    });

    it('fails for empty token', async () => {
      const result = await issuer.verify('');

      expect(result.ok).toBe(false);
      expect(result.userId).toBeUndefined();
    });
  });

  describe('getLink()', () => {
    it('returns the link for existing token', async () => {
      const link = await issuer.issue(testUserId);

      const row = issuer.getLink(link.token);

      expect(row).not.toBeNull();
      expect(row?.token).toBe(link.token);
      expect(row?.identity_id).toBe(testUserId);
    });

    it('returns null for non-existent token', () => {
      const row = issuer.getLink('non-existent-token');
      expect(row).toBeNull();
    });
  });

  describe('listByUser()', () => {
    it('returns all links for a user ordered by created_at desc', async () => {
      await issuer.issue(testUserId);
      await issuer.issue(testUserId);
      await issuer.issue(testUserId);

      const links = issuer.listByUser(testUserId);

      expect(links).toHaveLength(3);
      // Should be ordered by created_at desc
      const createdTimes = links.map((l) => new Date(l.created_at).getTime());
      expect(createdTimes).toEqual([...createdTimes].sort((a, b) => b - a));
    });

    it('returns empty array for user with no links', () => {
      const otherUser = store.createIdentity('Other User', 'human');
      const links = issuer.listByUser(otherUser.id);
      expect(links).toEqual([]);
    });

    it('does not return links for other users', async () => {
      const otherUser = store.createIdentity('Other User', 'human');
      await issuer.issue(testUserId);
      await issuer.issue(otherUser.id);
      await issuer.issue(otherUser.id);

      const links = issuer.listByUser(testUserId);

      expect(links).toHaveLength(1);
      expect(links[0]?.identity_id).toBe(testUserId);
    });
  });

  describe('cleanupExpired()', () => {
    it('removes expired tokens', async () => {
      // Issue with 1 second TTL
      const link = await issuer.issue(testUserId, 1);

      // Wait for token to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const deletedCount = issuer.cleanupExpired();

      expect(deletedCount).toBe(1);
      expect(issuer.getLink(link.token)).toBeNull();
    });

    it('does not remove non-expired tokens', async () => {
      const link = await issuer.issue(testUserId, 3600); // 1 hour TTL

      const deletedCount = issuer.cleanupExpired();

      expect(deletedCount).toBe(0);
      expect(issuer.getLink(link.token)).not.toBeNull();
    });

    it('removes multiple expired tokens at once', async () => {
      // Issue 3 tokens with 1 second TTL
      await issuer.issue(testUserId, 1);
      await issuer.issue(testUserId, 1);
      await issuer.issue(testUserId, 1);
      // Issue 1 token with long TTL
      const validLink = await issuer.issue(testUserId, 3600);

      // Wait for short-lived tokens to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const deletedCount = issuer.cleanupExpired();

      expect(deletedCount).toBe(3);
      // Valid token should still exist
      expect(issuer.getLink(validLink.token)).not.toBeNull();
    });

    it('returns 0 when no tokens are expired', async () => {
      await issuer.issue(testUserId, 3600);
      await issuer.issue(testUserId, 3600);

      const deletedCount = issuer.cleanupExpired();

      expect(deletedCount).toBe(0);
    });
  });
});

describe('ForumStore - Identity Management', () => {
  let db: Database.Database;
  let store: ForumStore;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createIdentity()', () => {
    it('creates identity with correct fields', () => {
      const displayName = 'Test User';
      const kind = 'human';
      const avatarUrl = 'https://example.com/avatar.png';

      const identity = store.createIdentity(displayName, kind, avatarUrl);

      expect(identity.id).toBeDefined();
      expect(identity.display_name).toBe(displayName);
      expect(identity.kind).toBe(kind);
      expect(identity.avatar_url).toBe(avatarUrl);
      expect(identity.tenant_id).toBeNull();
      expect(identity.created_at).toBeDefined();
      expect(identity.updated_at).toBeDefined();
    });

    it('uses default kind of "human" when not specified', () => {
      const identity = store.createIdentity('Test User');

      expect(identity.kind).toBe('human');
    });

    it('handles null avatar_url', () => {
      const identity = store.createIdentity('Test User', 'human', null);

      expect(identity.avatar_url).toBeNull();
    });

    it('handles undefined avatar_url', () => {
      const identity = store.createIdentity('Test User', 'human');

      expect(identity.avatar_url).toBeNull();
    });

    it('creates identity with robot kind', () => {
      const identity = store.createIdentity('Bot', 'robot', '/bot.png');

      expect(identity.kind).toBe('robot');
    });

    it('generates unique IDs for each identity', () => {
      const identity1 = store.createIdentity('User 1');
      const identity2 = store.createIdentity('User 2');

      expect(identity1.id).not.toBe(identity2.id);
    });

    it('sets created_at and updated_at to current time', () => {
      const before = new Date();
      const identity = store.createIdentity('Test User');
      const after = new Date();

      const createdAt = new Date(identity.created_at);
      const updatedAt = new Date(identity.updated_at);

      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('getIdentity()', () => {
    it('returns identity by ID', () => {
      const created = store.createIdentity('Test User', 'human', '/avatar.png');

      const fetched = store.getIdentity(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.display_name).toBe('Test User');
    });

    it('returns null for non-existent ID', () => {
      const fetched = store.getIdentity('non-existent-id');

      expect(fetched).toBeNull();
    });
  });

  describe('getIdentityByDisplayName()', () => {
    it('finds existing identity by display name', () => {
      const created = store.createIdentity('Unique Name', 'human');

      const fetched = store.getIdentityByDisplayName('Unique Name');

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.display_name).toBe('Unique Name');
    });

    it('returns null for non-existent display name', () => {
      const fetched = store.getIdentityByDisplayName('Non Existent');

      expect(fetched).toBeNull();
    });

    it('is case-sensitive', () => {
      store.createIdentity('TestUser');

      const fetched = store.getIdentityByDisplayName('testuser');

      expect(fetched).toBeNull();
    });

    it('returns first match when multiple identities have same display name', () => {
      // Note: The schema doesn't enforce unique display names
      const first = store.createIdentity('Duplicate');
      store.createIdentity('Duplicate');

      const fetched = store.getIdentityByDisplayName('Duplicate');

      expect(fetched?.id).toBe(first.id);
    });
  });

  describe('getIdentityByKind()', () => {
    it('finds identity by kind', () => {
      const robot = store.createIdentity('Bot', 'robot');

      const fetched = store.getIdentityByKind('robot');

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(robot.id);
    });

    it('returns null for non-existent kind', () => {
      store.createIdentity('Human', 'human');

      const fetched = store.getIdentityByKind('robot');

      expect(fetched).toBeNull();
    });

    it('returns first match when multiple identities have same kind', () => {
      const first = store.createIdentity('Human 1', 'human');
      store.createIdentity('Human 2', 'human');

      const fetched = store.getIdentityByKind('human');

      expect(fetched?.id).toBe(first.id);
    });
  });

  describe('updateIdentity()', () => {
    it('updates display name correctly', () => {
      const identity = store.createIdentity('Old Name');

      const updated = store.updateIdentity(identity.id, { displayName: 'New Name' });

      expect(updated.display_name).toBe('New Name');
      expect(updated.id).toBe(identity.id);
    });

    it('updates avatar_url correctly', () => {
      const identity = store.createIdentity('User', 'human', '/old.png');

      const updated = store.updateIdentity(identity.id, { avatarUrl: '/new.png' });

      expect(updated.avatar_url).toBe('/new.png');
    });

    it('updates both display name and avatar_url', () => {
      const identity = store.createIdentity('Old Name', 'human', '/old.png');

      const updated = store.updateIdentity(identity.id, {
        displayName: 'New Name',
        avatarUrl: '/new.png',
      });

      expect(updated.display_name).toBe('New Name');
      expect(updated.avatar_url).toBe('/new.png');
    });

    it('allows setting avatar_url to null', () => {
      const identity = store.createIdentity('User', 'human', '/avatar.png');

      const updated = store.updateIdentity(identity.id, { avatarUrl: null });

      expect(updated.avatar_url).toBeNull();
    });

    it('preserves fields that are not updated', () => {
      const identity = store.createIdentity('User', 'human', '/avatar.png');

      const updated = store.updateIdentity(identity.id, { displayName: 'New Name' });

      expect(updated.avatar_url).toBe('/avatar.png');
      expect(updated.kind).toBe('human');
    });

    it('updates the updated_at timestamp', () => {
      const identity = store.createIdentity('User');
      const originalUpdatedAt = identity.updated_at;

      // Small delay to ensure timestamp difference
      const updated = store.updateIdentity(identity.id, { displayName: 'New Name' });

      expect(new Date(updated.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt).getTime()
      );
    });

    it('throws error for non-existent identity', () => {
      expect(() => {
        store.updateIdentity('non-existent-id', { displayName: 'New Name' });
      }).toThrow('identity not found');
    });
  });

  describe('listAllIdentities()', () => {
    it('returns all identities with pagination', () => {
      store.createIdentity('User 1');
      store.createIdentity('User 2');
      store.createIdentity('User 3');

      const page1 = store.listAllIdentities(1, 2);
      const page2 = store.listAllIdentities(2, 2);

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
    });

    it('returns empty array when no identities exist', () => {
      const identities = store.listAllIdentities();

      expect(identities).toEqual([]);
    });

    it('returns identities ordered by created_at descending', () => {
      store.createIdentity('First');
      store.createIdentity('Second');
      store.createIdentity('Third');

      const identities = store.listAllIdentities();

      expect(identities).toHaveLength(3);
      // Verify it's sorted by created_at descending (most recent first)
      const createdTimes = identities.map((i) => new Date(i.created_at).getTime());
      expect(createdTimes).toEqual([...createdTimes].sort((a, b) => b - a));
    });
  });
});

describe('ForumStore - Invite System', () => {
  let db: Database.Database;
  let store: ForumStore;
  let creatorId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    // Create an identity to be the invite creator
    const creator = store.createIdentity('Admin', 'human');
    creatorId = creator.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('createInvite()', () => {
    it('generates valid invite with unique code', () => {
      const invite = store.createInvite(creatorId);

      expect(invite.id).toBeDefined();
      expect(invite.code).toBeDefined();
      expect(invite.code).toHaveLength(16);
      expect(invite.created_by).toBe(creatorId);
      expect(invite.max_uses).toBe(1);
      expect(invite.uses).toBe(0);
      expect(invite.expires_at).toBeNull();
      expect(invite.created_at).toBeDefined();
    });

    it('creates invite with custom max_uses', () => {
      const invite = store.createInvite(creatorId, 10);

      expect(invite.max_uses).toBe(10);
      expect(invite.uses).toBe(0);
    });

    it('creates invite with expiration date', () => {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const invite = store.createInvite(creatorId, 1, expiresAt);

      expect(invite.expires_at).toBe(expiresAt);
    });

    it('generates unique codes for each invite', () => {
      const invite1 = store.createInvite(creatorId);
      const invite2 = store.createInvite(creatorId);

      expect(invite1.code).not.toBe(invite2.code);
    });

    it('code contains only alphanumeric characters', () => {
      const invite = store.createInvite(creatorId);

      expect(invite.code).toMatch(/^[a-f0-9]+$/);
    });
  });

  describe('getInvite()', () => {
    it('returns invite by ID', () => {
      const created = store.createInvite(creatorId);

      const fetched = store.getInvite(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.code).toBe(created.code);
    });

    it('returns null for non-existent ID', () => {
      const fetched = store.getInvite('non-existent-id');

      expect(fetched).toBeNull();
    });
  });

  describe('getInviteByCode()', () => {
    it('returns invite by code', () => {
      const created = store.createInvite(creatorId);

      const fetched = store.getInviteByCode(created.code);

      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
    });

    it('returns null for non-existent code', () => {
      const fetched = store.getInviteByCode('invalid-code');

      expect(fetched).toBeNull();
    });
  });

  describe('useInvite()', () => {
    it('succeeds for valid invite and increments uses', () => {
      const invite = store.createInvite(creatorId, 5);

      const result = store.useInvite(invite.code);

      expect(result.ok).toBe(true);
      expect(result.invite).toBeDefined();
      expect(result.invite?.uses).toBe(1);
      expect(result.error).toBeUndefined();
    });

    it('allows multiple uses up to max_uses', () => {
      const invite = store.createInvite(creatorId, 3);

      const result1 = store.useInvite(invite.code);
      const result2 = store.useInvite(invite.code);
      const result3 = store.useInvite(invite.code);

      expect(result1.ok).toBe(true);
      expect(result1.invite?.uses).toBe(1);
      expect(result2.ok).toBe(true);
      expect(result2.invite?.uses).toBe(2);
      expect(result3.ok).toBe(true);
      expect(result3.invite?.uses).toBe(3);
    });

    it('fails for exhausted invite (max uses reached)', () => {
      const invite = store.createInvite(creatorId, 1);

      // Use the invite once
      store.useInvite(invite.code);

      // Second use should fail
      const result = store.useInvite(invite.code);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('invite exhausted');
      expect(result.invite).toBeUndefined();
    });

    it('fails for expired invite', async () => {
      // Create invite that expires in 1 second
      const expiresAt = new Date(Date.now() + 1000).toISOString();
      const invite = store.createInvite(creatorId, 10, expiresAt);

      // Wait for invite to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = store.useInvite(invite.code);

      expect(result.ok).toBe(false);
      expect(result.error).toBe('invite expired');
    });

    it('fails for non-existent invite code', () => {
      const result = store.useInvite('invalid-code');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('invite not found');
    });

    it('succeeds for invite without expiration', () => {
      const invite = store.createInvite(creatorId, 1, null);

      const result = store.useInvite(invite.code);

      expect(result.ok).toBe(true);
    });

    it('returns updated invite after use', () => {
      const invite = store.createInvite(creatorId, 5);
      expect(invite.uses).toBe(0);

      const result = store.useInvite(invite.code);

      expect(result.invite?.uses).toBe(1);
      // Verify the database was updated
      const fetched = store.getInvite(invite.id);
      expect(fetched?.uses).toBe(1);
    });
  });

  describe('listInvites()', () => {
    it('returns all invites with pagination', () => {
      store.createInvite(creatorId);
      store.createInvite(creatorId);
      store.createInvite(creatorId);

      const page1 = store.listInvites(1, 2);
      const page2 = store.listInvites(2, 2);

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
    });

    it('returns invites ordered by created_at descending', () => {
      store.createInvite(creatorId);
      store.createInvite(creatorId);
      store.createInvite(creatorId);

      const invites = store.listInvites();

      expect(invites).toHaveLength(3);
      // Verify it's sorted by created_at descending (most recent first)
      const createdTimes = invites.map((i) => new Date(i.created_at).getTime());
      expect(createdTimes).toEqual([...createdTimes].sort((a, b) => b - a));
    });

    it('returns empty array when no invites exist', () => {
      const invites = store.listInvites();

      expect(invites).toEqual([]);
    });
  });

  describe('deleteInvite()', () => {
    it('removes invite from database', () => {
      const invite = store.createInvite(creatorId);

      store.deleteInvite(invite.id);

      expect(store.getInvite(invite.id)).toBeNull();
      expect(store.getInviteByCode(invite.code)).toBeNull();
    });

    it('does not throw for non-existent invite', () => {
      expect(() => {
        store.deleteInvite('non-existent-id');
      }).not.toThrow();
    });
  });
});

describe('Integration: OneTimeLinkIssuer with ForumStore', () => {
  let db: Database.Database;
  let store: ForumStore;
  let issuer: SqliteOneTimeLinkIssuer;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    issuer = new SqliteOneTimeLinkIssuer(db, 'https://example.com');
  });

  afterEach(() => {
    db.close();
  });

  it('creates link for identity and verifies successfully', async () => {
    const identity = store.createIdentity('Test User', 'human');
    const link = await issuer.issue(identity.id);

    const result = await issuer.verify(link.token);

    expect(result.ok).toBe(true);
    expect(result.userId).toBe(identity.id);
  });

  it('can list links for an identity', async () => {
    const identity = store.createIdentity('Test User', 'human');
    await issuer.issue(identity.id);
    await issuer.issue(identity.id);

    const links = issuer.listByUser(identity.id);

    expect(links).toHaveLength(2);
    links.forEach((link) => {
      expect(link.identity_id).toBe(identity.id);
    });
  });

  it('full auth flow: create identity, issue link, verify link', async () => {
    // Step 1: Create a new identity
    const identity = store.createIdentity('New User', 'human', '/avatar.png');
    expect(identity.id).toBeDefined();

    // Step 2: Issue a one-time link for the identity
    const link = await issuer.issue(identity.id, 3600);
    expect(link.url).toContain('/auth/verify/');

    // Step 3: Verify the link (simulating user clicking the link)
    const verifyResult = await issuer.verify(link.token);
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.userId).toBe(identity.id);

    // Step 4: Fetch the identity to confirm it exists
    const fetchedIdentity = store.getIdentity(verifyResult.userId!);
    expect(fetchedIdentity).not.toBeNull();
    expect(fetchedIdentity?.display_name).toBe('New User');

    // Step 5: Link cannot be reused
    const reuseResult = await issuer.verify(link.token);
    expect(reuseResult.ok).toBe(false);
  });

  it('full invite flow: create invite, use invite, link to identity', async () => {
    // Step 1: Create an admin identity
    const admin = store.createIdentity('Admin', 'human');

    // Step 2: Admin creates an invite
    const invite = store.createInvite(admin.id, 5);
    expect(invite.code).toHaveLength(16);

    // Step 3: New user uses the invite
    const useResult = store.useInvite(invite.code);
    expect(useResult.ok).toBe(true);

    // Step 4: Create identity for the new user after successful invite use
    const newUser = store.createIdentity('New Member', 'human');
    expect(newUser.id).toBeDefined();

    // Step 5: Issue a one-time link for the new user
    const link = await issuer.issue(newUser.id);

    // Step 6: Verify the link
    const verifyResult = await issuer.verify(link.token);
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.userId).toBe(newUser.id);
  });
});
