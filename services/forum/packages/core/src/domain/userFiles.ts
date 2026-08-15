import type { IdentityId } from './ids';
import type { NotepadExpirationPreset } from './notepad';

export const UserFileVisibilityValues = ['private', 'members', 'public'] as const;
export type UserFileVisibility = (typeof UserFileVisibilityValues)[number];
export type UserFileFilter = 'standalone' | 'all' | 'post_attachments';
export type UserFileBlobState = 'staging' | 'ready' | 'gc_pending' | 'missing';

export interface UserFilePostAssociation {
  id: string;
  postId: string;
  topicId: string;
  topicTitle: string;
  postNumber: number;
  filename: string;
  mimeType: string;
  deletedAt: string | null;
}

export interface UserFile {
  id: string;
  ownerIdentityId: IdentityId | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  standalone: boolean;
  visibility: UserFileVisibility | null;
  expiresAt: string | null;
  revision: number;
  blobState: UserFileBlobState;
  associations: UserFilePostAssociation[];
  createdAt: string;
  updatedAt: string;
}

export interface UserFileWriteOptions {
  visibility?: UserFileVisibility;
  expiration?: NotepadExpirationPreset;
}

export function canUseStandaloneFile(input: {
  visibility: UserFileVisibility;
  ownerIdentityId: string;
  viewerIdentityId: string | null;
  ownerTenantId: string | null;
  viewerTenantId: string | null;
}): boolean {
  if (input.viewerIdentityId === input.ownerIdentityId) return true;
  if (input.visibility === 'public') return true;
  if (input.visibility === 'private' || !input.viewerIdentityId) return false;
  return input.ownerTenantId === null || input.ownerTenantId === input.viewerTenantId;
}
