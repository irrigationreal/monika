import { MessageDraftRevisionQuerySchema, MessageDraftWriteRequestSchema } from '@irrigationreal/codex-forum-contracts';
import {
  MessageDraftConflictError,
  MessageDraftNotFoundError,
  MessageDraftQuotaError,
  MessageDraftValidationError,
} from '@irrigationreal/codex-forum-core';

import { mapMessageDraftToDto } from '../mappers/dto';
import { parseBody } from '../utils/validation';

import type { MessageDraft, MessageDraftService } from '@irrigationreal/codex-forum-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ForumStore } from '../store';
import type { AccessHelpers } from '../utils/access';

export function registerMessageDraftRoutes({
  app,
  access,
  service,
  store,
}: {
  app: FastifyInstance;
  access: AccessHelpers;
  service: MessageDraftService;
  store: ForumStore;
}): void {
  const { getCurrentUser, getIdentityFromRequest, canCreateTopic, canPostTopic, canViewTopic } = access;

  function owner(request: FastifyRequest): { identityId: string } {
    const user = getCurrentUser(request);
    if (!user) throw app.httpErrors.unauthorized('Authentication required');
    if (user.authType !== 'session') throw app.httpErrors.forbidden('Private drafts require a browser session');
    return user;
  }
  function privateResponse(reply: FastifyReply): void {
    reply.header('cache-control', 'no-store');
  }
  function handle(error: unknown): never {
    if (error instanceof MessageDraftConflictError) throw app.httpErrors.conflict(error.message);
    if (error instanceof MessageDraftNotFoundError) throw app.httpErrors.notFound('Draft not found');
    if (error instanceof MessageDraftQuotaError || error instanceof MessageDraftValidationError)
      throw app.httpErrors.badRequest(error.message);
    if (error instanceof Error) throw error;
    throw new Error('Unknown draft error');
  }
  function present(request: FastifyRequest, draft: MessageDraft) {
    const identity = getIdentityFromRequest(request);
    if (draft.context === 'new_thread' && draft.forumId) {
      const forum = store.getForum(draft.forumId);
      const allowed = Boolean(forum && canCreateTopic(forum, identity));
      return mapMessageDraftToDto(draft, {
        destinationName: allowed ? (forum?.name ?? null) : null,
        canContinue: allowed,
      });
    }
    if (draft.topicId) {
      const topic = store.getTopic(draft.topicId);
      const forum = topic ? store.getForum(topic.forum_id) : null;
      const visible = Boolean(topic && forum && canViewTopic(topic, forum, identity));
      const allowed = Boolean(
        visible && topic && forum && topic.status === 'open' && canPostTopic(topic, forum, identity)
      );
      return mapMessageDraftToDto(draft, {
        destinationName: allowed ? (topic?.title ?? null) : null,
        canContinue: allowed,
      });
    }
    return mapMessageDraftToDto(draft);
  }

  app.get('/drafts', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    return { drafts: (await service.list(user.identityId)).map((draft) => present(request, draft)) };
  });
  app.get('/drafts/:id', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    const { id } = request.params as { id: string };
    const draft = await service.get(user.identityId, id);
    if (!draft) throw app.httpErrors.notFound('Draft not found');
    return { draft: present(request, draft) };
  });
  app.get('/forums/:forumId/drafts', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    const { forumId } = request.params as { forumId: string };
    return {
      drafts: (await service.listNewThreadByForum(user.identityId, forumId)).map((draft) => present(request, draft)),
    };
  });
  app.get('/topics/:topicId/draft', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    const forum = topic ? store.getForum(topic.forum_id) : null;
    if (!topic || !forum || !canViewTopic(topic, forum, getIdentityFromRequest(request)))
      throw app.httpErrors.notFound('topic not found');
    const draft = await service.getReply(user.identityId, topicId);
    return { draft: draft ? present(request, draft) : null };
  });
  app.put('/topics/:topicId/draft', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    const { topicId } = request.params as { topicId: string };
    const topic = store.getTopic(topicId);
    const forum = topic ? store.getForum(topic.forum_id) : null;
    if (!topic || !forum) throw app.httpErrors.notFound('topic not found');
    if (topic.status !== 'open' || !canPostTopic(topic, forum, getIdentityFromRequest(request)))
      throw app.httpErrors.forbidden('Posting not allowed in this topic');
    const body = parseBody(app, MessageDraftWriteRequestSchema, request.body);
    try {
      return {
        draft: present(
          request,
          await service.saveReply(user.identityId, topicId, body.expectedRevision, { body: body.body })
        ),
      };
    } catch (error) {
      return handle(error);
    }
  });
  app.post('/forums/:forumId/drafts', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    const { forumId } = request.params as { forumId: string };
    const forum = store.getForum(forumId);
    if (!forum || !canCreateTopic(forum, getIdentityFromRequest(request)))
      throw app.httpErrors.forbidden('Posting not allowed in this forum');
    const body = parseBody(app, MessageDraftWriteRequestSchema, request.body);
    if (body.expectedRevision !== 0) throw app.httpErrors.badRequest('New drafts require expectedRevision 0');
    try {
      return {
        draft: present(
          request,
          await service.saveNewThread(user.identityId, forumId, 0, { title: body.title, body: body.body })
        ),
      };
    } catch (error) {
      return handle(error);
    }
  });
  app.put('/drafts/:id', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    const { id } = request.params as { id: string };
    const current = await service.get(user.identityId, id);
    if (!current) throw app.httpErrors.notFound('Draft not found');
    if (current.context !== 'new_thread' || !current.forumId) throw app.httpErrors.notFound('Draft not found');
    const forum = store.getForum(current.forumId);
    if (!forum || !canCreateTopic(forum, getIdentityFromRequest(request)))
      throw app.httpErrors.forbidden('Posting not allowed in this forum');
    const body = parseBody(app, MessageDraftWriteRequestSchema, request.body);
    try {
      return {
        draft: present(
          request,
          await service.saveNewThread(
            user.identityId,
            current.forumId,
            body.expectedRevision,
            { title: body.title, body: body.body },
            id
          )
        ),
      };
    } catch (error) {
      return handle(error);
    }
  });
  app.delete('/drafts/:id', async (request, reply) => {
    privateResponse(reply);
    const user = owner(request);
    const { id } = request.params as { id: string };
    const { revision } = parseBody(app, MessageDraftRevisionQuerySchema, request.query);
    try {
      await service.delete(user.identityId, id, revision);
      return { ok: true };
    } catch (error) {
      return handle(error);
    }
  });
}
