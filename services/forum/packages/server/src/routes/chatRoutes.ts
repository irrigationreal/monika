import { randomUUID } from 'node:crypto';

import {
  ChatTypingRequestSchema,
  CreateChatCategoryRequestSchema,
  CreateChatMessageRequestSchema,
  CreateChatRoomRequestSchema,
} from '@irrigationreal/codex-forum-contracts';

import { mapChatCategoryRowToDto, mapChatMessageRowToDto, mapChatRoomRowToDto } from '../mappers/dto';
import { parseBody } from '../utils/validation';

import type { ChatPresenceDto } from '@irrigationreal/codex-forum-contracts';
import type { FastifyInstance } from 'fastify';

import type { ForumStore } from '../store';
import type { StreamBusInterface } from '../streamBus';
import type { AccessHelpers } from '../utils/access';

type PresenceIdentity = {
  id: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

type ChatPresenceEntry = {
  member: ChatPresenceDto;
  connections: Set<string>;
};

const presenceByRoom = new Map<string, Map<string, ChatPresenceEntry>>();
const connectionIndex = new Map<string, { roomId: string; identityId: string }>();

function listPresence(roomId: string): ChatPresenceDto[] {
  const roomPresence = presenceByRoom.get(roomId);
  if (!roomPresence) return [];
  return Array.from(roomPresence.values())
    .map((entry) => entry.member)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function joinPresence(roomId: string, identity: PresenceIdentity, connectionId: string) {
  let roomPresence = presenceByRoom.get(roomId);
  if (!roomPresence) {
    roomPresence = new Map();
    presenceByRoom.set(roomId, roomPresence);
  }
  let entry = roomPresence.get(identity.id);
  const isFirst = !entry;
  if (!entry) {
    entry = {
      member: {
        id: identity.id,
        displayName: identity.displayName?.trim() || 'Unknown',
        avatarUrl: identity.avatarUrl ?? null,
        joinedAt: new Date().toISOString(),
      },
      connections: new Set(),
    };
    roomPresence.set(identity.id, entry);
  }
  entry.connections.add(connectionId);
  connectionIndex.set(connectionId, { roomId, identityId: identity.id });
  return { member: entry.member, isFirst };
}

function leavePresence(connectionId: string) {
  const connection = connectionIndex.get(connectionId);
  if (!connection) return null;
  connectionIndex.delete(connectionId);
  const roomPresence = presenceByRoom.get(connection.roomId);
  if (!roomPresence) return null;
  const entry = roomPresence.get(connection.identityId);
  if (!entry) return null;
  entry.connections.delete(connectionId);
  const isLast = entry.connections.size === 0;
  if (isLast) {
    roomPresence.delete(connection.identityId);
  }
  if (roomPresence.size === 0) {
    presenceByRoom.delete(connection.roomId);
  }
  return { roomId: connection.roomId, member: entry.member, isLast };
}

const CHAT_DEFAULT_LIMIT = 200;
const CHAT_MAX_LIMIT = 500;

function resolveLimit(raw?: string | number | null): number {
  if (raw === undefined || raw === null) return CHAT_DEFAULT_LIMIT;
  const parsed = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(parsed)) return CHAT_DEFAULT_LIMIT;
  return Math.max(1, Math.min(CHAT_MAX_LIMIT, Math.trunc(parsed)));
}

function normalizeRoomName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

export function registerChatRoutes({
  app,
  store,
  access,
  bus,
}: {
  app: FastifyInstance;
  store: ForumStore;
  access: AccessHelpers;
  bus: StreamBusInterface;
}): void {
  const { getCurrentUser, requireScope, requireAdmin, canViewForum } = access;

  function requireReadIdentity(request: { headers: Record<string, unknown>; query?: unknown }) {
    const user = requireScope(getCurrentUser(request), 'read');
    const identity = store.getIdentity(user.identityId);
    if (!identity) {
      throw app.httpErrors.unauthorized('Authentication required');
    }
    return identity;
  }

  function toAccessVisibility(visibility: string) {
    return { visibility, tenant_id: null };
  }

  function canWrite(visibility: string, identity: ReturnType<ForumStore['getIdentity']>) {
    if (!identity) return false;
    return canViewForum(toAccessVisibility(visibility), identity);
  }

  app.get('/chat/categories', async (request) => {
    const identity = requireReadIdentity(request);
    const categories = store.listChatCategoriesWithCounts();
    const visible = categories.filter((category) => canViewForum(toAccessVisibility(category.visibility), identity));
    return {
      rootForumId: visible[0]?.id ?? '',
      items: visible.map((category) => mapChatCategoryRowToDto(category)),
    };
  });

  app.post('/chat/categories', async (request) => {
    requireAdmin(request);
    const body = parseBody(app, CreateChatCategoryRequestSchema, request.body);
    const category = store.createChatCategory({
      name: body.name.trim(),
      description: body.description ?? null,
      visibility: body.visibility ?? 'members',
    });
    return mapChatCategoryRowToDto({ ...category, room_count: 0 });
  });

  app.get('/chat/rooms', async (request) => {
    const query = request.query as { categoryId?: string };
    const categoryId = query?.categoryId?.toString();
    if (!categoryId) {
      throw app.httpErrors.badRequest('categoryId is required');
    }
    const identity = requireReadIdentity(request);
    const category = store.getChatCategory(categoryId);
    if (!category) {
      throw app.httpErrors.notFound('category not found');
    }
    if (!canViewForum(toAccessVisibility(category.visibility), identity)) {
      throw app.httpErrors.notFound('category not found');
    }
    const rooms = store.listChatRooms(categoryId);
    const visibleRooms = rooms.filter((room) => canViewForum(toAccessVisibility(room.visibility), identity));
    return {
      categoryId,
      items: visibleRooms.map((room) => mapChatRoomRowToDto(room)),
    };
  });

  app.post('/chat/rooms', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const body = parseBody(app, CreateChatRoomRequestSchema, request.body);
    const category = store.getChatCategory(body.categoryId);
    if (!category) {
      throw app.httpErrors.notFound('category not found');
    }
    const identity = store.getIdentity(user.identityId);
    if (!identity || !canWrite(category.visibility, identity)) {
      throw app.httpErrors.forbidden('Posting not allowed in this category');
    }
    const roomName = normalizeRoomName(body.name);
    if (!roomName) {
      throw app.httpErrors.badRequest('name is required');
    }
    const existing = store.getChatRoomByName(category.id, roomName);
    if (existing) {
      if (!canViewForum(toAccessVisibility(existing.visibility), identity)) {
        throw app.httpErrors.notFound('room not found');
      }
      return mapChatRoomRowToDto(existing);
    }
    const room = store.createChatRoom({
      categoryId: category.id,
      name: roomName,
      topic: body.topic?.trim() || null,
      visibility: category.visibility as 'admin' | 'public' | 'members',
    });
    return mapChatRoomRowToDto(room);
  });

  app.get('/chat/rooms/:roomId/messages', async (request) => {
    const { roomId } = request.params as { roomId: string };
    const query = request.query as { limit?: string; before?: string; after?: string };
    const limit = resolveLimit(query?.limit);

    const room = store.getChatRoom(roomId);
    if (!room) {
      throw app.httpErrors.notFound('room not found');
    }
    const identity = requireReadIdentity(request);
    if (!canViewForum(toAccessVisibility(room.visibility), identity)) {
      throw app.httpErrors.notFound('room not found');
    }

    if (query?.before && query?.after) {
      throw app.httpErrors.badRequest('before and after cannot be combined');
    }

    if (query?.after) {
      const rows = store.listChatMessagesAfter(roomId, limit + 1, query.after);
      if (!rows) {
        const fallbackRows = store.listChatMessages(roomId, limit + 1, null);
        const hasMore = fallbackRows.length > limit;
        const trimmed = hasMore ? fallbackRows.slice(0, limit) : fallbackRows;
        const chronological = trimmed.slice().reverse();
        const items = chronological.map((row) => mapChatMessageRowToDto(row));
        const nextBefore = hasMore ? (chronological[0]?.id ?? null) : null;
        return {
          roomId,
          items,
          hasMore,
          nextBefore,
          nextAfter: null,
        };
      }
      const hasMore = rows.length > limit;
      const trimmed = hasMore ? rows.slice(0, limit) : rows;
      const items = trimmed.map((row) => mapChatMessageRowToDto(row));
      const nextAfter = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;
      return {
        roomId,
        items,
        hasMore,
        nextBefore: null,
        nextAfter,
      };
    }

    const rows = store.listChatMessages(roomId, limit + 1, query?.before ?? null);
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const chronological = trimmed.slice().reverse();
    const items = chronological.map((row) => mapChatMessageRowToDto(row));

    const nextBefore = hasMore ? (chronological[0]?.id ?? null) : null;

    return {
      roomId,
      items,
      hasMore,
      nextBefore,
      nextAfter: null,
    };
  });

  app.post('/chat/rooms/:roomId/messages', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { roomId } = request.params as { roomId: string };
    const body = parseBody(app, CreateChatMessageRequestSchema, request.body);
    const room = store.getChatRoom(roomId);
    if (!room) {
      throw app.httpErrors.notFound('room not found');
    }
    const identity = store.getIdentity(user.identityId);
    if (!identity || !canWrite(room.visibility, identity)) {
      throw app.httpErrors.forbidden('Posting not allowed in this room');
    }
    if (room.status !== 'open') {
      throw app.httpErrors.forbidden('room is locked or archived');
    }

    const trimmedBody = body.body.trim();
    if (!trimmedBody) {
      throw app.httpErrors.badRequest('body is required');
    }
    const expiresInSeconds = body.expiresInSeconds ?? null;
    let expiresAt: string | null = null;
    if (expiresInSeconds) {
      const expiresAtDate = new Date(Date.now() + expiresInSeconds * 1000);
      if (Number.isNaN(expiresAtDate.getTime())) {
        throw app.httpErrors.badRequest('expiresInSeconds is invalid');
      }
      expiresAt = expiresAtDate.toISOString();
    }
    const messageRow = store.createChatMessage({
      roomId: room.id,
      authorId: user.identityId,
      authorName: identity.display_name ?? 'Unknown',
      authorAvatarUrl: identity.avatar_url ?? null,
      body: trimmedBody,
      expiresAt,
    });
    const message = mapChatMessageRowToDto(messageRow);

    bus.emit(room.id, { type: 'chat_message', data: message });

    return message;
  });

  app.post('/chat/rooms/:roomId/typing', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const { roomId } = request.params as { roomId: string };
    const body = parseBody(app, ChatTypingRequestSchema, request.body);
    const room = store.getChatRoom(roomId);
    if (!room) {
      throw app.httpErrors.notFound('room not found');
    }
    const identity = store.getIdentity(user.identityId);
    if (!identity || !canWrite(room.visibility, identity)) {
      throw app.httpErrors.forbidden('Posting not allowed in this room');
    }
    if (room.status !== 'open') {
      throw app.httpErrors.forbidden('room is locked or archived');
    }

    bus.emit(room.id, {
      type: 'chat_typing',
      data: {
        roomId,
        identityId: user.identityId,
        displayName: identity.display_name ?? 'Unknown',
        isTyping: body.isTyping,
      },
    });

    return { ok: true };
  });

  app.get('/chat/rooms/:roomId/stream', async (request, reply) => {
    const { roomId } = request.params as { roomId: string };
    const room = store.getChatRoom(roomId);
    if (!room) {
      throw app.httpErrors.notFound('room not found');
    }
    const identity = requireReadIdentity(request);
    if (!canViewForum(toAccessVisibility(room.visibility), identity)) {
      throw app.httpErrors.notFound('room not found');
    }

    let connectionId: string | null = null;
    if (identity) {
      connectionId = randomUUID();
      const join = joinPresence(
        roomId,
        {
          id: identity.id,
          displayName: identity.display_name,
          avatarUrl: identity.avatar_url ?? null,
        },
        connectionId
      );
      if (join.isFirst) {
        bus.emit(roomId, { type: 'chat_join', data: { roomId, member: join.member } });
      }
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.write('retry: 1000\\n\\n');

    const presenceState = listPresence(roomId);
    reply.raw.write(`event: chat_presence_state\\n`);
    reply.raw.write(`data: ${JSON.stringify({ roomId, members: presenceState })}\\n\\n`);

    const keepAliveMs = 15_000;
    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(': keepalive\\n\\n');
      } catch {
        // Ignore write errors; the close handler will clean up.
      }
    }, keepAliveMs);

    const unsubscribe = bus.subscribe(roomId, (event) => {
      reply.raw.write(`event: ${event.type}\\n`);
      reply.raw.write(`data: ${JSON.stringify(event.data)}\\n\\n`);
    });

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      if (connectionId) {
        const leave = leavePresence(connectionId);
        if (leave?.isLast) {
          bus.emit(roomId, { type: 'chat_part', data: { roomId: leave.roomId, member: leave.member } });
          bus.emit(roomId, {
            type: 'chat_typing',
            data: {
              roomId: leave.roomId,
              identityId: leave.member.id,
              displayName: leave.member.displayName,
              isTyping: false,
            },
          });
        }
      }
    });
  });
}
