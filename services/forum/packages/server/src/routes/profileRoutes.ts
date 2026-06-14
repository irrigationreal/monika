import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { UpdateIdentityRequestSchema, isForumThemeKey } from '@irrigationreal/codex-forum-contracts';
import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';
import { AVATARS_DIR, MAX_AVATAR_BYTES, MAX_REQUEST_BODY_BYTES } from '../runtimeConfig';
import { parseBody } from '../utils/validation';
import { mapIdentityRowToDomain } from '../mappers/db';
import { mapIdentityToDto, mapUserPostHistoryItemToDto } from '../mappers/dto';

export function registerProfileRoutes({
  app,
  store,
  access
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
}): void {
  const { getCurrentUser, requireScope } = access;
  const { getIdentityFromRequest, canViewForum } = access;

  // Profile endpoints
  app.patch('/identities/:identityId', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');

    const { identityId } = request.params as { identityId: string };

    // Users can only edit their own profile (or admins can edit any)
    const currentIdentity = store.getIdentity(user.identityId);
    if (user.identityId !== identityId && currentIdentity?.kind !== 'admin') {
      throw app.httpErrors.forbidden('Cannot edit other users');
    }

    const body = parseBody(app, UpdateIdentityRequestSchema, request.body);

    // Check displayName uniqueness if changing
    if (body.displayName) {
      if (store.isDisplayNameTakenByOther(body.displayName, identityId)) {
        throw app.httpErrors.conflict('Display name already taken');
      }
    }

    try {
      const updates: {
        displayName?: string;
        avatarUrl?: string | null;
        location?: string | null;
        signature?: string | null;
        theme?: string | null;
      } = {};
      if (body.displayName !== undefined) {
        updates.displayName = body.displayName;
      }
      if (body.avatarUrl !== undefined) {
        updates.avatarUrl = body.avatarUrl;
      }
      if (body.location !== undefined) {
        updates.location = body.location;
      }
      if (body.signature !== undefined) {
        updates.signature = body.signature;
      }
      if (body.theme !== undefined) {
        if (body.theme === null) {
          updates.theme = null;
        } else if ((body.theme as string) === 'light') {
          updates.theme = 'classic-light';
        } else if ((body.theme as string) === 'dark') {
          updates.theme = 'classic-dark';
        } else if (isForumThemeKey(body.theme)) {
          updates.theme = body.theme;
        } else {
          throw app.httpErrors.badRequest('Invalid theme key');
        }
      }
      const identity = store.updateIdentity(identityId, updates);
      const postCount = store.getIdentityPostCount(identity.id);
      return mapIdentityToDto({
        ...mapIdentityRowToDomain(identity),
        postCount,
        rank: store.getUserRank(postCount)
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'update failed';
      if (message === 'identity not found') {
        throw app.httpErrors.notFound(message);
      }
      throw app.httpErrors.badRequest(message);
    }
  });

  // Avatar upload endpoint
  app.post(
    '/identities/:identityId/avatar',
    // Fastify's default bodyLimit is quite small and can cause 413s for multipart uploads.
    // We override it on upload endpoints so normal JSON routes keep their default limit.
    { bodyLimit: MAX_REQUEST_BODY_BYTES },
    async (request) => {
      const user = requireScope(getCurrentUser(request), 'write');

      const { identityId } = request.params as { identityId: string };

      // Users can only upload their own avatar (or admins can upload any)
      const currentIdentity = store.getIdentity(user.identityId);
      if (user.identityId !== identityId && currentIdentity?.kind !== 'admin') {
        throw app.httpErrors.forbidden('Cannot upload avatar for other users');
      }

      // Check if identity exists
      const identity = store.getIdentity(identityId);
      if (!identity) {
        throw app.httpErrors.notFound('Identity not found');
      }

      // Get the uploaded file
      const data = await request.file();
      if (!data) {
        throw app.httpErrors.badRequest('No file uploaded');
      }

      // Validate file type
      const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedMimeTypes.includes(data.mimetype)) {
        throw app.httpErrors.badRequest('Invalid file type. Allowed: JPEG, PNG, GIF, WebP');
      }

      try {
        // Read file into buffer
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of data.file) {
          // Prevent huge avatar uploads from buffering in memory.
          totalBytes += (chunk as Buffer).length;
          if (totalBytes > MAX_AVATAR_BYTES) {
            data.file.destroy();
            throw app.httpErrors.badRequest(`Avatar file too large. Max ${Math.floor(MAX_AVATAR_BYTES / (1024 * 1024))}MB.`);
          }
          chunks.push(chunk as Buffer);
        }
        const buffer = Buffer.concat(chunks);

        // Process image with sharp: resize and crop to square
        const AVATAR_SIZE = 200;
        const processedImage = await sharp(buffer)
          .resize(AVATAR_SIZE, AVATAR_SIZE, {
            fit: 'cover',
            position: 'center'
          })
          .jpeg({ quality: 85 })
          .toBuffer();

        // Generate unique filename
        const filename = `${identityId}_${Date.now()}.jpg`;
        const filepath = join(AVATARS_DIR, filename);

        // Delete old avatar if it exists and is a local upload
        if (identity.avatar_url?.startsWith('/uploads/avatars/')) {
          const oldFilename = identity.avatar_url.replace('/uploads/avatars/', '');
          const oldFilepath = join(AVATARS_DIR, oldFilename);
          if (existsSync(oldFilepath)) {
            unlinkSync(oldFilepath);
          }
        }

        // Save the processed image
        writeFileSync(filepath, processedImage);

        // Update identity with new avatar URL
        const avatarUrl = `/uploads/avatars/${filename}`;
        const updatedIdentity = store.updateIdentity(identityId, { avatarUrl });

        return {
          id: updatedIdentity.id,
          displayName: updatedIdentity.display_name,
          avatarUrl: updatedIdentity.avatar_url,
          message: 'Avatar uploaded successfully'
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to process image';
        throw app.httpErrors.badRequest(message);
      }
    }
  );

  app.get('/identities/:identityId', async (request) => {
    const { identityId } = request.params as { identityId: string };
    const identity = store.getIdentity(identityId);
    if (!identity) {
      throw app.httpErrors.notFound('identity not found');
    }
    return mapIdentityToDto(mapIdentityRowToDomain(identity));
  });

  /**
   * Logged-in view of a user's profile (public fields).
   * Intended for "click username -> profile".
   */
  app.get('/profiles/:identityId', async (request) => {
    requireScope(getCurrentUser(request), 'read');

    const { identityId } = request.params as { identityId: string };
    const identity = store.getIdentity(identityId);
    if (!identity) {
      throw app.httpErrors.notFound('identity not found');
    }

    const postCount = store.getIdentityPostCount(identity.id);
    return mapIdentityToDto({
      ...mapIdentityRowToDomain(identity),
      postCount,
      rank: store.getUserRank(postCount),
      joinDate: identity.created_at
    });
  });

  app.get('/profiles/:identityId/posts', async (request) => {
    requireScope(getCurrentUser(request), 'read');
    const viewerIdentity = getIdentityFromRequest(request);

    const { identityId } = request.params as { identityId: string };
    const identity = store.getIdentity(identityId);
    if (!identity) {
      throw app.httpErrors.notFound('identity not found');
    }

    const query = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Math.trunc(Number(query.page ?? 1) || 1));
    const pageSize = Math.max(1, Math.min(50, Math.trunc(Number(query.pageSize ?? 25) || 25)));

    // Enforce visibility permissions in the SQL query itself so pagination remains stable.
    // Currently the only thing that can make a post "not visible" is its forum visibility:
    // - public: anyone
    // - members: logged-in users
    // - admin: admins / users with admin perms
    //
    // If we add topic-level access rules later, this route needs to be updated to enforce them
    // without leaking private data (and ideally without scanning the entire post history).
    const includeAdminForums = Boolean(
      viewerIdentity &&
        canViewForum({ visibility: 'admin', tenant_id: viewerIdentity.tenant_id }, viewerIdentity)
    );

    const total = store.countPostsByAuthor(identityId, { includeAdminForums });
    const rows = store.listPostsByAuthor(identityId, page, pageSize, { includeAdminForums });

    const toExcerpt = (body: string, maxChars = 220): string => {
      const compact = body.replace(/\s+/g, ' ').trim();
      if (compact.length <= maxChars) return compact;
      return `${compact.slice(0, maxChars)}…`;
    };

    const items = rows.map((row) =>
      mapUserPostHistoryItemToDto({
        postId: row.post_id,
        topicId: row.topic_id,
        topicTitle: row.topic_title,
        forumId: row.forum_id,
        forumName: row.forum_name,
        createdAt: row.created_at,
        excerpt: toExcerpt(row.body)
      })
    );

    return { page, pageSize, total, items };
  });
}
