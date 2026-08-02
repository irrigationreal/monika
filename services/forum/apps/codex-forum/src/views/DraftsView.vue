<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { api } from '../lib/apiClient';

import type { MessageDraftDto } from '../lib/apiClient';

const drafts = ref<MessageDraftDto[]>([]);
const query = ref('');
const error = ref('');
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return drafts.value.filter(
    (draft) =>
      !needle || `${draft.destinationName ?? ''} ${draft.title ?? ''} ${draft.body}`.toLowerCase().includes(needle)
  );
});
const replyDrafts = computed(() => filtered.value.filter((draft) => draft.context === 'reply'));
const threadDrafts = computed(() => filtered.value.filter((draft) => draft.context === 'new_thread'));
const date = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const excerpt = (draft: MessageDraftDto) => draft.body.trim().replace(/\s+/g, ' ').slice(0, 180) || '(title only)';
function destination(draft: MessageDraftDto): string {
  return draft.destinationName ?? 'Destination unavailable';
}
function link(draft: MessageDraftDto) {
  return draft.context === 'reply'
    ? { name: 'topic.reply', params: { topicId: draft.topicId } }
    : { name: 'forum.newthread', params: { forumId: draft.forumId }, query: { draft: draft.id } };
}
async function loadDrafts(): Promise<void> {
  drafts.value = (await api.listDrafts()).drafts;
}
async function remove(draft: MessageDraftDto): Promise<void> {
  if (!window.confirm('Delete this draft permanently?')) return;
  try {
    await api.deleteDraft(draft.id, draft.revision);
    drafts.value = drafts.value.filter((item) => item.id !== draft.id);
  } catch (err) {
    const conflict = Boolean(err && typeof err === 'object' && 'status' in err && err.status === 409);
    if (conflict) {
      try {
        await loadDrafts();
        error.value = 'This draft changed before deletion. The latest version is loaded; review it and retry.';
        return;
      } catch {
        // Preserve the original conflict when refresh also fails.
      }
    }
    error.value = err instanceof Error ? err.message : 'Failed to delete draft.';
  }
}
async function copy(draft: MessageDraftDto): Promise<void> {
  await navigator.clipboard.writeText([draft.title, draft.body].filter(Boolean).join('\n\n'));
}
onMounted(async () => {
  try {
    await loadDrafts();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load drafts.';
  }
});
</script>
<template>
  <section class="vb-section">
    <div class="vb-table-header">My Drafts</div>
    <div class="vb-drafts-panel">
      <p>
        Drafts are private to your account. They expire 30 days after their last material edit. Opening a draft does not
        renew it.
      </p>
      <div v-if="error" class="vb-form-error" role="alert">{{ error }}</div>
      <input
        v-model="query"
        type="search"
        class="vb-draft-search"
        placeholder="Search your drafts"
        aria-label="Search drafts"
      />
      <template
        v-for="group in [
          { title: 'New threads', items: threadDrafts },
          { title: 'Replies', items: replyDrafts },
        ]"
        :key="group.title"
      >
        <h2>{{ group.title }} ({{ group.items.length }})</h2>
        <div v-if="!group.items.length" class="vb-form-hint">No drafts in this group.</div>
        <article v-for="draft in group.items" :key="draft.id" class="vb-draft-card">
          <h3>{{ draft.title || destination(draft) }}</h3>
          <div class="vb-draft-meta">
            {{ destination(draft) }} · edited {{ date(draft.updatedAt) }} · expires {{ date(draft.expiresAt) }}
          </div>
          <p>{{ excerpt(draft) }}</p>
          <div class="vb-draft-actions">
            <router-link v-if="draft.canContinue" class="vb-small-btn" :to="link(draft)">Continue editing</router-link>
            <button type="button" class="vb-small-btn" @click="copy(draft)">Copy text</button>
            <button type="button" class="vb-small-btn vb-btn-danger" @click="remove(draft)">Delete</button>
          </div>
        </article>
      </template>
    </div>
  </section>
</template>
<style scoped>
.vb-drafts-panel {
  padding: 18px;
  border: 1px solid var(--border-muted);
  background: var(--bg-surface-alt);
}
.vb-draft-search {
  width: 100%;
  padding: 9px;
  margin: 8px 0 16px;
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
}
.vb-draft-card {
  padding: 12px;
  margin: 8px 0;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
}
.vb-draft-card h3 {
  margin: 0 0 4px;
}
.vb-draft-meta {
  font-size: 11px;
  color: var(--text-muted);
}
.vb-draft-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
