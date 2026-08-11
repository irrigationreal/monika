import type { PostId, SurfaceId, TopicId, UtteranceId } from './ids';

export type UtteranceOrigin = {
  utteranceId: UtteranceId;
  originKind: 'forum' | 'external';
  channelKind: string;
  topicId: TopicId;
  postId: PostId;
  surfaceId: SurfaceId | null;
  externalEventId: string | null;
  scope: string | null;
  scopeKind: string | null;
};

export type AttachmentReference = {
  version: 1;
  refEntryId: string;
  pendingAttachmentId: string;
  topicId: TopicId;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
};

/** Stable dispatch grouping identity. It intentionally excludes event/post IDs. */
export function originMatchesSurface(
  origin: Partial<Pick<UtteranceOrigin, 'channelKind' | 'surfaceId' | 'scope'>> | null | undefined,
  subscription: { channelKind: string; surfaceId: string; scope: string }
): boolean {
  return Boolean(origin
    && origin.channelKind === subscription.channelKind
    && origin.surfaceId === subscription.surfaceId
    && origin.scope === subscription.scope);
}

export function normalizedOriginKey(origin: UtteranceOrigin): string {
  if (origin.originKind === 'forum') return `forum:${origin.channelKind}:${origin.topicId}`;
  return [
    'external',
    origin.channelKind,
    origin.surfaceId ?? '',
    origin.scopeKind ?? '',
    origin.scope ?? '',
    origin.topicId,
  ].map((part) => encodeURIComponent(part)).join(':');
}
