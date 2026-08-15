import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  AttachmentChunkedStartRequestSchema,
  UserFileListQuerySchema,
  UserFileUpdateRequestSchema,
} from '@irrigationreal/codex-forum-contracts';
import {
  NotepadExpirationPresetValues,
  canUseStandaloneFile,
  notepadExpiresAt,
} from '@irrigationreal/codex-forum-core';

import { mapAttachmentRowToDomain } from '../mappers/db';
import { mapAttachmentToDto } from '../mappers/dto';
import {
  INTERNAL_API_TOKEN,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_TOTAL_ATTACHMENTS_BYTES,
  MAX_TOTAL_USER_FILES_BYTES,
  PENDING_ATTACHMENTS_DIR,
  PENDING_ATTACHMENT_TTL_MS,
  TTS_AVAILABLE,
  TTS_MAX_CHARS,
  TTS_SCRIPT,
  UPLOADS_DIR,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_TEMP_DIR,
  USER_FILES_DIR,
} from '../runtimeConfig';
import { buildTtsStoragePath, generateTtsMp3, isTtsStoragePath } from '../tts';
import { shouldInlineAttachment } from '../utils/attachments';
import { parseBody } from '../utils/validation';

import type { UserFileDto } from '@irrigationreal/codex-forum-contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';
import type { AccessHelpers } from '../utils/access';

export function registerAttachmentRoutes({
  app,
  store,
  access,
  bus,
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
  bus?: StreamBusInterface;
}): void {
  const {
    getCurrentUser,
    getIdentityFromRequest,
    canViewTopic,
    requireModerator,
    requireScope,
    requireTopicVisible,
    requirePostVisible,
  } = access;

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

  async function sha256FileStream(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  function unlinkUnclaimedStorage(storagePath: string): void {
    if (existsSync(storagePath) && !store.hasBlobAtStoragePath(storagePath)) unlinkSync(storagePath);
  }

  function findUsableUserFile(identityId: string, sha256: string, sizeBytes: number) {
    const file = store.findUserFileByHash(identityId, sha256, sizeBytes);
    if (!file) return null;
    const blob = store.getUserFileBlob(file.id);
    if (!blob || !existsSync(blob.storage_path)) {
      if (blob) store.markBlobMissing(blob.id);
      return null;
    }
    return file;
  }

  function contentDisposition(disposition: 'attachment' | 'inline', filename: string): string {
    const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\\r\n"]/g, '_') || 'download';
    return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  function encodeFileCursor(createdAt: string, id: string): string {
    return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
  }

  function decodeFileCursor(value: string): { createdAt: string; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        !Number.isFinite(Date.parse(parsed[0])) ||
        typeof parsed[1] !== 'string' ||
        !parsed[1]
      )
        throw new Error('invalid cursor');
      return { createdAt: parsed[0], id: parsed[1] };
    } catch {
      throw app.httpErrors.badRequest('invalid file cursor');
    }
  }

  function visibleAssociations(fileId: string, request: FastifyRequest) {
    const viewer = getIdentityFromRequest(request);
    return store.listFileAssociations(fileId).filter((association) => {
      const topic = store.getTopic(association.topic_id);
      if (!topic) return false;
      const forum = store.getForum(topic.forum_id);
      return Boolean(forum && canViewTopic(topic, forum, viewer));
    });
  }

  function toUserFileDto(
    file: ReturnType<ForumStore['getUserFile']>,
    request: FastifyRequest,
    deduplicated?: boolean
  ): UserFileDto {
    if (!file) throw app.httpErrors.notFound('file not found');
    const blob = store.getUserFileBlob(file.id);
    const dto: UserFileDto = {
      id: file.id,
      ownerId: file.identity_id,
      filename: file.filename,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      standalone: Boolean(file.standalone),
      visibility: file.visibility,
      expiresAt: file.expires_at,
      revision: file.revision,
      blobState: blob?.state ?? 'missing',
      associations: visibleAssociations(file.id, request).map((association) => ({
        id: association.id,
        postId: association.post_id,
        topicId: association.topic_id,
        topicTitle: association.topic_title,
        postNumber: association.post_number,
        filename: association.filename,
        mimeType: association.mime_type,
        deletedAt: association.deleted_at,
      })),
      createdAt: file.created_at,
      updatedAt: file.updated_at,
    };
    if (deduplicated !== undefined) dto.deduplicated = deduplicated;
    return dto;
  }

  function requireOwnerLibraryUser(request: FastifyRequest, scope: 'read' | 'write') {
    const user = requireScope(getCurrentUser(request), scope);
    if (user.authType === 'impersonation') throw app.httpErrors.forbidden('Impersonation cannot access User Files');
    return user;
  }

  function canDownloadFile(file: NonNullable<ReturnType<ForumStore['getUserFile']>>, request: FastifyRequest): boolean {
    const auth = getCurrentUser(request);
    const viewer = getIdentityFromRequest(request);
    const hasActiveAssociation = store.listFileAssociations(file.id).some((association) => !association.deleted_at);
    if (
      auth?.authType !== 'impersonation' &&
      file.identity_id &&
      viewer?.id === file.identity_id &&
      (Boolean(file.standalone) || hasActiveAssociation)
    )
      return true;
    if (file.standalone && file.visibility && file.identity_id) {
      const owner = store.getIdentity(file.identity_id);
      if (
        canUseStandaloneFile({
          visibility: file.visibility,
          ownerIdentityId: file.identity_id,
          viewerIdentityId:
            auth?.authType === 'impersonation' && file.visibility === 'private' ? null : (viewer?.id ?? null),
          ownerTenantId: owner?.tenant_id ?? null,
          viewerTenantId: viewer?.tenant_id ?? null,
        })
      )
        return true;
    }
    return visibleAssociations(file.id, request).some((association) => !association.deleted_at);
  }

  function findExistingTtsAttachment(postId: string) {
    const attachments = store.listAttachmentsByPost(postId);
    return (
      attachments.find(
        (attachment) => !attachment.deleted_at && isTtsStoragePath(UPLOADS_DIR, attachment.storage_path)
      ) ?? null
    );
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
        attachment: mapAttachmentToDto(mapAttachmentRowToDomain(attachment)),
      },
    });
  }

  async function ensureTtsAttachment(postId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      throw app.httpErrors.badRequest('post body is empty');
    }

    const hash = createHash('sha256').update(trimmed).digest('hex');
    const storageId = `tts_${hash}`;
    const storagePath = buildTtsStoragePath(UPLOADS_DIR, storageId);
    const filename = `${storageId}.mp3`;
    const existing = findExistingTtsAttachment(postId);
    const existingBlob = existing ? store.getAttachmentBlob(existing.id) : null;
    if (existing && existingBlob?.state === 'ready' && existsSync(existingBlob.storage_path)) return existing;

    if (!existsSync(storagePath)) {
      const result = await generateTtsMp3({
        scriptPath: TTS_SCRIPT,
        text: trimmed,
        outPath: storagePath,
        maxChars: Number.isFinite(TTS_MAX_CHARS) ? TTS_MAX_CHARS : 2500,
      });
      if (!result.ok) {
        throw app.httpErrors.badRequest(result.error ?? 'TTS generation failed');
      }
    }

    const sizeBytes = statSync(storagePath).size;
    const sha256 = sha256File(storagePath);
    if (existing && existingBlob) {
      store.restoreBlob({ blobId: existingBlob.id, storagePath, sha256, sizeBytes });
      return store.getAttachment(existing.id) ?? existing;
    }
    if (existing) store.deleteAttachment(existing.id, 'missing_tts_replaced');
    return store.createAttachment({
      postId,
      filename,
      mimeType: 'audio/mpeg',
      sizeBytes,
      storagePath,
      sha256,
      ownerIdentityId: null,
      dedupeSystemByPath: true,
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
    if (store.hasCompactionFence(post.topic_id)) {
      throw app.httpErrors.conflict('Attachments are unavailable while the canonical topic is fenced');
    }

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
    if (store.hasCompactionFence(post.topic_id)) {
      throw app.httpErrors.conflict('Attachments are unavailable while the canonical topic is fenced');
    }

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
      updatedAt: now,
    };
    writeUploadMeta(uploadId, meta);

    return {
      uploadId,
      chunkBytes: MAX_CHUNK_BYTES,
      totalChunks,
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

    const existingAttachments = store.listAttachmentsByPost(postId).filter((item) => !item.deleted_at);
    const existingTotalBytes = existingAttachments.reduce(
      (total, attachmentItem) => total + attachmentItem.size_bytes,
      0
    );
    if (existingTotalBytes + assembledBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
      if (existsSync(storagePath)) {
        unlinkSync(storagePath);
      }
      deleteUploadSession(uploadId);
      throw app.httpErrors.badRequest(
        `Total attachments exceed limit of ${MAX_TOTAL_ATTACHMENTS_BYTES / (1024 * 1024)}MB`
      );
    }

    const sha256 = await sha256FileStream(storagePath);
    const existingFile = findUsableUserFile(user.identityId, sha256, assembledBytes);
    if (!existingFile && store.getIdentityBlobBytes(user.identityId) + assembledBytes > MAX_TOTAL_USER_FILES_BYTES) {
      if (existsSync(storagePath)) unlinkSync(storagePath);
      deleteUploadSession(uploadId);
      throw app.httpErrors.badRequest(
        `Total stored files exceed limit of ${MAX_TOTAL_USER_FILES_BYTES / (1024 * 1024)}MB`
      );
    }
    if (existingFile && existsSync(storagePath)) unlinkSync(storagePath);
    let attachment: ReturnType<ForumStore['createAttachment']>;
    try {
      attachment = store.createAttachment({
        postId,
        filename: meta.filename,
        mimeType: meta.mimeType,
        sizeBytes: assembledBytes,
        storagePath,
        sha256,
        ownerIdentityId: user.identityId,
        maxOwnerBytes: MAX_TOTAL_USER_FILES_BYTES,
      });
    } catch (error) {
      unlinkUnclaimedStorage(storagePath);
      deleteUploadSession(uploadId);
      throw error;
    }

    const persistedPath = store.getAttachmentBlob(attachment.id)?.storage_path;
    if (persistedPath && persistedPath !== storagePath && existsSync(storagePath)) unlinkSync(storagePath);
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

  // Agent pending attachment upload. The extension appends a canonical
  // monika.forum.attachment.ref custom entry; `reference` remains legacy-only.
  app.post('/agent/topics/:topicId/pending-attachments', { bodyLimit: MAX_REQUEST_BODY_BYTES }, async (request) => {
    requireInternalAgent(request);
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    if (!topic) throw app.httpErrors.notFound('topic not found');
    if (store.hasCompactionFence(topicId)) {
      throw app.httpErrors.conflict('Attachments are unavailable while the canonical topic is fenced');
    }
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
    let pending: ReturnType<ForumStore['createPendingAttachment']>;
    try {
      pending = store.createPendingAttachment({
        topicId,
        filename: data.filename,
        mimeType: data.mimetype || 'application/octet-stream',
        sizeBytes,
        storagePath,
        sha256,
        createdBy: 'agent',
        expiresAt,
      });
    } catch (error) {
      unlinkUnclaimedStorage(storagePath);
      throw error;
    }
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

  // User file storage. The owner library is logical metadata; only the GC
  // worker below unlinks shared blobs.
  // Compatibility endpoint: preserve the original array response for SDK and
  // REST consumers. The new owner-library UI uses /user-files/page.
  app.get('/user-files', async (request, reply) => {
    const user = requireOwnerLibraryUser(request, 'read');
    reply.header('Cache-Control', 'private, no-store');
    store.expireUserFiles();
    return store.listUserFilesByIdentity(user.identityId, 'standalone').map((file) => toUserFileDto(file, request));
  });

  app.get('/user-files/page', async (request, reply) => {
    const user = requireOwnerLibraryUser(request, 'read');
    reply.header('Cache-Control', 'private, no-store');
    store.expireUserFiles();
    const queryResult = UserFileListQuerySchema.safeParse(request.query);
    if (!queryResult.success) throw app.httpErrors.badRequest('invalid file filter');
    const filter = queryResult.data.filter ?? 'standalone';
    const limit = queryResult.data.limit ?? 30;
    const cursor = queryResult.data.cursor ? decodeFileCursor(queryResult.data.cursor) : null;
    const rows = store.listUserFilesByIdentity(user.identityId, filter as 'standalone' | 'all' | 'post_attachments', {
      beforeCreatedAt: cursor?.createdAt ?? '9999-12-31T23:59:59.999Z',
      beforeId: cursor?.id ?? '\uffff',
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((file) => toUserFileDto(file, request)),
      nextCursor: hasMore && last ? encodeFileCursor(last.created_at, last.id) : null,
    };
  });

  app.post('/user-files', { bodyLimit: MAX_REQUEST_BODY_BYTES }, async (request, reply) => {
    const user = requireOwnerLibraryUser(request, 'write');
    reply.header('Cache-Control', 'private, no-store');
    const data = await request.file();
    if (!data) throw app.httpErrors.badRequest('file is required');

    const stagePath = join(USER_FILES_DIR, `.staging-${randomUUID()}`);
    await pipeline(data.file, createWriteStream(stagePath, { flags: 'wx' }));
    if (data.file.truncated) {
      unlinkSync(stagePath);
      throw app.httpErrors.badRequest(`File size exceeds limit of ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`);
    }
    const sizeBytes = data.file.bytesRead;
    const sha256 = await sha256FileStream(stagePath);
    const existing = findUsableUserFile(user.identityId, sha256, sizeBytes);
    if (!existing && store.getIdentityBlobBytes(user.identityId) + sizeBytes > MAX_TOTAL_USER_FILES_BYTES) {
      unlinkSync(stagePath);
      throw app.httpErrors.badRequest(
        `Total stored files exceed limit of ${MAX_TOTAL_USER_FILES_BYTES / (1024 * 1024)}MB`
      );
    }
    const fields = data.fields as Record<string, { value?: unknown }>;
    const visibilityField = fields['visibility']?.value;
    const expirationField = fields['expiration']?.value;
    const visibilityValue = typeof visibilityField === 'string' ? visibilityField : 'private';
    const expirationValue = typeof expirationField === 'string' ? expirationField : 'one_month';
    if (!['private', 'members', 'public'].includes(visibilityValue)) {
      unlinkSync(stagePath);
      throw app.httpErrors.badRequest('invalid visibility');
    }
    if (!(NotepadExpirationPresetValues as readonly string[]).includes(expirationValue)) {
      unlinkSync(stagePath);
      throw app.httpErrors.badRequest('invalid expiration');
    }
    let storagePath = stagePath;
    if (existing) {
      unlinkSync(stagePath);
      storagePath = store.getUserFileBlob(existing.id)?.storage_path ?? stagePath;
    } else {
      storagePath = join(USER_FILES_DIR, randomUUID());
      renameSync(stagePath, storagePath);
    }
    const now = new Date().toISOString();
    let file: ReturnType<ForumStore['createUserFile']>;
    try {
      file = store.createUserFile({
        identityId: user.identityId,
        filename: data.filename,
        mimeType: data.mimetype || 'application/octet-stream',
        sizeBytes,
        storagePath,
        sha256,
        visibility: visibilityValue as 'private' | 'members' | 'public',
        expiresAt: notepadExpiresAt(expirationValue as (typeof NotepadExpirationPresetValues)[number], now),
        maxOwnerBytes: MAX_TOTAL_USER_FILES_BYTES,
      });
    } catch (uploadError) {
      unlinkUnclaimedStorage(storagePath);
      throw uploadError;
    }
    const persistedPath = store.getUserFileBlob(file.id)?.storage_path;
    if (persistedPath && persistedPath !== storagePath && existsSync(storagePath)) unlinkSync(storagePath);
    return toUserFileDto(file, request, Boolean(existing) || persistedPath !== storagePath);
  });

  app.patch('/user-files/:fileId', async (request, reply) => {
    const user = requireOwnerLibraryUser(request, 'write');
    reply.header('Cache-Control', 'private, no-store');
    const { fileId } = request.params as { fileId: string };
    const body = parseBody(app, UserFileUpdateRequestSchema, request.body);
    const updated = store.updateUserFile(
      fileId,
      user.identityId,
      body.expectedRevision,
      body.visibility,
      body.expiration === 'keep' ? undefined : notepadExpiresAt(body.expiration, new Date().toISOString())
    );
    if (updated === 'missing') throw app.httpErrors.notFound('file not found');
    if (updated === 'conflict') throw app.httpErrors.conflict('file changed in another session');
    return toUserFileDto(updated, request);
  });

  app.get('/user-files/:fileId', async (request, reply) => {
    store.expireUserFiles();
    const { fileId } = request.params as { fileId: string };
    const file = store.getUserFile(fileId);
    if (!file || !canDownloadFile(file, request)) throw app.httpErrors.notFound('file not found');
    const blob = store.getUserFileBlob(fileId);
    if (!blob || blob.state !== 'ready' || !existsSync(blob.storage_path)) {
      if (blob) store.markBlobMissing(blob.id);
      throw app.httpErrors.notFound('file not found');
    }
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Type', file.mime_type);
    reply.header('Content-Disposition', contentDisposition('attachment', file.filename));
    return reply.send(createReadStream(blob.storage_path));
  });

  app.delete('/user-files/:fileId', async (request, reply) => {
    const user = requireOwnerLibraryUser(request, 'write');
    reply.header('Cache-Control', 'private, no-store');
    const { fileId } = request.params as { fileId: string };
    const file = store.getUserFile(fileId);
    if (!file || file.identity_id !== user.identityId || !file.standalone)
      throw app.httpErrors.notFound('file not found');
    store.deleteUserFile(fileId, user.identityId);
    return { ok: true };
  });

  // Only allow author to upload attachments within 5 minutes of creating a post
  app.post('/posts/:postId/attachments', { bodyLimit: MAX_REQUEST_BODY_BYTES }, async (request) => {
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

    const existingAttachments = store.listAttachmentsByPost(postId).filter((item) => !item.deleted_at);
    const existingTotalBytes = existingAttachments.reduce(
      (total, attachmentItem) => total + attachmentItem.size_bytes,
      0
    );
    if (existingTotalBytes + sizeBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
      unlinkSync(storagePath);
      throw app.httpErrors.badRequest(
        `Total attachments exceed limit of ${MAX_TOTAL_ATTACHMENTS_BYTES / (1024 * 1024)}MB`
      );
    }

    const sha256 = await sha256FileStream(storagePath);
    const existingFile = findUsableUserFile(user.identityId, sha256, sizeBytes);
    if (!existingFile && store.getIdentityBlobBytes(user.identityId) + sizeBytes > MAX_TOTAL_USER_FILES_BYTES) {
      if (existsSync(storagePath)) unlinkSync(storagePath);
      throw app.httpErrors.badRequest(
        `Total stored files exceed limit of ${MAX_TOTAL_USER_FILES_BYTES / (1024 * 1024)}MB`
      );
    }
    if (existingFile && existsSync(storagePath)) unlinkSync(storagePath);
    let attachment: ReturnType<ForumStore['createAttachment']>;
    try {
      attachment = store.createAttachment({
        postId,
        filename: data.filename,
        mimeType: data.mimetype || 'application/octet-stream',
        sizeBytes,
        storagePath,
        sha256,
        ownerIdentityId: user.identityId,
        maxOwnerBytes: MAX_TOTAL_USER_FILES_BYTES,
      });
    } catch (uploadError) {
      unlinkUnclaimedStorage(storagePath);
      throw uploadError;
    }

    const persistedPath = store.getAttachmentBlob(attachment.id)?.storage_path;
    if (persistedPath && persistedPath !== storagePath && existsSync(storagePath)) unlinkSync(storagePath);
    emitChatAttachment(postId, attachment);

    return mapAttachmentToDto(mapAttachmentRowToDomain(attachment));
  });

  app.get('/attachments/:attachmentId', async (request, reply) => {
    const { attachmentId } = request.params as { attachmentId: string };

    const attachment = store.getAttachment(attachmentId);
    if (!attachment || attachment.deleted_at || !attachment.file_id)
      throw app.httpErrors.notFound('attachment not found');
    const file = store.getUserFile(attachment.file_id);
    const blob = store.getAttachmentBlob(attachmentId);
    if (!file || !blob || blob.state !== 'ready' || !canDownloadFile(file, request) || !existsSync(blob.storage_path)) {
      if (blob && !existsSync(blob.storage_path)) store.markBlobMissing(blob.id);
      throw app.httpErrors.notFound('attachment not found');
    }
    const disposition = shouldInlineAttachment(attachment.mime_type) ? 'inline' : 'attachment';
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Type', attachment.mime_type);
    reply.header('Content-Disposition', contentDisposition(disposition, attachment.filename));
    return reply.send(createReadStream(blob.storage_path));
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
    if (store.hasCompactionFence(post.topic_id)) {
      throw app.httpErrors.conflict('Attachments are unavailable while the canonical topic is fenced');
    }
    if (topic && (topic.status === 'locked' || topic.status === 'archived')) {
      throw app.httpErrors.forbidden('topic is locked or archived');
    }
    requireTopicVisible(post.topic_id, request);

    const associatedFile = attachment.file_id ? store.getUserFile(attachment.file_id) : null;
    if (post.author_id !== user.identityId && associatedFile?.identity_id !== user.identityId) {
      requireModerator(request, post.tenant_id);
    }

    // Detach only this post reference. Shared bytes are reclaimed later by GC.
    store.deleteAttachment(attachmentId, 'attachment_deleted');

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
