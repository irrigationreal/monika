import type { IdentityId } from './ids';

export const NotepadExpirationPresetValues = [
  'one_day',
  'one_week',
  'two_weeks',
  'one_month',
  'six_months',
  'one_year',
  'never',
] as const;
export type NotepadExpirationPreset = (typeof NotepadExpirationPresetValues)[number];

export const NotepadContentFormatValues = ['plaintext-v1'] as const;
export type NotepadContentFormat = (typeof NotepadContentFormatValues)[number];

export interface NotepadEntry {
  id: string;
  ownerIdentityId: IdentityId;
  contentFormat: NotepadContentFormat;
  title: string | null;
  body: string;
  tags: string[];
  pinned: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface NotepadTagSummary {
  tag: string;
  count: number;
}

export interface NotepadDraftOptions {
  tags: string[];
  expiration: NotepadExpirationPreset;
}

export interface NotepadEntryWriteInput {
  title?: string | null;
  body: string;
  tags?: string[];
  expiration?: NotepadExpirationPreset;
}

export const NOTEPAD_LIMITS = {
  titleCharacters: 255,
  bodyUtf8Bytes: 65536,
  tagsPerEntry: 20,
  tagCharacters: 40,
  entriesPerIdentity: 5000,
} as const;

export class NotepadConflictError extends Error {}
export class NotepadNotFoundError extends Error {}
export class NotepadQuotaError extends Error {}
export class NotepadValidationError extends Error {}

export function normalizeNotepadTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
    if (!tag || seen.has(tag)) continue;
    if (tag.length > NOTEPAD_LIMITS.tagCharacters || !/^[\p{L}\p{N}_-]+$/u.test(tag))
      throw new NotepadValidationError(
        `Tags must be at most ${String(NOTEPAD_LIMITS.tagCharacters)} letters, numbers, underscores, or hyphens`
      );
    seen.add(tag);
    normalized.push(tag);
  }
  if (normalized.length > NOTEPAD_LIMITS.tagsPerEntry)
    throw new NotepadValidationError(`A note may have at most ${String(NOTEPAD_LIMITS.tagsPerEntry)} tags`);
  return normalized;
}

export function notepadExpiresAt(preset: NotepadExpirationPreset, now: string): string | null {
  if (preset === 'never') return null;
  const durations: Record<Exclude<NotepadExpirationPreset, 'never'>, number> = {
    one_day: 1,
    one_week: 7,
    two_weeks: 14,
    one_month: 30,
    six_months: 180,
    one_year: 365,
  };
  return new Date(Date.parse(now) + durations[preset] * 24 * 60 * 60 * 1000).toISOString();
}
