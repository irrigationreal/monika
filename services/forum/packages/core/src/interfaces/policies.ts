import type { ExternalId, ForumId, IdentityId, PostId, SessionId, SurfaceId, TopicId } from '../domain/ids';
import type { SurfaceEvent, SurfaceKind } from '../domain/surfaces';

export type IngestDecision =
  | { action: 'accept' }
  | { action: 'reject'; reason: string }
  | { action: 'delay'; retryAfterMs: number };

export interface SurfaceIngestPolicy {
  shouldIngest(event: SurfaceEvent): Promise<IngestDecision>;
  shouldStartSession(topicId: TopicId, event: SurfaceEvent): Promise<boolean>;
}

export interface SurfaceMappingPolicy {
  resolveForum(event: SurfaceEvent): Promise<ForumId | null>;
  resolveTopic(event: SurfaceEvent): Promise<TopicId | null>;
  resolveIdentity(event: SurfaceEvent): Promise<IdentityId | null>;
  resolveParentPost(event: SurfaceEvent): Promise<PostId | null>;
  resolveExternalThread?(event: SurfaceEvent): Promise<ExternalId | null>;
}

export interface SurfaceRateLimitPolicy {
  shouldThrottle(surfaceId: SurfaceId, surfaceKind: SurfaceKind, eventType: string): Promise<boolean>;
  nextAvailableAt(surfaceId: SurfaceId, surfaceKind: SurfaceKind, eventType: string): Promise<string | null>;
}

export interface OutboundRoutingPolicy {
  selectReplySurface(topicId: TopicId, sessionId: SessionId): Promise<SurfaceId | null>;
  selectVisibility(topicId: TopicId, sessionId: SessionId): Promise<'public' | 'internal' | 'private'>;
}
