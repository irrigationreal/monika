import type { IdentityPrivate, IdentityPublic } from '../domain/entities';
import type { TopicId } from '../domain/ids';
import type { IdentityRepository } from '../interfaces/repositories';
import type { IdentityService } from '../interfaces/services';

export class IdentityServiceImpl implements IdentityService {
  constructor(private readonly repo: IdentityRepository) {}

  async getIdentity(id: IdentityPublic['id']): Promise<IdentityPublic | null> {
    const identity = await this.repo.getById(id);
    return identity ? toPublicIdentity(identity) : null;
  }

  listIdentities(topicId: TopicId, page?: number, pageSize?: number): Promise<IdentityPublic[]> {
    return this.repo.listByTopic(topicId, page, pageSize);
  }
}

function toPublicIdentity(identity: IdentityPrivate): IdentityPublic {
  const {
    username: _username,
    passwordHash: _passwordHash,
    privateEmail: _privateEmail,
    quickReplyDesktopMode: _quickReplyDesktopMode,
    quickReplyMobileMode: _quickReplyMobileMode,
    ...publicIdentity
  } = identity;
  return publicIdentity;
}
