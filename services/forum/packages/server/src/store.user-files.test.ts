import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './db';
import { FileStorageMaintenance } from './services/fileStorageMaintenance';
import { ForumStore } from './store';

describe('unified user file lifecycle', () => {
  let db: Database.Database;
  let store: ForumStore;
  let dir: string;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    store = new ForumStore(db);
    dir = join('/tmp', `codex-user-files-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deduplicates per owner and keeps an associated blob after standalone expiry', async () => {
    const owner = store.createIdentityWithPassword('Owner', 'dedupe-owner', 'hash', 'human');
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const { post } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'body', authorId: owner.id });
    const firstPath = join(dir, 'first');
    writeFileSync(firstPath, 'same');
    const first = store.createUserFile({
      identityId: owner.id,
      filename: 'first.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      storagePath: firstPath,
      sha256: 'same-hash',
      visibility: 'private',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const repeated = store.createUserFile({
      identityId: owner.id,
      filename: 'other.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      storagePath: join(dir, 'unused'),
      sha256: 'same-hash',
      visibility: 'public',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(repeated.id).toBe(first.id);
    expect(repeated.visibility).toBe('public');
    expect(repeated.expires_at).toBe('2030-01-01T00:00:00.000Z');
    const association = store.createAttachment({
      postId: post.id,
      filename: 'post-name.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      storagePath: firstPath,
      sha256: 'same-hash',
      ownerIdentityId: owner.id,
    });
    expect(association.file_id).toBe(first.id);
    expect(store.expireUserFiles('2031-01-01T00:00:00.000Z')).toBe(1);
    expect(store.getUserFileBlob(first.id)?.state).toBe('ready');
    store.deleteAttachment(association.id);
    expect(store.getUserFileBlob(first.id)?.state).toBe('gc_pending');
    const result = await new FileStorageMaintenance(store, dir).run(new Date('2031-01-01T00:01:00.000Z'));
    expect(result.collected).toBe(1);
    expect(existsSync(firstPath)).toBe(false);
    expect(store.getUserFileBlob(first.id)).toBeNull();
    expect(store.getAttachment(association.id)?.deleted_at).not.toBeNull();
  });

  it('does not deduplicate identical hashes across owners', () => {
    const one = store.createIdentityWithPassword('One', 'dedupe-one', 'hash', 'human');
    const two = store.createIdentityWithPassword('Two', 'dedupe-two', 'hash', 'human');
    const pathOne = join(dir, 'one');
    const pathTwo = join(dir, 'two');
    writeFileSync(pathOne, 'x');
    writeFileSync(pathTwo, 'x');
    const a = store.createUserFile({
      identityId: one.id,
      filename: 'x',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storagePath: pathOne,
      sha256: 'hash',
    });
    const b = store.createUserFile({
      identityId: two.id,
      filename: 'x',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storagePath: pathTwo,
      sha256: 'hash',
    });
    expect(a.id).not.toBe(b.id);
    expect(store.getUserFileBlob(a.id)?.id).not.toBe(store.getUserFileBlob(b.id)?.id);
  });

  it('repairs a missing dedupe target with the newly uploaded bytes', () => {
    const owner = store.createIdentityWithPassword('Owner', 'repair-owner', 'hash', 'human');
    const missingPath = join(dir, 'missing');
    const replacementPath = join(dir, 'replacement');
    writeFileSync(replacementPath, 'new');
    const original = store.createUserFile({
      identityId: owner.id,
      filename: 'old.txt',
      mimeType: 'text/plain',
      sizeBytes: 3,
      storagePath: missingPath,
      sha256: 'repair-hash',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const oldBlob = store.getUserFileBlob(original.id)!;
    store.markBlobMissing(oldBlob.id);
    const repaired = store.createUserFile({
      identityId: owner.id,
      filename: 'new.txt',
      mimeType: 'text/plain',
      sizeBytes: 3,
      storagePath: replacementPath,
      sha256: 'repair-hash',
      visibility: 'public',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(repaired.id).toBe(original.id);
    expect(repaired.filename).toBe('new.txt');
    expect(repaired.expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(store.getUserFileBlob(repaired.id)).toMatchObject({ storage_path: replacementPath, state: 'ready' });
    expect(store.claimBlobForGc(oldBlob.id)).toBe(missingPath);
    expect(existsSync(replacementPath)).toBe(true);
  });

  it('preserves retention when only visibility changes', () => {
    const owner = store.createIdentityWithPassword('Owner', 'keep-owner', 'hash', 'human');
    const path = join(dir, 'kept');
    writeFileSync(path, 'x');
    const file = store.createUserFile({
      identityId: owner.id,
      filename: 'x',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storagePath: path,
      sha256: 'keep-hash',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const updated = store.updateUserFile(file.id, owner.id, file.revision, 'public', undefined);
    expect(updated).not.toBe('missing');
    expect(updated).not.toBe('conflict');
    expect(updated.expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(updated.visibility).toBe('public');
  });

  it('retries pending byte cleanup through the durable deletion queue', async () => {
    const owner = store.createIdentityWithPassword('Owner', 'pending-owner', 'hash', 'human');
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'body', authorId: owner.id });
    const path = join(dir, 'pending');
    writeFileSync(path, 'pending');
    store.createPendingAttachment({
      topicId: topic.id,
      filename: 'pending.txt',
      mimeType: 'text/plain',
      sizeBytes: 7,
      storagePath: path,
      sha256: 'pending-hash',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const result = await new FileStorageMaintenance(store, dir).run(new Date('2001-01-01T00:00:00.000Z'));
    expect(result.collected).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(store.listQueuedFileDeletions()).toEqual([]);
  });

  it('queues pending bytes before hard topic deletion removes their metadata', async () => {
    const owner = store.createIdentityWithPassword('Owner', 'topic-delete-owner', 'hash', 'human');
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const { topic } = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'body', authorId: owner.id });
    const path = join(dir, 'topic-pending');
    writeFileSync(path, 'pending');
    store.createPendingAttachment({
      topicId: topic.id,
      filename: 'pending.txt',
      mimeType: 'text/plain',
      sizeBytes: 7,
      storagePath: path,
      sha256: 'pending-topic-hash',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    store.deleteTopic(topic.id);
    expect(store.listQueuedFileDeletions()).toHaveLength(1);
    await new FileStorageMaintenance(store, dir).run();
    expect(existsSync(path)).toBe(false);
  });

  it('retains durable deletion custody across an unlink failure and maintenance restart', async () => {
    const owner = store.createIdentityWithPassword('Owner', 'gc-retry-owner', 'hash', 'human');
    const path = join(dir, 'gc-retry');
    mkdirSync(path);
    const file = store.createUserFile({
      identityId: owner.id,
      filename: 'retry.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
      storagePath: path,
      sha256: 'gc-retry-hash',
    });
    store.deleteUserFile(file.id, owner.id);

    const first = await new FileStorageMaintenance(store, dir).run();
    expect(first.collected).toBe(0);
    expect(store.getUserFileBlob(file.id)).toBeNull();
    expect(store.listQueuedFileDeletions()).toEqual([
      expect.objectContaining({ storage_path: path, attempt_count: 1 }),
    ]);

    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, 'x');
    const afterRestart = await new FileStorageMaintenance(store, dir).run();
    expect(afterRestart.collected).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(store.listQueuedFileDeletions()).toEqual([]);
  });

  it('rechecks references when claiming a selected blob for GC', () => {
    const owner = store.createIdentityWithPassword('Owner', 'gc-race-owner', 'hash', 'human');
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const post = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'body', authorId: owner.id }).post;
    const path = join(dir, 'gc-race');
    writeFileSync(path, 'x');
    const file = store.createUserFile({
      identityId: owner.id,
      filename: 'x',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storagePath: path,
      sha256: 'gc-race-hash',
    });
    store.deleteUserFile(file.id, owner.id);
    const blob = store.getUserFileBlob(file.id)!;
    expect(blob.state).toBe('gc_pending');
    store.createAttachment({
      postId: post.id,
      filename: 'x',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storagePath: path,
      sha256: 'gc-race-hash',
      ownerIdentityId: owner.id,
    });
    expect(store.claimBlobForGc(blob.id)).toBeNull();
    expect(store.getUserFileBlob(file.id)?.state).toBe('ready');
    expect(existsSync(path)).toBe(true);
  });

  it('merges verified legacy logical duplicates and preserves the losing id as an alias', () => {
    const owner = store.createIdentityWithPassword('Owner', 'legacy-merge-owner', 'hash', 'human');
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const post = store.createTopic({ forumId: forum.id, title: 'Topic', body: 'body', authorId: owner.id }).post;
    const firstPath = join(dir, 'legacy-one');
    const secondPath = join(dir, 'legacy-two');
    writeFileSync(firstPath, 'same');
    writeFileSync(secondPath, 'same');
    const standalone = store.createUserFile({
      identityId: owner.id,
      filename: 'standalone.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      storagePath: firstPath,
    });
    const attachment = store.createAttachment({
      postId: post.id,
      filename: 'attached.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      storagePath: secondPath,
      ownerIdentityId: owner.id,
    });
    const attachedFileId = attachment.file_id!;
    const standaloneBlob = store.getUserFileBlob(standalone.id)!;
    const attachedBlob = store.getUserFileBlob(attachedFileId)!;
    store.verifyBlob(standaloneBlob.id, 'verified-hash', 4);
    store.verifyBlob(attachedBlob.id, 'verified-hash', 4);
    expect(store.listUserFilesByIdentity(owner.id, 'all')).toHaveLength(1);
    expect(store.getUserFile(attachedFileId)?.id).toBe(standalone.id);
    expect(store.getAttachment(attachment.id)?.file_id).toBe(standalone.id);
  });

  it('resurrects a shared system path before GC can remove a new TTS reference', () => {
    const robot = store.createIdentityWithPassword('Robot', 'tts-robot', 'hash', 'robot');
    const forum = store.createForum('Public', null, null, null, null, 'active', 'public');
    const first = store.createTopic({ forumId: forum.id, title: 'One', body: 'one', authorId: robot.id }).post;
    const second = store.createTopic({ forumId: forum.id, title: 'Two', body: 'two', authorId: robot.id }).post;
    const path = join(dir, 'tts.mp3');
    writeFileSync(path, 'voice');
    const firstAttachment = store.createAttachment({
      postId: first.id,
      filename: 'voice.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 5,
      storagePath: path,
      sha256: 'voice-hash',
      ownerIdentityId: null,
      dedupeSystemByPath: true,
    });
    store.deleteAttachment(firstAttachment.id);
    expect(store.getAttachmentBlob(firstAttachment.id)?.state).toBe('gc_pending');
    const secondAttachment = store.createAttachment({
      postId: second.id,
      filename: 'voice.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 5,
      storagePath: path,
      sha256: 'voice-hash',
      ownerIdentityId: null,
      dedupeSystemByPath: true,
    });
    expect(store.getAttachmentBlob(secondAttachment.id)?.state).toBe('ready');
    expect(store.getAttachmentBlob(secondAttachment.id)?.id).toBe(store.getAttachmentBlob(firstAttachment.id)?.id);
  });
});
