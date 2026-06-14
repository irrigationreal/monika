import type { FastifyInstance } from 'fastify';
import {
  DiscordMapChannelRequestSchema,
  DiscordSendRequestSchema,
  MatrixMapRoomRequestSchema,
  MatrixSendRequestSchema
} from '@irrigationreal/codex-forum-contracts';
import type { DiscordBridge } from '../adapters/discordBridge';
import type { MatrixBridge } from '../adapters/matrixBridge';
import type { AccessHelpers } from '../utils/access';
import { parseBody } from '../utils/validation';

export function registerAdapterRoutes({
  app,
  getDiscordBridge,
  getMatrixBridge,
  defaultForumId,
  access
}: {
  app: FastifyInstance;
  getDiscordBridge: () => DiscordBridge | null;
  getMatrixBridge: () => MatrixBridge | null;
  defaultForumId: string;
  access: AccessHelpers;
}): void {
  const { requireAdmin } = access;

  // Discord adapter endpoints
  app.post('/adapters/discord/connect', async (request) => {
    requireAdmin(request);
    const bridge = getDiscordBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Discord is not configured. Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID environment variables.');
    }

    try {
      await bridge.connect();
      return { ok: true, status: bridge.getStatus() };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw app.httpErrors.internalServerError(`Failed to connect to Discord: ${message}`);
    }
  });

  app.post('/adapters/discord/disconnect', async (request) => {
    requireAdmin(request);
    const bridge = getDiscordBridge();
    if (!bridge) {
      return { ok: true, message: 'Discord is not configured' };
    }

    await bridge.disconnect();
    return { ok: true };
  });

  app.post('/adapters/discord/map', async (request) => {
    requireAdmin(request);
    const bridge = getDiscordBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Discord is not configured');
    }

    if (!bridge.isConnected()) {
      throw app.httpErrors.badRequest('Discord adapter is not connected. Call /adapters/discord/connect first.');
    }

    const body = parseBody(app, DiscordMapChannelRequestSchema, request.body);

    // Default to the bootstrap forum if no forumId provided
    const forumId = body.forumId ?? defaultForumId;

    try {
      await bridge.mapChannel(body.channelId, forumId);
      return {
        ok: true,
        mapping: {
          channelId: body.channelId,
          forumId
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw app.httpErrors.badRequest(`Failed to map channel: ${message}`);
    }
  });

  app.delete('/adapters/discord/map/:channelId', async (request) => {
    requireAdmin(request);
    const bridge = getDiscordBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Discord is not configured');
    }

    const { channelId } = request.params as { channelId: string };
    bridge.unmapChannel(channelId);
    return { ok: true };
  });

  app.get('/adapters/discord/status', async (request) => {
    requireAdmin(request);
    const bridge = getDiscordBridge();
    if (!bridge) {
      return {
        configured: false,
        connected: false,
        message: 'Discord is not configured. Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID environment variables.'
      };
    }

    return {
      configured: true,
      ...bridge.getStatus()
    };
  });

  app.post('/adapters/discord/send', async (request) => {
    requireAdmin(request);
    const bridge = getDiscordBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Discord is not configured');
    }

    if (!bridge.isConnected()) {
      throw app.httpErrors.badRequest('Discord adapter is not connected');
    }

    const body = parseBody(app, DiscordSendRequestSchema, request.body);

    try {
      const messageId = await bridge.sendToThread(body.threadId, body.content, body.authorName);
      return { ok: true, messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw app.httpErrors.internalServerError(`Failed to send message: ${message}`);
    }
  });

  // Matrix adapter endpoints
  app.get('/adapters/matrix/status', async (request) => {
    requireAdmin(request);
    const bridge = getMatrixBridge();
    if (!bridge) {
      return {
        configured: false,
        connected: false,
        message: 'Matrix is not configured. Set MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID environment variables.'
      };
    }

    return {
      configured: true,
      ...bridge.getStatus()
    };
  });

  app.post('/adapters/matrix/connect', async (request) => {
    requireAdmin(request);
    const bridge = getMatrixBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Matrix is not configured. Set MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID environment variables.');
    }

    try {
      await bridge.connect();
      return { ok: true, status: bridge.getStatus() };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw app.httpErrors.internalServerError(`Failed to connect to Matrix: ${message}`);
    }
  });

  app.post('/adapters/matrix/disconnect', async (request) => {
    requireAdmin(request);
    const bridge = getMatrixBridge();
    if (!bridge) {
      return { ok: true, message: 'Matrix is not configured' };
    }

    await bridge.disconnect();
    return { ok: true };
  });

  app.post('/adapters/matrix/map-room', async (request) => {
    requireAdmin(request);
    const bridge = getMatrixBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Matrix is not configured');
    }

    if (!bridge.isConnected()) {
      throw app.httpErrors.badRequest('Matrix adapter is not connected. Call /adapters/matrix/connect first.');
    }

    const body = parseBody(app, MatrixMapRoomRequestSchema, request.body);

    // Default to the bootstrap forum if no forumId provided
    const forumId = body.forumId ?? defaultForumId;

    try {
      await bridge.mapRoom(body.roomId, forumId);
      return {
        ok: true,
        mapping: {
          roomId: body.roomId,
          forumId
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw app.httpErrors.badRequest(`Failed to map room: ${message}`);
    }
  });

  app.delete('/adapters/matrix/map-room/:roomId', async (request) => {
    requireAdmin(request);
    const bridge = getMatrixBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Matrix is not configured');
    }

    const { roomId } = request.params as { roomId: string };
    bridge.unmapRoom(roomId);
    return { ok: true };
  });

  app.post('/adapters/matrix/send', async (request) => {
    requireAdmin(request);
    const bridge = getMatrixBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Matrix is not configured');
    }

    if (!bridge.isConnected()) {
      throw app.httpErrors.badRequest('Matrix adapter is not connected');
    }

    const body = parseBody(app, MatrixSendRequestSchema, request.body);

    try {
      let eventId: string | null;
      if (body.threadId) {
        // Send as thread reply
        eventId = await bridge.sendToThread(body.roomId, body.threadId, body.content, body.authorName);
      } else {
        // Send as room message
        eventId = await bridge.sendToRoom(body.roomId, body.content, body.authorName);
      }
      return { ok: true, eventId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw app.httpErrors.internalServerError(`Failed to send message: ${message}`);
    }
  });

  app.get('/adapters/matrix/rooms', async (request) => {
    requireAdmin(request);
    const bridge = getMatrixBridge();
    if (!bridge) {
      throw app.httpErrors.badRequest('Matrix is not configured');
    }

    if (!bridge.isConnected()) {
      throw app.httpErrors.badRequest('Matrix adapter is not connected');
    }

    const roomIds = bridge.getJoinedRooms();
    const rooms = roomIds.map((roomId) => {
      const info = bridge.getRoomInfo(roomId);
      return info ?? { id: roomId, name: 'Unknown', topic: null };
    });

    return { rooms };
  });
}
