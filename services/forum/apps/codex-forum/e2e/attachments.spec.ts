import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';
import type { AttachmentDto, ForumDto, IdentityDto, TopicDto, PostDto, UserFileDto } from '../../src/lib/apiClient';

declare global {
  interface Window {
    __codexFileOverrides?: {
      originalGetSize?: () => number;
      originalSlice?: typeof File.prototype.slice;
    };
  }
}

type MockApiOptions = {
  fileSizeByName?: Record<string, number>;
  initialUserFiles?: UserFileDto[];
  failUserFileUploads?: Set<string>;
  failUserFileDeletes?: Set<string>;
  failAttachmentUploads?: Set<string>;
  attachmentUploadDelayMs?: number;
  userFileUploadDelayMs?: number;
};

type MockApiState = {
  requestLog: string[];
  createdPostIds: string[];
  getLastCreateTopicPayload: () => Record<string, unknown> | null;
  getLastCreatePostPayload: () => Record<string, unknown> | null;
};

function createMockApi(options: MockApiOptions = {}): {
  attach: (page: Page) => Promise<MockApiState>;
} {
  const requestLog: string[] = [];
  const createdPostIds: string[] = [];
  let lastCreateTopicPayload: Record<string, unknown> | null = null;
  let lastCreatePostPayload: Record<string, unknown> | null = null;

  const now = '2025-01-01T12:00:00.000Z';
  const identity: IdentityDto = {
    id: 'identity-1',
    tenantId: null,
    displayName: 'Test User',
    kind: 'human',
    parentIdentityId: null,
    avatarUrl: null,
    location: 'Remote',
    signature: 'Ship it.',
    theme: 'classic-light',
    postCount: 3,
    rank: 'Member',
    joinDate: now,
    createdAt: now,
    updatedAt: now
  };

  const forum: ForumDto = {
    id: 'forum-1',
    tenantId: null,
    parentForumId: null,
    category: 'General',
    name: 'General Discussion',
    description: 'Attachment testing ground.',
    status: 'active',
    visibility: 'public',
    archivedAt: null,
    threadCount: 0,
    postCount: 0,
    lastPost: null,
    createdAt: now,
    updatedAt: now
  };

  const topics = new Map<string, TopicDto>();
  const postsByTopic = new Map<string, PostDto[]>();
  const attachmentsByPost = new Map<string, AttachmentDto[]>();
  const userFiles: UserFileDto[] = options.initialUserFiles ? [...options.initialUserFiles] : [];

  let topicCounter = 0;
  let postCounter = 0;
  let attachmentCounter = 0;
  let userFileCounter = 0;

  const chunkedUploads = new Map<string, { postId: string; filename: string; sizeBytes: number; mimeType: string }>();

  function extractFilename(buffer: Buffer | null): string | null {
    if (!buffer) return null;
    const snippet = buffer.toString('utf8', 0, Math.min(buffer.length, 2048));
    const match = snippet.match(/filename="([^"]+)"/);
    return match?.[1] ?? null;
  }

  function lookupSize(filename: string, fallback = 256): number {
    return options.fileSizeByName?.[filename] ?? fallback;
  }

  function nextId(prefix: string, counter: number): { id: string; next: number } {
    const next = counter + 1;
    return { id: `${prefix}-${next}`, next };
  }

  function makeAttachment(postId: string, filename: string, sizeBytes: number, mimeType: string): AttachmentDto {
    const next = nextId('attachment', attachmentCounter);
    attachmentCounter = next.next;
    const attachment: AttachmentDto = {
      id: next.id,
      postId,
      filename,
      mimeType,
      sizeBytes,
      createdAt: now
    };
    const existing = attachmentsByPost.get(postId) ?? [];
    attachmentsByPost.set(postId, [...existing, attachment]);
    return attachment;
  }

  function makePost(topicId: string, body: string): PostDto {
    const next = nextId('post', postCounter);
    postCounter = next.next;
    const post: PostDto = {
      id: next.id,
      topicId,
      tenantId: null,
      parentPostId: null,
      authorId: identity.id,
      body,
      sourceMessageId: null,
      silent: false,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      reactionCounts: []
    };
    const existing = postsByTopic.get(topicId) ?? [];
    postsByTopic.set(topicId, [...existing, post]);
    createdPostIds.push(post.id);
    return post;
  }

  function makeTopic(title: string): TopicDto {
    const next = nextId('topic', topicCounter);
    topicCounter = next.next;
    const topic: TopicDto = {
      id: next.id,
      forumId: forum.id,
      tenantId: null,
      title,
      status: 'open',
      robotMode: 'auto',
      tags: [],
      createdBy: identity.id,
      createdByName: identity.displayName,
      createdAt: now,
      updatedAt: now,
      postCount: 0,
      lastPostAuthorId: identity.id,
      lastPostAuthorName: identity.displayName,
      lastPostAt: now
    };
    topics.set(topic.id, topic);
    return topic;
  }

  async function fulfillJson(route: Route, body: unknown, status = 200, delayMs = 0): Promise<void> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await route.fulfill({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function pageResponse<T>(items: T[]): { page: number; pageSize: number; total: number; items: T[] } {
    return { page: 1, pageSize: 50, total: items.length, items };
  }

  async function handleRoute(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/auth/me' && method === 'GET') {
      return fulfillJson(route, {
        identity: {
          id: identity.id,
          displayName: identity.displayName,
          kind: identity.kind,
          parentIdentityId: null,
          avatarUrl: null,
          location: identity.location,
          signature: identity.signature,
          theme: identity.theme,
          hasPrivateEmail: false
        }
      });
    }

    if (path === `/api/identities/${identity.id}/permissions` && method === 'GET') {
      return fulfillJson(route, { permissions: [] });
    }

    if (path === '/api/forums' && method === 'GET') {
      return fulfillJson(route, [forum]);
    }

    if (path === '/api/user-files' && method === 'GET') {
      return fulfillJson(route, userFiles);
    }

    if (path === '/api/user-files' && method === 'POST') {
      const fallback = nextId('upload', userFileCounter);
      userFileCounter = fallback.next;
      const filename = extractFilename(request.postDataBuffer()) ?? `${fallback.id}.bin`;
      if (options.failUserFileUploads?.has(filename)) {
        return fulfillJson(route, { message: 'Upload failed: 413' }, 413, options.userFileUploadDelayMs ?? 0);
      }
      const sizeBytes = lookupSize(filename, 128);
      const fileId = nextId('user-file', userFileCounter);
      userFileCounter = fileId.next;
      const file: UserFileDto = {
        id: fileId.id,
        ownerId: identity.id,
        filename,
        mimeType: 'application/octet-stream',
        sizeBytes,
        createdAt: now
      };
      userFiles.unshift(file);
      return fulfillJson(route, file, 200, options.userFileUploadDelayMs ?? 0);
    }

    const userFilesMatch = path.match(/^\/api\/user-files\/([^/]+)$/);
    if (userFilesMatch && method === 'DELETE') {
      const fileId = userFilesMatch[1];
      if (options.failUserFileDeletes?.has(fileId)) {
        return fulfillJson(route, { message: 'Delete failed' }, 500);
      }
      const index = userFiles.findIndex((file) => file.id === fileId);
      if (index >= 0) {
        userFiles.splice(index, 1);
      }
      return fulfillJson(route, { ok: true });
    }

    const forumTopicsMatch = path.match(/^\/api\/forums\/([^/]+)\/topics$/);
    if (forumTopicsMatch) {
      if (method === 'GET') {
        return fulfillJson(route, pageResponse(Array.from(topics.values())));
      }
      if (method === 'POST') {
        const payload = request.postData() ? JSON.parse(request.postData() as string) : {};
        lastCreateTopicPayload = payload;
        const topic = makeTopic(payload.title ?? 'Untitled');
        const post = makePost(topic.id, payload.body ?? '');
        topic.postCount = 1;
        topic.lastPostAt = post.createdAt;
        topic.lastPostAuthorId = post.authorId;
        topic.lastPostAuthorName = identity.displayName;
        return fulfillJson(route, topic, 200);
      }
    }

    const topicMatch = path.match(/^\/api\/topics\/([^/]+)$/);
    if (topicMatch && method === 'GET') {
      const topic = topics.get(topicMatch[1]);
      return fulfillJson(route, topic ?? makeTopic('Recovered Topic'));
    }

    const topicPostsMatch = path.match(/^\/api\/topics\/([^/]+)\/posts$/);
    if (topicPostsMatch) {
      if (method === 'GET') {
        return fulfillJson(route, pageResponse(postsByTopic.get(topicPostsMatch[1]) ?? []));
      }
      if (method === 'POST') {
        const payload = request.postData() ? JSON.parse(request.postData() as string) : {};
        lastCreatePostPayload = payload;
        const post = makePost(topicPostsMatch[1], payload.body ?? '');
        const topic = topics.get(topicPostsMatch[1]);
        if (topic) {
          topic.postCount = (topic.postCount ?? 0) + 1;
          topic.lastPostAt = post.createdAt;
          topic.lastPostAuthorId = post.authorId;
          topic.lastPostAuthorName = identity.displayName;
        }
        return fulfillJson(route, post, 200);
      }
    }

    const topicIdentitiesMatch = path.match(/^\/api\/topics\/([^/]+)\/identities$/);
    if (topicIdentitiesMatch && method === 'GET') {
      return fulfillJson(route, pageResponse([identity]));
    }

    const topicPersonasMatch = path.match(/^\/api\/topics\/([^/]+)\/personas$/);
    if (topicPersonasMatch && method === 'GET') {
      return fulfillJson(route, { items: [] });
    }

    const topicStateMatch = path.match(/^\/api\/topics\/([^/]+)\/state$/);
    if (topicStateMatch && method === 'GET') {
      return fulfillJson(route, null);
    }

    const topicStreamMatch = path.match(/^\/api\/topics\/([^/]+)\/state\/stream$/);
    if (topicStreamMatch) {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' });
      return;
    }

    const topicSessionMatch = path.match(/^\/api\/topics\/([^/]+)\/session$/);
    if (topicSessionMatch && method === 'GET') {
      return fulfillJson(route, null);
    }

    const postsAttachmentsChunkedStart = path.match(/^\/api\/posts\/([^/]+)\/attachments\/chunked\/start$/);
    if (postsAttachmentsChunkedStart && method === 'POST') {
      const payload = request.postData() ? JSON.parse(request.postData() as string) : {};
      const next = nextId('upload', attachmentCounter);
      attachmentCounter = next.next;
      const uploadId = next.id;
      const sizeBytes = Number(payload.sizeBytes ?? 0);
      chunkedUploads.set(uploadId, {
        postId: postsAttachmentsChunkedStart[1],
        filename: payload.filename ?? 'chunked.bin',
        sizeBytes,
        mimeType: payload.mimeType ?? 'application/octet-stream'
      });
      requestLog.push(`chunk-start:${postsAttachmentsChunkedStart[1]}:${uploadId}`);
      return fulfillJson(route, {
        uploadId,
        chunkBytes: Math.max(1, Math.ceil(sizeBytes / 2)),
        totalChunks: 2
      });
    }

    const postsAttachmentsChunkedChunk = path.match(/^\/api\/posts\/([^/]+)\/attachments\/chunked\/([^/]+)\/chunk$/);
    if (postsAttachmentsChunkedChunk && method === 'POST') {
      return fulfillJson(route, { ok: true });
    }

    const postsAttachmentsChunkedComplete = path.match(/^\/api\/posts\/([^/]+)\/attachments\/chunked\/([^/]+)\/complete$/);
    if (postsAttachmentsChunkedComplete && method === 'POST') {
      const uploadId = postsAttachmentsChunkedComplete[2];
      const meta = chunkedUploads.get(uploadId);
      if (!meta) {
        return fulfillJson(route, { message: 'Upload not found' }, 404);
      }
      const attachment = makeAttachment(meta.postId, meta.filename, meta.sizeBytes, meta.mimeType);
      requestLog.push(`upload:${meta.postId}:${meta.filename}`);
      return fulfillJson(route, attachment, 200, options.attachmentUploadDelayMs ?? 0);
    }

    const postsAttachmentsMatch = path.match(/^\/api\/posts\/([^/]+)\/attachments$/);
    if (postsAttachmentsMatch) {
      const postId = postsAttachmentsMatch[1];
      if (method === 'GET') {
        return fulfillJson(route, attachmentsByPost.get(postId) ?? []);
      }
      if (method === 'POST') {
        const fallback = nextId('attachment', attachmentCounter);
        attachmentCounter = fallback.next;
        const filename = extractFilename(request.postDataBuffer()) ?? `${fallback.id}.bin`;
        if (options.failAttachmentUploads?.has(filename)) {
          return fulfillJson(route, { message: 'Upload failed: 500' }, 500, options.attachmentUploadDelayMs ?? 0);
        }
        const sizeBytes = lookupSize(filename, 512);
        const attachment = makeAttachment(postId, filename, sizeBytes, 'application/octet-stream');
        requestLog.push(`upload:${postId}:${filename}`);
        return fulfillJson(route, attachment, 200, options.attachmentUploadDelayMs ?? 0);
      }
    }

    const attachmentsDeleteMatch = path.match(/^\/api\/attachments\/([^/]+)$/);
    if (attachmentsDeleteMatch && method === 'DELETE') {
      requestLog.push(`delete:${attachmentsDeleteMatch[1]}`);
      return fulfillJson(route, { ok: true });
    }

    const postDispatchMatch = path.match(/^\/api\/posts\/([^/]+)\/dispatch$/);
    if (postDispatchMatch && method === 'POST') {
      const postId = postDispatchMatch[1];
      const post = Array.from(postsByTopic.values()).flat().find((item) => item.id === postId);
      requestLog.push(`dispatch:${postId}`);
      return fulfillJson(route, { ok: true, dispatched: true, post });
    }

    return fulfillJson(route, { message: `Unmocked request: ${method} ${path}` }, 500);
  }

  return {
    attach: async (page: Page) => {
      await page.route('**/api/**', handleRoute);
      return {
        requestLog,
        createdPostIds,
        getLastCreateTopicPayload: () => lastCreateTopicPayload,
        getLastCreatePostPayload: () => lastCreatePostPayload
      };
    }
  };
}

async function enableAuth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cforum_auth_token', 'test-token');
    window.localStorage.setItem('cforum_refresh_token', 'test-refresh');
  });
}

async function clearAuth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.removeItem('cforum_auth_token');
    window.localStorage.removeItem('cforum_refresh_token');
  });
}

async function gotoNewThreadComposer(page: Page, url: string): Promise<void> {
  await enableAuth(page);
  await page.goto(url);
  if (await page.locator('#thread-title').count() === 0) {
    await page.evaluate(() => {
      window.localStorage.setItem('cforum_auth_token', 'test-token');
      window.localStorage.setItem('cforum_refresh_token', 'test-refresh');
    });
    await page.goto(url);
  }
  await expect(page.locator('#thread-title')).toBeVisible();
}

test.describe('Attachment lifecycle', () => {
  test('creates thread with pending attachments and supports quick reply uploads', async ({ page }) => {
    const largeFileSize = 90 * 1024 * 1024 + 4;
    const firstContents = 'first file';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-attachments-'));
    const largeFilePath = path.join(tempDir, 'chunked.bin');
    const firstFilePath = path.join(tempDir, 'first.txt');
    fs.writeFileSync(firstFilePath, firstContents);
    fs.writeFileSync(largeFilePath, 'synthetic');
    const fileSizes = {
      'first.txt': Buffer.byteLength(firstContents),
      'chunked.bin': largeFileSize,
      'reply-a.txt': 7,
      'reply-b.txt': 9
    };
    const mock = createMockApi({ fileSizeByName: fileSizes, attachmentUploadDelayMs: 50 });
    const mockState = await mock.attach(page);

    try {
      await page.addInitScript(() => {
        const sizeDescriptor = Object.getOwnPropertyDescriptor(File.prototype, 'size');
        const originalGetSize = sizeDescriptor?.get;
        const originalSlice = File.prototype.slice;
        window.__codexFileOverrides = { originalGetSize, originalSlice };
        Object.defineProperty(File.prototype, 'size', {
          get() {
            if (this.name === 'chunked.bin') {
              return 90 * 1024 * 1024 + 4;
            }
            return originalGetSize ? originalGetSize.call(this) : 0;
          }
        });
        File.prototype.slice = function slice(start?: number, end?: number, contentType?: string) {
          if (this.name === 'chunked.bin') {
            return new Blob([], { type: contentType ?? this.type });
          }
          return originalSlice.call(this, start, end, contentType);
        };
      });

      await gotoNewThreadComposer(page, '/forums/forum-1/newthread');
      await page.locator('#thread-title').fill('Attachment thread');
      await page.locator('.vb-editor-textarea').fill('This thread verifies attachment uploads.');

      const fileInput = page.locator('.vb-newthread-form .vb-attachment-input');
      await fileInput.setInputFiles([firstFilePath, largeFilePath]);

      await expect(page.locator('.vb-attachment-selected')).toContainText('first.txt');
      await expect(page.locator('.vb-attachment-selected')).toContainText('chunked.bin');

      const submitButton = page.locator('.vb-form-actions .vb-btn-primary');
      await submitButton.click();

      await expect(submitButton).toBeDisabled();
      await expect(submitButton).toContainText('Uploading');

      await expect(page).toHaveURL(/\/topics\/topic-/, { timeout: 20000 });

      const createPayload = mockState.getLastCreateTopicPayload();
      expect(createPayload?.attachmentsPending).toBe(true);

      const [initialPostId] = mockState.createdPostIds;
      const uploadIndices = mockState.requestLog
        .map((entry, index) => (entry.startsWith(`upload:${initialPostId}`) ? index : -1))
        .filter((index) => index >= 0);
      const dispatchIndex = mockState.requestLog.findIndex((entry) => entry === `dispatch:${initialPostId}`);
      expect(dispatchIndex).toBeGreaterThan(Math.max(...uploadIndices));

      const firstAttachmentLink = page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'first.txt' });
      const chunkedAttachmentLink = page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'chunked.bin' });
      await expect(firstAttachmentLink).toBeVisible();
      await expect(firstAttachmentLink).toHaveAttribute('href', /\/api\/attachments\/attachment-/);
      await expect(chunkedAttachmentLink).toBeVisible();

      const removeButton = page.locator('.vb-attachment-item', { hasText: 'first.txt' }).locator('button', { hasText: 'Remove' });
      await removeButton.click();
      await expect(page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'first.txt' })).toHaveCount(0);

      const quickReply = page.locator('.vb-quick-reply');
      await quickReply.locator('textarea').fill('Replying with attachments.');
      await quickReply.locator('.vb-attachment-input').setInputFiles([
        { name: 'reply-a.txt', mimeType: 'text/plain', buffer: Buffer.from('reply-a') },
        { name: 'reply-b.txt', mimeType: 'text/plain', buffer: Buffer.from('reply-b') }
      ]);

      const quickReplyButton = quickReply.locator('.vb-btn', { hasText: 'Post Quick Reply' });
      await quickReplyButton.click();
      await expect(quickReplyButton).toBeDisabled();

      const [, replyPostId] = mockState.createdPostIds;
      const replyUploadIndices = mockState.requestLog
        .map((entry, index) => (entry.startsWith(`upload:${replyPostId}`) ? index : -1))
        .filter((index) => index >= 0);
      const replyDispatchIndex = mockState.requestLog.findIndex((entry) => entry === `dispatch:${replyPostId}`);
      expect(replyDispatchIndex).toBeGreaterThan(Math.max(...replyUploadIndices));

      const replyPayload = mockState.getLastCreatePostPayload();
      expect(replyPayload?.attachmentsPending).toBe(true);

      await expect(page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'reply-a.txt' })).toBeVisible();
      await expect(page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'reply-b.txt' })).toBeVisible();
    } finally {
      await page.evaluate(() => {
        const overrides = window.__codexFileOverrides;
        if (!overrides) return;
        if (overrides.originalGetSize) {
          Object.defineProperty(File.prototype, 'size', { get: overrides.originalGetSize });
        }
        if (overrides.originalSlice) {
          File.prototype.slice = overrides.originalSlice;
        }
        delete window.__codexFileOverrides;
      });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('handles rapid sequential uploads in the reply page', async ({ page }) => {
    const fileSizes = {
      'multi-1.txt': 15,
      'multi-2.txt': 18,
      'multi-3.txt': 21
    };
    const mock = createMockApi({ fileSizeByName: fileSizes, attachmentUploadDelayMs: 60 });
    const mockState = await mock.attach(page);

    await gotoNewThreadComposer(page, '/forums/forum-1/newthread');
    await page.locator('#thread-title').fill('Reply flow');
    await page.locator('.vb-editor-textarea').fill('Starting a thread for reply uploads.');
    await page.locator('.vb-form-actions .vb-btn-primary').click();
    await expect(page).toHaveURL(/\/topics\/topic-1/);

    await page.goto('/topics/topic-1/reply');
    await page.locator('.vb-editor-textarea').fill('Replying with multiple attachments.');
    await page.locator('.vb-reply-attachments .vb-attachment-input').setInputFiles([
      { name: 'multi-1.txt', mimeType: 'text/plain', buffer: Buffer.from('file-one') },
      { name: 'multi-2.txt', mimeType: 'text/plain', buffer: Buffer.from('file-two') },
      { name: 'multi-3.txt', mimeType: 'text/plain', buffer: Buffer.from('file-three') }
    ]);

    const submitButton = page.locator('.vb-form-actions .vb-btn-primary');
    await submitButton.click();
    await expect(submitButton).toBeDisabled();
    await expect(submitButton).toContainText('Uploading');
    await expect(page.locator('.vb-editor-textarea')).toBeEnabled();

    const replyPayload = mockState.getLastCreatePostPayload();
    expect(replyPayload?.attachmentsPending).toBe(true);

    await expect(page).toHaveURL(/\/topics\/topic-1/);
    await expect(page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'multi-1.txt' })).toBeVisible();
    await expect(page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'multi-2.txt' })).toBeVisible();
    await expect(page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'multi-3.txt' })).toBeVisible();
  });

  test('shows an error banner when attachment uploads fail', async ({ page }) => {
    const mock = createMockApi({
      failAttachmentUploads: new Set(['broken.txt']),
      attachmentUploadDelayMs: 40
    });
    await mock.attach(page);

    await gotoNewThreadComposer(page, '/forums/forum-1/newthread');
    await page.locator('#thread-title').fill('Failure thread');
    await page.locator('.vb-editor-textarea').fill('Thread to verify attachment failures.');
    await page.locator('.vb-form-actions .vb-btn-primary').click();
    await expect(page).toHaveURL(/\/topics\/topic-1/);

    const quickReply = page.locator('.vb-quick-reply');
    await quickReply.locator('textarea').fill('This reply has a broken attachment.');
    await quickReply.locator('.vb-attachment-input').setInputFiles([
      { name: 'broken.txt', mimeType: 'text/plain', buffer: Buffer.from('broken') }
    ]);

    await quickReply.locator('.vb-btn', { hasText: 'Post Quick Reply' }).click();

    await expect(page.locator('.vb-banner')).toContainText('Upload failed');
    await expect(page.locator('.vb-post-attachments .vb-attachment-link', { hasText: 'broken.txt' })).toHaveCount(0);
  });

  test('uploads user files, copies links, and updates totals', async ({ page }) => {
    const fileSizes = {
      'alpha.txt': 100,
      'beta.txt': 200
    };
    const mock = createMockApi({ fileSizeByName: fileSizes, userFileUploadDelayMs: 50 });
    await mock.attach(page);

    await page.addInitScript(() => {
      window.localStorage.setItem('cforum_auth_token', 'test-token');
      window.localStorage.setItem('cforum_refresh_token', 'test-refresh');
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async () => Promise.resolve() },
        configurable: true
      });
    });

    await page.goto('/files');

    const fileInput = page.locator('.vb-user-files .vb-attachment-input');
    await fileInput.setInputFiles([
      { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.alloc(100, 1) },
      { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.alloc(200, 1) }
    ]);

    const uploadButton = page.locator('.vb-user-files .vb-user-files-actions .vb-btn', { hasText: 'Upload' });
    await uploadButton.click();

    await expect(uploadButton).toBeDisabled();
    await expect(uploadButton).toContainText('Uploading');
    await expect(page.locator('.vb-success-banner')).toContainText('Uploaded 2 files');

    await expect(page.locator('.vb-user-file-name', { hasText: 'alpha.txt' })).toBeVisible();
    await expect(page.locator('.vb-user-file-name', { hasText: 'beta.txt' })).toBeVisible();

    await expect(page.locator('.vb-user-files-total')).toContainText('2 files');
    await expect(page.locator('.vb-user-files-total')).toContainText('300 B');

    const alphaItem = page.locator('.vb-user-file-item', { hasText: 'alpha.txt' });
    await expect(alphaItem.locator('.vb-user-file-input')).toHaveValue(/user-files\/user-file-/);

    const copyButton = alphaItem.locator('button').filter({ hasText: /Copy Link|Copied!/ });
    await copyButton.click();
    await expect(page.locator('.vb-success-banner')).toContainText('Link copied to clipboard');
    await expect(copyButton).toContainText('Copied!');

    const deleteButton = page.locator('.vb-user-file-item', { hasText: 'beta.txt' }).locator('button', { hasText: 'Delete' });
    await deleteButton.click();

    await expect(page.locator('.vb-user-file-name', { hasText: 'beta.txt' })).toHaveCount(0);
    await expect(page.locator('.vb-user-files-total')).toContainText('1 file');
    await expect(page.locator('.vb-user-files-total')).toContainText('100 B');
  });

  test('shows empty state when visiting file storage while logged out', async ({ page }) => {
    const mock = createMockApi();
    await mock.attach(page);

    await clearAuth(page);
    await page.goto('/files');

    await expect(page.locator('.vb-user-files')).toContainText('You must be logged in to manage your uploads.');
    await expect(page.locator('.vb-user-files .vb-btn', { hasText: 'Return to Forum' })).toBeVisible();
  });

  test('surfaces upload and delete errors without listing partial files', async ({ page }) => {
    const initialFiles: UserFileDto[] = [
      {
        id: 'user-file-9',
        ownerId: 'identity-1',
        filename: 'existing.txt',
        mimeType: 'text/plain',
        sizeBytes: 120,
        createdAt: '2025-01-01T12:00:00.000Z'
      },
      {
        id: 'user-file-10',
        ownerId: 'identity-1',
        filename: 'recoverable.txt',
        mimeType: 'text/plain',
        sizeBytes: 64,
        createdAt: '2025-01-01T12:10:00.000Z'
      }
    ];
    const fileSizes = {
      'good.txt': 80,
      'oversized.bin': 130
    };
    const mock = createMockApi({
      initialUserFiles: initialFiles,
      fileSizeByName: fileSizes,
      failUserFileUploads: new Set(['oversized.bin']),
      failUserFileDeletes: new Set(['user-file-9'])
    });
    await mock.attach(page);

    await page.addInitScript(() => {
      window.localStorage.setItem('cforum_auth_token', 'test-token');
      window.localStorage.setItem('cforum_refresh_token', 'test-refresh');
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async () => Promise.resolve() },
        configurable: true
      });
    });

    await page.goto('/files');

    const fileInput = page.locator('.vb-user-files .vb-attachment-input');
    await fileInput.setInputFiles([
      { name: 'good.txt', mimeType: 'text/plain', buffer: Buffer.alloc(80, 1) },
      { name: 'oversized.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(130, 1) }
    ]);

    await page.locator('.vb-user-files .vb-user-files-actions .vb-btn', { hasText: 'Upload' }).click();

    await expect(page.locator('.vb-login-error')).toContainText('Upload failed');
    await expect(page.locator('.vb-user-file-name', { hasText: 'existing.txt' })).toBeVisible();
    await expect(page.locator('.vb-user-file-name', { hasText: 'good.txt' })).toHaveCount(0);

    const deleteButton = page.locator('.vb-user-file-item', { hasText: 'existing.txt' }).locator('button', { hasText: 'Delete' });
    await deleteButton.click();

    await expect(page.locator('.vb-login-error')).toContainText('Delete failed');
    await expect(page.locator('.vb-user-file-name', { hasText: 'existing.txt' })).toBeVisible();

    const recoveryDelete = page.locator('.vb-user-file-item', { hasText: 'recoverable.txt' }).locator('button', { hasText: 'Delete' });
    await recoveryDelete.click();

    await expect(page.locator('.vb-user-file-name', { hasText: 'recoverable.txt' })).toHaveCount(0);
    await expect(page.locator('.vb-login-error')).toHaveCount(0);
    await expect(page.locator('.vb-user-file-name', { hasText: 'existing.txt' })).toBeVisible();
  });
});
