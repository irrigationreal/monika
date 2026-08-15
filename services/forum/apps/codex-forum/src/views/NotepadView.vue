<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import ConfirmationDialog from '../components/ConfirmationDialog.vue';
import DraftStatus from '../components/DraftStatus.vue';
import { useAutosavedDraft } from '../composables/useAutosavedDraft';
import { useMarkdown } from '../composables/useMarkdown';
import { api } from '../lib/apiClient';

import type { NotepadDraftOptions, NotepadEntryDto, NotepadExpirationPreset } from '../lib/apiClient';

const { renderContent } = useMarkdown();
const contextId = ref<string | null>('me');
const title = ref('');
const body = ref('');
const options = ref<NotepadDraftOptions>({ tags: [], expiration: 'one_month' });
const tagsText = computed({
  get: () => options.value.tags.join(', '),
  set: (value: string) => {
    options.value = { ...options.value, tags: normalizeTags(value) };
  },
});
const entries = ref<NotepadEntryDto[]>([]);
const availableTags = ref<Array<{ tag: string; count: number }>>([]);
const selectedTags = ref<string[]>([]);
const query = ref('');
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const publishing = ref(false);
const error = ref('');
const showOptions = ref(false);
const showPreview = ref(false);
const editing = ref<NotepadEntryDto | null>(null);
const editTitle = ref('');
const editBody = ref('');
const editTags = ref('');
const editExpiration = ref<NotepadExpirationPreset | 'keep'>('keep');
const confirmation = ref<{
  kind: 'delete' | 'replace-pin' | 'discard-draft';
  entry?: NotepadEntryDto;
} | null>(null);
let requestGeneration = 0;

const autosavedDraft = useAutosavedDraft({
  context: 'notepad',
  contextId,
  title,
  body,
  options,
  resetOptions: () => {
    options.value = { tags: [], expiration: 'one_month' };
  },
});
const canPost = computed(
  () =>
    autosavedDraft.hydrated.value &&
    body.value.trim() &&
    autosavedDraft.status.value !== 'conflict' &&
    !publishing.value
);
const expirationOptions: Array<{ value: NotepadExpirationPreset; label: string }> = [
  { value: 'one_day', label: '1 day' },
  { value: 'one_week', label: '1 week' },
  { value: 'two_weeks', label: '2 weeks' },
  { value: 'one_month', label: '1 month (30 days)' },
  { value: 'six_months', label: '6 months' },
  { value: 'one_year', label: '1 year' },
  { value: 'never', label: 'Never' },
];
const pinned = computed(() => entries.value.find((entry) => entry.pinned) ?? null);
const feed = computed(() => entries.value.filter((entry) => !entry.pinned));

function normalizeTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((tag) => tag.trim().replace(/^#/, '').toLowerCase())
        .filter(Boolean)
    ),
  ];
}
function date(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function expiration(entry: NotepadEntryDto): string {
  return entry.expiresAt ? `expires ${date(entry.expiresAt)}` : 'never expires';
}
async function load(reset = true): Promise<void> {
  if (!reset && loading.value) return;
  const generation = ++requestGeneration;
  loading.value = true;
  error.value = '';
  try {
    const request: { query?: string; tags?: string[]; cursor?: string; limit?: number } = {
      tags: selectedTags.value,
      limit: 30,
    };
    if (query.value.trim()) request.query = query.value.trim();
    if (!reset && nextCursor.value) request.cursor = nextCursor.value;
    const response = await api.listNotepad(request);
    if (generation !== requestGeneration) return;
    entries.value = reset ? response.entries : [...entries.value, ...response.entries];
    availableTags.value = response.tags;
    nextCursor.value = response.nextCursor;
  } catch (err) {
    if (generation === requestGeneration) error.value = err instanceof Error ? err.message : 'Failed to load Notepad.';
  } finally {
    if (generation === requestGeneration) loading.value = false;
  }
}
async function toggleTag(tag: string): Promise<void> {
  selectedTags.value = selectedTags.value.includes(tag)
    ? selectedTags.value.filter((item) => item !== tag)
    : [...selectedTags.value, tag];
  await load();
}
async function publish(): Promise<void> {
  if (!canPost.value) return;
  publishing.value = true;
  error.value = '';
  try {
    const draft = await autosavedDraft.flush();
    if (!draft || autosavedDraft.dirty.value || autosavedDraft.status.value !== 'saved') {
      throw new Error('Resolve or retry the saved draft before posting this note.');
    }
    const response = await api.createNotepadEntry({
      title: title.value.trim() || null,
      body: body.value,
      tags: options.value.tags,
      expiration: options.value.expiration,
      draft,
    });
    entries.value = [response.entry, ...entries.value];
    title.value = '';
    body.value = '';
    options.value = { tags: [], expiration: 'one_month' };
    autosavedDraft.resetAfterPublication();
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to post note.';
  } finally {
    publishing.value = false;
  }
}
function beginEdit(entry: NotepadEntryDto): void {
  editing.value = entry;
  editTitle.value = entry.title ?? '';
  editBody.value = entry.body;
  editTags.value = entry.tags.join(', ');
  editExpiration.value = 'keep';
}
async function saveEdit(): Promise<void> {
  const entry = editing.value;
  if (!entry) return;
  error.value = '';
  try {
    const response = await api.updateNotepadEntry(entry.id, {
      expectedRevision: entry.revision,
      title: editTitle.value.trim() || null,
      body: editBody.value,
      tags: normalizeTags(editTags.value),
      expiration: editExpiration.value,
    });
    entries.value = entries.value.map((item) => (item.id === entry.id ? response.entry : item));
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save note.';
  }
}
async function togglePin(entry: NotepadEntryDto): Promise<void> {
  if (!entry.pinned && pinned.value) {
    confirmation.value = { kind: 'replace-pin', entry };
    return;
  }
  await performPin(entry);
}
async function performPin(entry: NotepadEntryDto): Promise<void> {
  try {
    await api.updateNotepadEntry(entry.id, {
      expectedRevision: entry.revision,
      title: entry.title,
      body: entry.body,
      tags: entry.tags,
      expiration: 'keep',
      pinned: !entry.pinned,
    });
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update pinned note.';
  }
}
function remove(entry: NotepadEntryDto): void {
  confirmation.value = { kind: 'delete', entry };
}
async function confirmAction(): Promise<void> {
  const pending = confirmation.value;
  confirmation.value = null;
  if (!pending) return;
  if (pending.kind === 'discard-draft') {
    await autosavedDraft.discard();
    return;
  }
  if (!pending.entry) return;
  if (pending.kind === 'replace-pin') {
    await performPin(pending.entry);
    return;
  }
  try {
    await api.deleteNotepadEntry(pending.entry.id, pending.entry.revision);
    entries.value = entries.value.filter((item) => item.id !== pending.entry.id);
    await load();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to delete note.';
  }
}
async function copy(entry: NotepadEntryDto): Promise<void> {
  await navigator.clipboard.writeText([entry.title, entry.body].filter(Boolean).join('\n\n'));
}

onMounted(async () => {
  await autosavedDraft.load();
  await load();
});
</script>

<template>
  <section class="vb-section vb-notepad">
    <ConfirmationDialog
      :open="confirmation !== null"
      :title="
        confirmation?.kind === 'delete'
          ? 'Delete note?'
          : confirmation?.kind === 'discard-draft'
            ? 'Discard Notepad draft?'
            : 'Replace pinned note?'
      "
      :message="
        confirmation?.kind === 'delete'
          ? 'This permanently deletes the note without leaving a tombstone. This cannot be undone.'
          : confirmation?.kind === 'discard-draft'
            ? 'This permanently deletes the saved Notepad draft. This cannot be undone.'
            : 'This note will replace your current pinned note.'
      "
      :confirm-label="
        confirmation?.kind === 'delete'
          ? 'Delete note'
          : confirmation?.kind === 'discard-draft'
            ? 'Discard draft'
            : 'Replace pinned note'
      "
      cancel-label="Cancel"
      @confirm="confirmAction"
      @cancel="confirmation = null"
    />
    <div class="vb-table-header">My Notepad</div>
    <p class="vb-notepad-privacy">
      Notes are visible only to your account in the forum. They are stored on the forum server and are not end-to-end
      encrypted.
    </p>
    <div v-if="error" class="vb-form-error" role="alert">{{ error }}</div>

    <form class="vb-note-composer" @submit.prevent="publish">
      <input
        v-model="title"
        :disabled="publishing"
        class="vb-text-input"
        maxlength="255"
        placeholder="Optional title"
        aria-label="Note title"
      />
      <textarea
        v-model="body"
        :disabled="publishing"
        class="vb-textarea"
        rows="6"
        placeholder="Write a note…"
        aria-label="Note body"
      ></textarea>
      <div class="vb-note-composer-tools">
        <button type="button" class="vb-small-btn" @click="showOptions = !showOptions">
          {{ showOptions ? 'Hide options' : 'Options' }}
        </button>
        <button type="button" class="vb-small-btn" @click="showPreview = !showPreview">
          {{ showPreview ? 'Hide preview' : 'Preview' }}
        </button>
        <DraftStatus
          v-if="!publishing"
          :status="autosavedDraft.status.value"
          :expires-at="autosavedDraft.expiresAt.value"
          :conflict="Boolean(autosavedDraft.remoteDraft.value)"
          @discard="confirmation = { kind: 'discard-draft' }"
          @retry="autosavedDraft.flush"
          @use-saved="autosavedDraft.useSavedVersion"
          @keep-mine="autosavedDraft.keepMyVersion"
          @copy-mine="autosavedDraft.copyMyText"
        />
      </div>
      <div v-if="showOptions" class="vb-note-options">
        <label
          >Tags
          <input v-model="tagsText" :disabled="publishing" class="vb-text-input" placeholder="writing, todo, links"
        /></label>
        <label
          >Expires
          <select v-model="options.expiration" :disabled="publishing" class="vb-select">
            <option v-for="item in expirationOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
      </div>
      <div v-if="showPreview" class="vb-note-preview" v-html="renderContent(body, null)"></div>
      <button class="vb-button vb-note-post" type="submit" :disabled="!canPost">
        {{ publishing ? 'Posting…' : 'Post Note' }}
      </button>
    </form>

    <div class="vb-note-filters">
      <div class="vb-note-search">
        <input
          v-model="query"
          class="vb-text-input"
          type="search"
          placeholder="Search your Notepad"
          @keyup.enter="load()"
        />
        <button class="vb-small-btn" type="button" @click="load()">Search</button>
      </div>
      <details class="vb-note-tags" open>
        <summary>Tags</summary>
        <button
          v-for="tag in availableTags"
          :key="tag.tag"
          type="button"
          class="vb-tag-chip"
          :class="{ active: selectedTags.includes(tag.tag) }"
          @click="toggleTag(tag.tag)"
        >
          #{{ tag.tag }} <span>{{ tag.count }}</span>
        </button>
        <span v-if="!availableTags.length" class="vb-form-hint">No tags yet.</span>
      </details>
    </div>

    <article v-if="pinned" class="vb-note-card vb-note-pinned">
      <div class="vb-note-label">Pinned Note</div>
      <h2 v-if="pinned.title">{{ pinned.title }}</h2>
      <div class="vb-post-body" v-html="renderContent(pinned.body, null)"></div>
      <div class="vb-note-tag-row">
        <button v-for="tag in pinned.tags" :key="tag" class="vb-tag-chip" @click="toggleTag(tag)">#{{ tag }}</button>
      </div>
      <div class="vb-note-meta">posted {{ date(pinned.createdAt) }} · {{ expiration(pinned) }}</div>
      <div class="vb-note-actions">
        <button class="vb-small-btn" @click="beginEdit(pinned)">Edit</button
        ><button class="vb-small-btn" @click="copy(pinned)">Copy</button>
        <button class="vb-small-btn" @click="togglePin(pinned)">Unpin</button
        ><button class="vb-small-btn vb-btn-danger" @click="remove(pinned)">Delete</button>
      </div>
    </article>

    <div class="vb-note-feed">
      <article v-for="entry in feed" :id="`note-${entry.id}`" :key="entry.id" class="vb-note-card">
        <h2 v-if="entry.title">{{ entry.title }}</h2>
        <div class="vb-post-body" v-html="renderContent(entry.body, null)"></div>
        <div class="vb-note-tag-row">
          <button v-for="tag in entry.tags" :key="tag" class="vb-tag-chip" @click="toggleTag(tag)">#{{ tag }}</button>
        </div>
        <div class="vb-note-meta">
          posted {{ date(entry.createdAt)
          }}<template v-if="entry.updatedAt !== entry.createdAt"> · edited {{ date(entry.updatedAt) }}</template> ·
          {{ expiration(entry) }}
        </div>
        <div class="vb-note-actions">
          <button class="vb-small-btn" @click="beginEdit(entry)">Edit</button
          ><button class="vb-small-btn" @click="copy(entry)">Copy</button>
          <button class="vb-small-btn" @click="togglePin(entry)">Pin</button
          ><button class="vb-small-btn vb-btn-danger" @click="remove(entry)">Delete</button>
        </div>
      </article>
      <div v-if="!feed.length && !pinned && !loading" class="vb-empty">No notes yet.</div>
      <button v-if="nextCursor" class="vb-button" type="button" :disabled="loading" @click="load(false)">
        Load more
      </button>
    </div>

    <div v-if="editing" class="vb-modal-overlay" @click.self="editing = null">
      <form class="vb-modal vb-note-edit" @submit.prevent="saveEdit">
        <div class="vb-modal-header">
          <span>Edit Note</span><button type="button" class="vb-modal-close" @click="editing = null">×</button>
        </div>
        <div class="vb-modal-body">
          <input v-model="editTitle" class="vb-text-input" maxlength="255" placeholder="Optional title" />
          <textarea v-model="editBody" class="vb-textarea" rows="10"></textarea>
          <label>Tags <input v-model="editTags" class="vb-text-input" /></label>
          <label
            >Expiration
            <select v-model="editExpiration" class="vb-select">
              <option value="keep">Keep current expiration</option>
              <option v-for="item in expirationOptions" :key="item.value" :value="item.value">
                {{ item.label }} from save time
              </option>
            </select>
          </label>
        </div>
        <div class="vb-modal-footer">
          <button type="button" class="vb-small-btn" @click="editing = null">Cancel</button
          ><button class="vb-button" type="submit">Save Changes</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.vb-notepad-privacy {
  padding: 10px 14px;
  margin: 0;
  background: var(--bg-surface-alt);
  color: var(--text-muted);
}
.vb-note-composer,
.vb-note-filters,
.vb-note-card {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  padding: 12px;
  margin: 10px 0;
}
.vb-note-composer {
  display: grid;
  gap: 8px;
}
.vb-note-composer-tools,
.vb-note-actions,
.vb-note-search,
.vb-note-tag-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.vb-note-options {
  display: grid;
  grid-template-columns: 1fr minmax(180px, 0.35fr);
  gap: 10px;
}
.vb-note-options label,
.vb-note-edit label {
  display: grid;
  gap: 4px;
  font-weight: 600;
}
.vb-note-preview {
  border: 1px solid var(--border-muted);
  background: var(--bg-surface-alt);
  padding: 10px;
}
.vb-note-post {
  width: 100%;
}
.vb-note-search .vb-text-input {
  flex: 1;
}
.vb-note-tags {
  margin-top: 10px;
}
.vb-note-tags summary {
  cursor: pointer;
  font-weight: 700;
  margin-bottom: 7px;
}
.vb-tag-chip {
  border: 1px solid var(--border-default);
  background: var(--bg-surface-alt);
  color: var(--link);
  padding: 3px 7px;
  margin: 2px;
  cursor: pointer;
}
.vb-tag-chip.active {
  background: var(--grad-btn-start);
  color: var(--text-inverse);
}
.vb-note-pinned {
  border-width: 2px;
}
.vb-note-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
}
.vb-note-card h2 {
  font-size: 16px;
  margin: 0 0 8px;
}
.vb-note-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin: 8px 0;
}
.vb-note-edit {
  width: min(720px, calc(100vw - 24px));
}
.vb-note-edit .vb-modal-body {
  display: grid;
  gap: 10px;
}
@media (max-width: 600px) {
  .vb-note-options {
    grid-template-columns: 1fr;
  }
  .vb-note-tags:not([open]) {
    display: block;
  }
}
</style>
