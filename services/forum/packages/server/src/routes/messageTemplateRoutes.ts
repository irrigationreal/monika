import {
  MessageTemplateEffectiveQuerySchema,
  MessageTemplateReorderRequestSchema,
  MessageTemplateRevisionQuerySchema,
  MessageTemplateUpdateRequestSchema,
  MessageTemplateWriteRequestSchema,
} from '@irrigationreal/codex-forum-contracts';
import {
  MessageTemplateConflictError,
  MessageTemplateNotFoundError,
  MessageTemplateQuotaError,
  MessageTemplateValidationError,
} from '@irrigationreal/codex-forum-core';

import { mapMessageTemplateToDto } from '../mappers/dto';
import { parseBody } from '../utils/validation';

import type { MessageTemplateService } from '@irrigationreal/codex-forum-core';
import type { FastifyInstance } from 'fastify';

import type { AccessHelpers } from '../utils/access';

export function registerMessageTemplateRoutes({
  app,
  access,
  service,
}: {
  app: FastifyInstance;
  access: AccessHelpers;
  service: MessageTemplateService;
}): void {
  const { getCurrentUser, getIdentityFromRequest, requireScope, requireAdmin, requireForumVisibleById } = access;

  const respond = (templates: Awaited<ReturnType<MessageTemplateService['listPersonal']>>) => ({
    templates: templates.map(mapMessageTemplateToDto),
  });
  const ensureNotImpersonating = (authType: string): void => {
    if (authType === 'impersonation')
      throw app.httpErrors.forbidden('Personal message templates are unavailable while impersonating');
  };
  const validateForums = (forumIds: string[], identity: ReturnType<typeof getIdentityFromRequest>): void => {
    for (const forumId of forumIds) requireForumVisibleById(forumId, identity);
  };
  const handleError = (error: unknown): never => {
    if (error instanceof MessageTemplateConflictError) throw app.httpErrors.conflict(error.message);
    if (error instanceof MessageTemplateNotFoundError) throw app.httpErrors.notFound(error.message);
    if (error instanceof MessageTemplateQuotaError || error instanceof MessageTemplateValidationError)
      throw app.httpErrors.badRequest(error.message);
    if (error instanceof Error) throw error;
    throw new Error('Unknown message template error');
  };

  app.get('/message-templates/effective', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    const query = parseBody(app, MessageTemplateEffectiveQuerySchema, request.query);
    requireForumVisibleById(query.forumId, getIdentityFromRequest(request));
    return respond(
      await service.listEffective({
        identityId: user.identityId,
        context: query.context,
        forumId: query.forumId,
        includePersonal: user.authType !== 'impersonation',
      })
    );
  });

  app.get('/message-templates/mine', async (request) => {
    const user = requireScope(getCurrentUser(request), 'read');
    ensureNotImpersonating(user.authType);
    return respond(await service.listPersonal(user.identityId));
  });

  app.post('/message-templates', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    ensureNotImpersonating(user.authType);
    const body = parseBody(app, MessageTemplateWriteRequestSchema, request.body);
    validateForums(body.forumIds, getIdentityFromRequest(request));
    try {
      return mapMessageTemplateToDto(await service.createPersonal(user.identityId, body));
    } catch (error) {
      return handleError(error);
    }
  });

  app.patch('/message-templates/:id', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    ensureNotImpersonating(user.authType);
    const { id } = request.params as { id: string };
    const body = parseBody(app, MessageTemplateUpdateRequestSchema, request.body);
    validateForums(body.forumIds, getIdentityFromRequest(request));
    const { revision, ...value } = body;
    try {
      return mapMessageTemplateToDto(await service.updatePersonal(user.identityId, id, revision, value));
    } catch (error) {
      return handleError(error);
    }
  });

  app.delete('/message-templates/:id', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    ensureNotImpersonating(user.authType);
    const { id } = request.params as { id: string };
    const { revision } = parseBody(app, MessageTemplateRevisionQuerySchema, request.query);
    try {
      await service.deletePersonal(user.identityId, id, revision);
      return { ok: true };
    } catch (error) {
      return handleError(error);
    }
  });

  app.post('/message-templates/reorder', async (request) => {
    const user = requireScope(getCurrentUser(request), 'write');
    ensureNotImpersonating(user.authType);
    const body = parseBody(app, MessageTemplateReorderRequestSchema, request.body);
    try {
      return respond(await service.reorderPersonal(user.identityId, body.items));
    } catch (error) {
      return handleError(error);
    }
  });

  app.get('/admin/message-templates', async (request) => {
    requireAdmin(request);
    return respond(await service.listSystem());
  });

  app.post('/admin/message-templates', async (request) => {
    const user = requireAdmin(request);
    const body = parseBody(app, MessageTemplateWriteRequestSchema, request.body);
    validateForums(body.forumIds, getIdentityFromRequest(request));
    try {
      return mapMessageTemplateToDto(await service.createSystem(user.identityId, body));
    } catch (error) {
      return handleError(error);
    }
  });

  app.patch('/admin/message-templates/:id', async (request) => {
    const user = requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = parseBody(app, MessageTemplateUpdateRequestSchema, request.body);
    validateForums(body.forumIds, getIdentityFromRequest(request));
    const { revision, ...value } = body;
    try {
      return mapMessageTemplateToDto(await service.updateSystem(user.identityId, id, revision, value));
    } catch (error) {
      return handleError(error);
    }
  });

  app.delete('/admin/message-templates/:id', async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const { revision } = parseBody(app, MessageTemplateRevisionQuerySchema, request.query);
    try {
      await service.deleteSystem(id, revision);
      return { ok: true };
    } catch (error) {
      return handleError(error);
    }
  });

  app.post('/admin/message-templates/reorder', async (request) => {
    const user = requireAdmin(request);
    const body = parseBody(app, MessageTemplateReorderRequestSchema, request.body);
    try {
      return respond(await service.reorderSystem(user.identityId, body.items));
    } catch (error) {
      return handleError(error);
    }
  });
}
