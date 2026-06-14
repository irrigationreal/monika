import type { ForumService, CreateForumInput } from '../interfaces/services';
import type { ForumRepository, ForumListOptions } from '../interfaces/repositories';
import type { Forum } from '../domain/entities';
import type { Clock, IdGenerator } from './types';

export class ForumServiceImpl implements ForumService {
  constructor(
    private readonly deps: {
      forums: ForumRepository;
      clock: Clock;
      ids: IdGenerator;
    }
  ) {}

  listForums(options?: ForumListOptions): Promise<Forum[]> {
    return this.deps.forums.list(options);
  }

  getForum(id: Forum['id']): Promise<Forum | null> {
    return this.deps.forums.getById(id);
  }

  async createForum(input: CreateForumInput): Promise<Forum> {
    const now = this.deps.clock.now();
    const status = input.status ?? 'active';
    const visibility = input.visibility ?? 'public';
    const forum: Forum = {
      id: this.deps.ids.nextId(),
      tenantId: input.tenantId ?? null,
      parentForumId: input.parentForumId ?? null,
      category: input.category ?? null,
      name: input.name,
      description: input.description ?? null,
      cwd: input.cwd ?? null,
      prePrompt: input.prePrompt ?? null,
      status,
      visibility,
      archivedAt: status === 'archived' ? now : null,
      createdAt: now,
      updatedAt: now
    };
    await this.deps.forums.create(forum);
    return forum;
  }
}
