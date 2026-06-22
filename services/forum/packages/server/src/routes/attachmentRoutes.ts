import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { AttachmentChunkedStartRequestSchema } from '@irrigationreal/codex-forum-contracts';
import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';
import type { StreamBusInterface } from '../streamBus';
import { buildTtsStoragePath, generateTtsMp3, isTtsStoragePath } from '../tts';
import { shouldInlineAttachment } from '../utils/attachments';
import { mapAttachmentRowToDomain, mapUserFileRowToDomain } from '../mappers/db';
import { mapAttachmentToDto, mapUserFileToDto } from '../mappers/dto';
import { parseBody } from '../utils/validation';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_TOTAL_ATTACHMENTS_BYTES,
  MAX_TOTAL_USER_FILES_BYTES,
  TTS_AVAILABLE,
  TTS_MAX_CHARS,
  TTS_SCRIPT,
  UPLOADS_DIR,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_TEMP_DIR,
  USER_FILES_DIR,
  PENDING_ATTACHMENTS_DIR,
  PENDING_ATTACHMENT_TTL_MS,
  INTERNAL_API_TOKEN
} from '../runtimeConfig';

export function registerAttachmentRoutes({
  app,
  store,
  access,
  bus
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
  bus?: StreamBusInterface;
}): void {
  const { getCurrentUser, requireModerator, requireScope, requireTopicVisible, requirePostVisible } = access;

  function tokenMatches(value: string | null): boolean {
    if (!value || !INTERNAL_API_TOKEN) return false;
    const expected = Buffer.from(INTERNAL_API_TOKEN);
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function requireInternalAgent(request: any): void {
    if (!INTERNAL_API_TOKEN) {
      throw app.httpErrors.serviceUnavailable('internal agent uploads are not configured');
    }

    const headers = request.headers ?? {};
    const authorization = typeof headers.authorization === 'string' ? headers.authorization : null;
    const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    const internalToken = typeof headers['x-internal-token'] === 'string' ? headers['x-internal-token'] : null;

    if (tokenMatches(internalToken) || tokenMatches(bearerToken)) {
      return;
    }

    throw app.httpErrors.unauthorized('internal agent token required');
  }

  // Attachment endpoints
  function sha256File(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  function findExistingTtsAttachment(postId: string) {
    const attachments = store.listAttachmentsByPost(postId);
    return attachments.find((attachment) => isTtsStoragePath(UPLOADS_DIR, attachment.storage_path)) ?? null;
  }

  function emitChatAttachment(postId: string, attachment: ReturnType<ForumStore['createAttachment']>) {
    if (!bus) return;
    const post = store.getPost(postId);
    if (!post) return;
    bus.emit(post.topic_id, {
      type: 'chat_attachment',
      data: {
        roomId: post.topic_id,
        postId,
        attachment: mapAttachmentToDto(mapAttachmentRowToDomain(attachment))
      }
    });
  }

  async function ensureTtsAttachment(postId: string, text: string) {
    const existing = findExistingTtsAttachment(postId);
    if (existing) return existing;

    const trimmed = text.trim();
    if (!trimmed) {
      throw app.httpErrors.badRequest('post body is empty');
    }

    const hash = createHash('sha256').update(trimmed).digest('hex');
    const storageId = `tts_${hash}`;
    const storagePath = buildTtsStoragePath(UPLOADS_DIR, storageId);
    const filename = `${storageId}.mp3`;

    if (!existsSync(storagePath)) {
      const result = await generateTtsMp3({
        scriptPath: TTS_SCRIPT,
        text: trimmed,
        outPath: storagePath,
        maxChars: Number.isFinite(TTS_MAX_CHARS) ? TTS_MAX_CHARS : 2500
      });
      if (!result.ok) {
        throw app.httpErrors.badRequest(result.error ?? 'TTS generation failed');
      }
    }

    const sizeBytes = statSync(storagePath).size;
    return store.createAttachment({
      postId,
      filename,
      mimeType: 'audio/mpeg',
      sizeBytes,
      storagePath,
      sha256: sha256File(storagePath)
    });
  }

  app.post('/posts/:postId/tts', async (request) => {
    if (!TTS_AVAILABLE) {
      throw app.httpErrors.badRequest('TTS is not configured');
    }
    const { postId } = request.params as { postId: string };

    const post = store.getPost(postId);
    if (!post) {
      throw app.httpErrors.notFound('post not found');
    }
    requireTopicVisible(post.topic_id, request);

    const author = store.getIdentity(post.author_id);
    if (!author || author.kind !== 'robot') {
      throw app.httpErrors.forbidden('TTS is only available for robot posts');
    }

    const attachment = await ensureTtsAttachment(postId, post.body);

    return mapAttachmentToDto(mapAttachmentRowToDomain(attachment));
  });

  type ChunkedUploadMeta = {
    uploadId: string;
    postId: string;
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    totalChunks: number;
    createdAt: string;
    updatedAt: string;
  };

  function getUploadSessionDir(uploadId: string): string {
    return join(UPLOAD_TEMP_DIR, uploadId);
  }

  function getUploadMetaPath(uploadId: string): string {
    return join(getUploadSessionDir(uploadId), 'meta.json');
  }

  function readUploadMeta(uploadId: string): ChunkedUploadMeta {
    const raw = readFileSync(getUploadMetaPath(uploadId), 'utf8');
    return JSON.parse(raw) as ChunkedUploadMeta;
  }

  function safeReadUploadMeta(uploadId: string): ChunkedUploadMeta {
    try {
      return readUploadMeta(uploadId);
    } catch {
      throw app.httpErrors.badRequest('upload session not found');
    }
  }

  function writeUploadMeta(uploadId: string, meta: ChunkedUploadMeta): void {
    writeFileSync(getUploadMetaPath(uploadId), JSON.stringify(meta, null, 2));
  }

  function deleteUploadSession(uploadId: string): void {
    const dir = getUploadSessionDir(uploadId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function ensureUploadSessionActive(meta: ChunkedUploadMeta): void {
    const createdAt = new Date(meta.createdAt).getTime();
    if (!Number.isFinite(createdAt)) {
      deleteUploadSession(meta.uploadId);
      throw app.httpErrors.badRequest('Upload session is invalid');
    }
    if (Date.now() - createdAt > UPLOAD_SESSION_TTL_MS) {
      deleteUploadSession(meta.uploadId);
      throw app.httpErrors.badRequest('Upload session has expired');
    }
  }

  async function appendFileToStream(sourcePath: string, destination: NodeJS.WritableStream): Promise<void> {
    const stream = createReadStream(sourcePath);
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      destination.on('error', reject);
      destination.on('drain', () => undefined);
      stream.on('end', resolve);
      stream.pipe(destination, { end: false });
    });
  }

  function assertAttachmentUploadAllowed(
    postId: string,
    userId: string,
    request: any,
    sessionStartedAt?: string | null
  ): { post: any; topic: any } {
    const post = store.getPost(postId);
    if (!post) {
      throw app.httpErrors.notFound('post not found');
    }
    requireTopicVisible(post.topic_id, request);

    if (post.author_id !== userId) {
      throw app.httpErrors.forbidden('Only the post author can add attachments');
    }

    const postAge = Date.now() - new Date(post.created_at).getTime();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    if (postAge > maxAge) {
      if (sessionStartedAt) {
        const sessionAge = new Date(sessionStartedAt).getTime() - new Date(post.created_at).getTime();
        if (!Number.isFinite(sessionAge) || sessionAge > maxAge) {
          throw app.httpErrors.forbidden('Attachments can only be added within 5 minutes of posting');
        }
      } else {
        throw app.httpErrors.forbidden('Attachments can only be added within 5 minutes of posting');
      }
    }

    const topic = store.getTopic(post.topic_id);
    if (topic && (topic.status === 'locked' || topic.status === 'archived')) {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }

    return { post, topic };
  }

  app.post('/posts/:postId/attachments/chunked/start', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');

    const { postId } = request.params as { postId: string };
    assertAttachmentUploadAllowed(postId, user.identityId, request);

    const body = parseBody(app, AttachmentChunkedStartRequestSchema, request.body);

    const sizeBytes = Number(body.sizeBytes);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw app.httpErrors.badRequest('sizeBytes must be a positive number');
    }
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw app.httpErrors.badRequest(`File size exceeds limit of ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`);
    }

    const uploadId = randomUUID();
    const uploadDir = getUploadSessionDir(uploadId);
    mkdirSync(uploadDir, { recursive: true });

    const totalChunks = Math.max(1, Math.ceil(sizeBytes / MAX_CHUNK_BYTES));
    const now = new Date().toISOString();
    const meta: ChunkedUploadMeta = {
      uploadId,
      postId,
      userId: user.identityId,
      filename: body.filename,
      mimeType: body.mimeType || 'application/octet-stream',
      sizeBytes,
      totalChunks,
      createdAt: now,
      updatedAt: now
    };
    writeUploadMeta(uploadId, meta);

    return {
      uploadId,
      chunkBytes: MAX_CHUNK_BYTES,
      totalChunks
    };
  });

  app.post(
    '/posts/:postId/attachments/chunked/:uploadId/chunk',
    { bodyLimit: MAX_CHUNK_BYTES + 4 * 1024 * 1024 },
    async (request) => {
      const user = requireScope(getCurrentUser(request), 'write');

      const { postId, uploadId } = request.params as { postId: string; uploadId: string };
      const query = request.query as { index?: string };
      const index = Number(query.index);
      if (!Number.isFinite(index) || index < 0) {
        throw app.httpErrors.badRequest('index is required');
      }

      const meta = safeReadUploadMeta(uploadId);
      ensureUploadSessionActive(meta);
      if (meta.postId !== postId || meta.userId !== user.identityId) {
        throw app.httpErrors.forbidden('upload session mismatch');
      }

      assertAttachmentUploadAllowed(postId, user.identityId, request, meta.createdAt);

      if (index >= meta.totalChunks) {
        throw app.httpErrors.badRequest('chunk index out of range');
      }

      const data = await request.file();
      if (!data) {
        throw app.httpErrors.badRequest('chunk file is required');
      }

      const chunkPath = join(getUploadSessionDir(uploadId), `${index}.part`);
      await pipeline(data.file, createWriteStream(chunkPath));

      if (data.file.truncated) {
        unlinkSync(chunkPath);
        throw app.httpErrors.badRequest(`Chunk exceeds limit of ${MAX_CHUNK_BYTES / (1024 * 1024)}MB`);
      }

      const now = new Date().toISOString();
      writeUploadMeta(uploadId, { ...meta, updatedAt: now });

      return { ok: true, index };
    }
  );

  app.post('/posts/:postId/attachments/chunked/:uploadId/complete', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');

    const { postId, uploadId } = request.params as { postId: string; uploadId: string };
    const meta = safeReadUploadMeta(uploadId);
    ensureUploadSessionActive(meta);
    if (meta.postId !== postId || meta.userId !== user.identityId) {
      throw app.httpErrors.forbidden('upload session mismatch');
    }

    assertAttachmentUploadAllowed(postId, user.identityId, request, meta.createdAt);

    const uploadDir = getUploadSessionDir(uploadId);
    const parts = readdirSync(uploadDir).filter((name) => name.endsWith('.part'));
    if (parts.length < meta.totalChunks) {
      throw app.httpErrors.badRequest('missing chunks');
    }

    for (let i = 0; i < meta.totalChunks; i += 1) {
      const partPath = join(uploadDir, `${i}.part`);
      if (!existsSync(partPath)) {
        throw app.httpErrors.badRequest('missing chunks');
      }
    }

    const fileId = randomUUID();
    const ext = meta.filename.includes('.') ? meta.filename.split('.').pop() : '';
    const storageName = ext ? `${fileId}.${ext}` : fileId;
    const storagePath = join(UPLOADS_DIR, storageName);
    const output = createWriteStream(storagePath);

    let assembledBytes = 0;
    try {
      for (let i = 0; i < meta.totalChunks; i += 1) {
        const partPath = join(uploadDir, `${i}.part`);
        assembledBytes += statSync(partPath).size;
        await appendFileToStream(partPath, output);
      }
    } catch (err) {
      output.destroy();
      if (existsSync(storagePath)) {
        unlinkSync(storagePath);
      }
      throw err;
    }

    await new Promise<void>((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
      output.end();
    });

    if (assembledBytes !== meta.sizeBytes) {
      if (existsSync(storagePath)) {
        unlinkSync(storagePath);
      }
      deleteUploadSession(uploadId);
      throw app.httpErrors.badRequest('uploaded size does not match');
    }

    const existingAttachments = store.listAttachmentsByPost(postId);
    const existingTotalBytes = existingAttachments.reduce((total, attachmentItem) => total + attachmentItem.size_bytes, 0);
    if (existingTotalBytes + assembledBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
      if (existsSync(storagePath)) {
        unlinkSync(storagePath);
      }
      deleteUploadSession(uploadId);
      throw app.httpErrors.badRequest(
        `Total attachments exceed limit of ${MAX_TOTAL_ATTACHMENTS_BYTES / (1024 * 1024)}MB`
      );
    }

    const attachment = store.createAttachment({
      postId,
      filename: meta.filename,
      mimeType: meta.mimeType,
      sizeBytes: assembledBytes,
      storagePath,
      sha256: sha256File(storagePath)
    });

    deleteUploadSession(uploadId);

    emitChatAttachment(postId, attachment);

    return mapAttachmentToDto(mapAttachmentRowToDomain(attachment));
  });

  app.post('/posts/:postId/attachments/chunked/:uploadId/abort', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');

    const { postId, uploadId } = request.params as { postId: string; uploadId: string };
    const meta = safeReadUploadMeta(uploadId);
    if (meta.postId !== postId || meta.userId !== user.identityId) {
      throw app.httpErrors.forbidden('upload session mismatch');
    }

    deleteUploadSession(uploadId);
    return { ok: true };
  });

  // Agent pending attachment upload. These blobs are stored in forum upload storage
  // before the final robot post, then linked by [forum-attachment id=...] references.
  app.post('/agent/topics/:topicId/pending-attachments', { bodyLimit: MAX_REQUEST_BODY_BYTES }, async (request) => {
    requireInternalAgent(request);
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    if (!topic) throw app.httpErrors.notFound('topic not found');
    if (topic.status === 'locked' || topic.status === 'archived') {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }
    const data = await request.file();
    if (!data) throw app.httpErrors.badRequest('file is required');

    mkdirSync(PENDING_ATTACHMENTS_DIR, { recursive: true });
    const fileId = randomUUID();
    const ext = data.filename.includes('.') ? data.filename.split('.').pop() : '';
    const storageName = ext ? `pending_${fileId}.${ext}` : `pending_${fileId}`;
    const storagePath = join(PENDING_ATTACHMENTS_DIR, storageName);
    await pipeline(data.file, createWriteStream(storagePath));
    if (data.file.truncated) {
      unlinkSync(storagePath);
      throw app.httpErrors.badRequest(`File size exceeds limit of ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`);
    }
    const sizeBytes = data.file.bytesRead;
    const sha256 = sha256File(storagePath);
    const expiresAt = new Date(Date.now() + PENDING_ATTACHMENT_TTL_MS).toISOString();
    const pending = store.createPendingAttachment({
      topicId,
      filename: data.filename,
      mimeType: data.mimetype || 'application/octet-stream',
      sizeBytes,
      storagePath,
      sha256,
      createdBy: 'agent',
      expiresAt,
    });
    return {
      id: pending.id,
      pendingAttachmentId: pending.id,
      filename: pending.filename,
      mimeType: pending.mime_type,
      sizeBytes: pending.size_bytes,
      sha256: pending.sha256,
      reference: `[forum-attachment id="${pending.id}"]`,
      expiresAt: pending.expires_at,
    };
  });

  // User file storage
  app.get('/user-files', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');

    const files = store.listUserFilesByIdentity(user.identityId);
    return files.map((file) => mapUserFileToDto(mapUserFileRowToDomain(file)));
  });

  app.post('/user-files', { bodyLimit: MAX_REQUEST_BODY_BYTES }, async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');

    const data = await request.file();
    if (!data) {
      throw app.httpErrors.badRequest('file is required');
    }

    const fileId = randomUUID();
    const ext = data.filename.includes('.') ? data.filename.split('.').pop() : '';
    const storageName = ext ? `${fileId}.${ext}` : fileId;
    const storagePath = join(USER_FILES_DIR, storageName);

    await pipeline(data.file, createWriteStream(storagePath));

    if (data.file.truncated) {
      unlinkSync(storagePath);
      throw app.httpErrors.badRequest(`File size exceeds limit of ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`);
    }

    const sizeBytes = data.file.bytesRead;
    const existingFiles = store.listUserFilesByIdentity(user.identityId);
    const existingTotalBytes = existingFiles.reduce((total, file) => total + file.size_bytes, 0);
    if (existingTotalBytes + sizeBytes > MAX_TOTAL_USER_FILES_BYTES) {
      unlinkSync(storagePath);
      throw app.httpErrors.badRequest(
        `Total stored files exceed limit of ${MAX_TOTAL_USER_FILES_BYTES / (1024 * 1024)}MB`
      );
    }

    const fileRecord = store.createUserFile({
      identityId: user.identityId,
      filename: data.filename,
      mimeType: data.mimetype,
      sizeBytes,
      storagePath
    });

    return mapUserFileToDto(mapUserFileRowToDomain(fileRecord));
  });

  app.get('/user-files/:fileId', async (request, reply) => {
    const user = requireScope(getCurrentUser(request), 'read');
    const { fileId } = request.params as { fileId: string };
    const file = store.getUserFile(fileId);
    if (!file) {
      throw app.httpErrors.notFound('file not found');
    }
    if (file.identity_id !== user.identityId) {
      const fileOwner = store.getIdentity(file.identity_id);
      requireModerator(request, fileOwner?.tenant_id ?? null);
    }
    if (!existsSync(file.storage_path)) {
      throw app.httpErrors.notFound('file not found');
    }

    reply.header('Content-Type', file.mime_type);
    const safeName = file.filename.replace(/[\r\n"]/g, '');
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);

    return reply.send(createReadStream(file.storage_path));
  });

  app.delete('/user-files/:fileId', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');

    const { fileId } = request.params as { fileId: string };
    const file = store.getUserFile(fileId);
    if (!file) {
      throw app.httpErrors.notFound('file not found');
    }
    if (file.identity_id !== user.identityId) {
      const fileOwner = store.getIdentity(file.identity_id);
      requireModerator(request, fileOwner?.tenant_id ?? null);
    }

    if (existsSync(file.storage_path)) {
      unlinkSync(file.storage_path);
    }
    store.deleteUserFile(fileId);

    return { ok: true };
  });

  // Only allow author to upload attachments within 5 minutes of creating a post
  app.post(
    '/posts/:postId/attachments',
    { bodyLimit: MAX_REQUEST_BODY_BYTES },
    async (request) => {
      const user = requireScope(getCurrentUser(request), 'write');

      const { postId } = request.params as { postId: string };

      const post = store.getPost(postId);
      if (!post) {
        throw app.httpErrors.notFound('post not found');
      }
      requireTopicVisible(post.topic_id, request);

      // Only the post author can add attachments
      if (post.author_id !== user.identityId) {
        throw app.httpErrors.forbidden('Only the post author can add attachments');
      }

      // Only allow uploads within 5 minutes of post creation
      const postAge = Date.now() - new Date(post.created_at).getTime();
      const maxAge = 5 * 60 * 1000; // 5 minutes
      if (postAge > maxAge) {
        throw app.httpErrors.forbidden('Attachments can only be added within 5 minutes of posting');
      }

      const topic = store.getTopic(post.topic_id);
      if (topic && (topic.status === 'locked' || topic.status === 'archived')) {
        throw app.httpErrors.forbidden('topic is locked or archived');
      }

      const data = await request.file();
      if (!data) {
        throw app.httpErrors.badRequest('file is required');
      }

      const fileId = randomUUID();
      const ext = data.filename.includes('.') ? data.filename.split('.').pop() : '';
      const storageName = ext ? `${fileId}.${ext}` : fileId;
      const storagePath = join(UPLOADS_DIR, storageName);

      // Save file to disk
      await pipeline(data.file, createWriteStream(storagePath));

      // Check if file was truncated (exceeded size limit)
      if (data.file.truncated) {
        unlinkSync(storagePath);
        throw app.httpErrors.badRequest(`File size exceeds limit of ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`);
      }

      // Get actual file size from stream
      const sizeBytes = data.file.bytesRead;

      const existingAttachments = store.listAttachmentsByPost(postId);
      const existingTotalBytes = existingAttachments.reduce((total, attachmentItem) => total + attachmentItem.size_bytes, 0);
      if (existingTotalBytes + sizeBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
        unlinkSync(storagePath);
        throw app.httpErrors.badRequest(
          `Total attachments exceed limit of ${MAX_TOTAL_ATTACHMENTS_BYTES / (1024 * 1024)}MB`
        );
      }

      const attachment = store.createAttachment({
        postId,
        filename: data.filename,
        mimeType: data.mimetype,
        sizeBytes,
        storagePath,
        sha256: sha256File(storagePath)
      });

      emitChatAttachment(postId, attachment);

      return mapAttachmentToDto(mapAttachmentRowToDomain(attachment));
    }
  );

  app.get('/attachments/:attachmentId', async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };

    const attachment = store.getAttachment(attachmentId);
    if (!attachment) {
      throw app.httpErrors.notFound('attachment not found');
    }
    const post = store.getPost(attachment.post_id);
    if (!post) {
      throw app.httpErrors.notFound('post not found');
    }
    requireTopicVisible(post.topic_id, request);

    if (!existsSync(attachment.storage_path)) {
      throw app.httpErrors.notFound('attachment file not found');
    }

    const safeName = attachment.filename.replace(/[\r\n"]/g, '');
    const disposition = shouldInlineAttachment(attachment.mime_type) ? 'inline' : 'attachment';
    reply.header('Content-Type', attachment.mime_type);
    reply.header('Content-Disposition', `${disposition}; filename="${safeName}"`);

    return reply.send(createReadStream(attachment.storage_path));
  });

  app.delete('/attachments/:attachmentId', async (request) => {
    const user = getCurrentUser(request);
    if (!user) {
      throw app.httpErrors.unauthorized('Authentication required');
    }

    const { attachmentId } = request.params as { attachmentId: string };

    const attachment = store.getAttachment(attachmentId);
    if (!attachment) {
      throw app.httpErrors.notFound('attachment not found');
    }

    const post = store.getPost(attachment.post_id);
    if (!post) {
      throw app.httpErrors.notFound('post not found');
    }
    const topic = store.getTopic(post.topic_id);
    if (topic && (topic.status === 'locked' || topic.status === 'archived')) {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }
    requireTopicVisible(post.topic_id, request);

    if (post.author_id !== user.identityId) {
      requireModerator(request, post.tenant_id);
    }

    // Delete file from disk
    if (existsSync(attachment.storage_path)) {
      unlinkSync(attachment.storage_path);
    }

    // Delete from database
    store.deleteAttachment(attachmentId);

    return { ok: true };
  });

  app.get('/topics/:topicId/attachments', async (request) => {
    const { topicId } = request.params as { topicId: string };
    requireTopicVisible(topicId, request);

    const postIds = store.listAllPosts(topicId).map((post) => post.id);
    const attachmentsByPost = store.listAttachmentsByPostIds(postIds);
    const itemsByPostId: Record<string, ReturnType<typeof mapAttachmentToDto>[]> = {};
    for (const postId of postIds) {
      itemsByPostId[postId] = (attachmentsByPost.get(postId) ?? []).map((attachment) =>
        mapAttachmentToDto(mapAttachmentRowToDomain(attachment))
      );
    }

    return { itemsByPostId };
  });

  app.get('/posts/:postId/attachments', async (request) => {
    const { postId } = request.params as { postId: string };
    requirePostVisible(postId, request);

    const attachments = store.listAttachmentsByPost(postId);
    return attachments.map((attachment) => mapAttachmentToDto(mapAttachmentRowToDomain(attachment)));
  });
}
