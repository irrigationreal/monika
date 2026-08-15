import {
  NotepadDeleteQuerySchema,
  NotepadEntryUpdateRequestSchema,
  NotepadEntryWriteRequestSchema,
  NotepadListQuerySchema,
} from '@irrigationreal/codex-forum-contracts';
import {
  NotepadConflictError,
  NotepadNotFoundError,
  NotepadQuotaError,
  NotepadValidationError,
} from '@irrigationreal/codex-forum-core';

import { mapNotepadEntryToDto } from '../mappers/dto';
import { parseBody } from '../utils/validation';

import type { NotepadService } from '@irrigationreal/codex-forum-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AccessHelpers } from '../utils/access';

export function registerNotepadRoutes({
  app,
  access,
  service,
}: {
  app: FastifyInstance;
  access: AccessHelpers;
  service: NotepadService;
}): void {
  function owner(request: FastifyRequest): string {
    const user = access.getCurrentUser(request);
    if (!user) throw app.httpErrors.unauthorized('Authentication required');
    if (user.authType !== 'session') throw app.httpErrors.forbidden('Notepad requires a browser session');
    return user.identityId;
  }
  function privateResponse(reply: FastifyReply): void {
    reply.header('cache-control', 'no-store');
  }
  function handle(error: unknown): never {
    if (error instanceof NotepadConflictError) throw app.httpErrors.conflict(error.message);
    if (error instanceof NotepadNotFoundError) throw app.httpErrors.notFound('Note not found');
    if (error instanceof NotepadQuotaError || error instanceof NotepadValidationError)
      throw app.httpErrors.badRequest(error.message);
    if (error instanceof Error) throw error;
    throw new Error('Unknown Notepad error');
  }

  app.get('/notepad', async (request, reply) => {
    privateResponse(reply);
    const identityId = owner(request);
    const query = parseBody(app, NotepadListQuerySchema, request.query);
    const input: { query?: string; tags?: string[]; cursor?: string; limit?: number } = {
      tags: query.tags?.split(',').filter(Boolean) ?? [],
    };
    if (query.q) input.query = query.q;
    if (query.cursor) input.cursor = query.cursor;
    if (query.limit !== undefined) input.limit = query.limit;
    try {
      const result = await service.list(identityId, input);
      return {
        entries: result.entries.map(mapNotepadEntryToDto),
        tags: await service.tags(identityId),
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      return handle(error);
    }
  });

  app.get('/notepad/:id', async (request, reply) => {
    privateResponse(reply);
    const identityId = owner(request);
    const { id } = request.params as { id: string };
    const entry = await service.get(identityId, id);
    if (!entry) throw app.httpErrors.notFound('Note not found');
    return { entry: mapNotepadEntryToDto(entry) };
  });

  app.post('/notepad', async (request, reply) => {
    privateResponse(reply);
    const identityId = owner(request);
    const body = parseBody(app, NotepadEntryWriteRequestSchema, request.body);
    try {
      return { entry: mapNotepadEntryToDto(await service.create(identityId, body)) };
    } catch (error) {
      return handle(error);
    }
  });

  app.patch('/notepad/:id', async (request, reply) => {
    privateResponse(reply);
    const identityId = owner(request);
    const { id } = request.params as { id: string };
    const body = parseBody(app, NotepadEntryUpdateRequestSchema, request.body);
    try {
      return {
        entry: mapNotepadEntryToDto(await service.update(identityId, id, body.expectedRevision, body)),
      };
    } catch (error) {
      return handle(error);
    }
  });

  app.delete('/notepad/:id', async (request, reply) => {
    privateResponse(reply);
    const identityId = owner(request);
    const { id } = request.params as { id: string };
    const { revision } = parseBody(app, NotepadDeleteQuerySchema, request.query);
    try {
      await service.delete(identityId, id, revision);
      return { ok: true };
    } catch (error) {
      return handle(error);
    }
  });
}
