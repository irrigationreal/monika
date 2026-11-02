<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type SecretMetadataDto } from '../lib/apiClient';

const props = withDefaults(defineProps<{ admin?: boolean }>(), { admin: false });

const items = ref<SecretMetadataDto[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const editingId = ref<string | null>(null);
const name = ref('');
const value = ref('');
const tags = ref('');
const expiresAt = ref('');

const heading = computed(() => (props.admin ? 'Secret Management' : 'My Secrets'));
const description = computed(() =>
  props.admin
    ? 'Manage encrypted credentials for the deployment. Values are write-only and are never returned after saving.'
    : 'Store credentials for later brokered use. Values are encrypted by agentd and are never shown after saving.'
);

function resetForm(): void {
  editingId.value = null;
  name.value = '';
  value.value = '';
  tags.value = '';
  expiresAt.value = '';
}

function toLocalInput(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function edit(secret: SecretMetadataDto): void {
  editingId.value = secret.id;
  name.value = secret.name;
  tags.value = secret.tags.join(', ');
  expiresAt.value = toLocalInput(secret.expiresAt);
  value.value = '';
  error.value = '';
}

function expiration(): string | null {
  return expiresAt.value ? new Date(expiresAt.value).toISOString() : null;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = (props.admin ? await api.listAdminSecrets() : await api.listSecrets()).items;
    error.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to load secrets.';
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!value.value.trim()) {
    error.value = editingId.value ? 'Enter the replacement value.' : 'Enter a secret value.';
    return;
  }
  saving.value = true;
  error.value = '';
  const input = {
    name: name.value,
    value: value.value,
    tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
    expiresAt: expiration(),
  };
  try {
    if (!editingId.value) await api.createSecret(input);
    else if (props.admin) await api.replaceAdminSecret(editingId.value, input);
    else await api.replaceSecret(editingId.value, input);
    resetForm();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to save secret.';
  } finally {
    saving.value = false;
  }
}

async function disable(secret: SecretMetadataDto): Promise<void> {
  if (!window.confirm(`Disable “${secret.name}”? It will no longer be available for brokered operations.`)) return;
  try {
    if (props.admin) await api.disableAdminSecret(secret.id);
    else await api.disableSecret(secret.id);
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to disable secret.';
  }
}

async function remove(secret: SecretMetadataDto): Promise<void> {
  if (!window.confirm(`Permanently delete “${secret.name}”? This cannot be undone.`)) return;
  try {
    if (props.admin) await api.deleteAdminSecret(secret.id);
    else await api.deleteSecret(secret.id);
    if (editingId.value === secret.id) resetForm();
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to delete secret.';
  }
}

function isExpired(secret: SecretMetadataDto): boolean {
  return Boolean(secret.expiresAt && Date.parse(secret.expiresAt) <= Date.now());
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

onMounted(load);
</script>

<template>
  <section class="secret-management" :class="{ 'secret-management--admin': admin }" aria-labelledby="secret-management-title">
    <header class="secret-management__header">
      <div>
        <p class="secret-management__eyebrow">Credential custody</p>
        <h2 id="secret-management-title">{{ heading }}</h2>
        <p class="secret-management__description">{{ description }}</p>
      </div>
      <span class="secret-management__shield" aria-hidden="true">&#128274;</span>
    </header>

    <div class="secret-management__notice">
      <strong>Write-only storage.</strong> The forum never displays secret values, stores them in SQLite, or places them in posts and transcripts.
    </div>

    <p v-if="error" class="vb-login-error" role="alert">{{ error }}</p>

    <form class="secret-management__form" @submit.prevent="save">
      <div class="secret-management__form-heading">
        <div>
          <h3>{{ editingId ? 'Replace a secret' : 'Add a secret' }}</h3>
          <p>{{ editingId ? 'Replacement keeps the current disabled state unless you explicitly enable it through the API.' : 'The value is sent once over the authenticated internal bridge.' }}</p>
        </div>
        <button v-if="editingId" class="vb-small-btn" type="button" @click="resetForm">Cancel</button>
      </div>
      <div class="secret-management__fields">
        <label>
          <span>Name</span>
          <input v-model="name" required maxlength="120" autocomplete="off" placeholder="GitHub personal token" />
        </label>
        <label>
          <span>{{ editingId ? 'Replacement value' : 'Secret value' }}</span>
          <input v-model="value" required type="password" maxlength="65536" autocomplete="new-password" :placeholder="editingId ? 'Enter a new value' : 'Paste the value once'" />
        </label>
        <label>
          <span>Tags <em>optional</em></span>
          <input v-model="tags" maxlength="800" autocomplete="off" placeholder="github, ci, production" />
        </label>
        <label>
          <span>Expires <em>optional</em></span>
          <input v-model="expiresAt" type="datetime-local" />
        </label>
      </div>
      <div class="secret-management__actions">
        <button class="vb-btn" type="submit" :disabled="saving">{{ saving ? 'Saving…' : editingId ? 'Replace secret' : 'Add secret' }}</button>
        <span class="secret-management__hint">Never paste a secret into a forum post.</span>
      </div>
    </form>

    <div class="secret-management__list-heading">
      <div>
        <h3>{{ admin ? 'Stored credentials' : 'Your credentials' }}</h3>
        <p>{{ items.length }} {{ items.length === 1 ? 'secret' : 'secrets' }} · values are never readable here</p>
      </div>
      <button class="vb-small-btn" type="button" :disabled="loading" @click="load">Refresh</button>
    </div>

    <div v-if="loading" class="secret-management__empty" role="status">Loading secret metadata…</div>
    <div v-else-if="items.length === 0" class="secret-management__empty">
      <span class="secret-management__empty-icon" aria-hidden="true">&#128274;</span>
      <strong>No secrets stored</strong>
      <span>Add one above when a brokered operation needs it.</span>
    </div>
    <div v-else class="secret-management__table-wrap" tabindex="0" :aria-label="`${heading} table`">
      <table class="secret-management__table">
        <thead>
          <tr><th>Name</th><th v-if="admin">Owner</th><th>State</th><th>Tags</th><th>Expiration</th><th><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          <tr v-for="secret in items" :key="secret.id">
            <td><strong>{{ secret.name }}</strong><small>Updated {{ formatDate(secret.updatedAt) }}</small></td>
            <td v-if="admin"><code>{{ secret.ownerIdentityId }}</code></td>
            <td><span class="secret-management__status" :class="{ 'is-disabled': !secret.enabled, 'is-expired': isExpired(secret) }">{{ !secret.enabled ? 'Disabled' : isExpired(secret) ? 'Expired' : 'Enabled' }}</span></td>
            <td><span v-if="secret.tags.length" class="secret-management__tags"><span v-for="tag in secret.tags" :key="tag">{{ tag }}</span></span><span v-else class="secret-management__muted">None</span></td>
            <td>{{ secret.expiresAt ? formatDate(secret.expiresAt) : 'Never' }}</td>
            <td class="secret-management__row-actions">
              <button class="vb-small-btn" type="button" @click="edit(secret)">Replace</button>
              <button v-if="secret.enabled" class="vb-small-btn" type="button" @click="disable(secret)">Disable</button>
              <button class="vb-small-btn vb-btn-danger" type="button" @click="remove(secret)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.secret-management { max-width: 1100px; margin: 0 auto; color: var(--text-primary); }
.secret-management__header, .secret-management__list-heading, .secret-management__form-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.secret-management__eyebrow { margin: 0 0 4px; color: var(--text-muted); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.secret-management h2, .secret-management h3 { margin: 0; }
.secret-management h2 { font-size: 1.45rem; }
.secret-management h3 { font-size: 1rem; }
.secret-management__description, .secret-management__form-heading p, .secret-management__list-heading p { margin: 6px 0 0; color: var(--text-muted); font-size: 0.88rem; }
.secret-management__shield { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid var(--border-muted); border-radius: 50%; background: var(--bg-surface-alt); font-size: 1.15rem; }
.secret-management__notice { margin: 18px 0; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--status-info) 45%, var(--border-muted)); border-left: 4px solid var(--status-info); background: color-mix(in srgb, var(--status-info) 8%, var(--bg-surface)); color: var(--text-secondary); font-size: 0.86rem; }
.secret-management__form { margin-bottom: 28px; padding: 18px; border: 1px solid var(--border-muted); background: var(--bg-surface); box-shadow: 0 2px 8px var(--shadow-color); }
.secret-management__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.secret-management__fields label { display: grid; gap: 6px; color: var(--text-secondary); font-size: 0.82rem; font-weight: 700; }
.secret-management__fields label em { color: var(--text-muted); font-size: 0.75rem; font-style: normal; font-weight: 400; }
.secret-management__fields input { width: 100%; box-sizing: border-box; }
.secret-management__actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.secret-management__hint { color: var(--text-muted); font-size: 0.78rem; }
.secret-management__list-heading { align-items: end; margin-bottom: 10px; }
.secret-management__table-wrap { overflow-x: auto; border: 1px solid var(--border-muted); background: var(--bg-surface); }
.secret-management__table { width: 100%; border-collapse: collapse; min-width: 760px; }
.secret-management__table th, .secret-management__table td { padding: 11px 12px; border-bottom: 1px solid var(--border-muted); text-align: left; vertical-align: middle; }
.secret-management__table th { background: var(--bg-surface-alt); color: var(--text-muted); font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; }
.secret-management__table tbody tr:last-child td { border-bottom: 0; }
.secret-management__table td small { display: block; margin-top: 4px; color: var(--text-muted); font-size: 0.72rem; }
.secret-management__table code { color: var(--text-secondary); font-size: 0.72rem; }
.secret-management__row-actions { white-space: nowrap; text-align: right !important; }
.secret-management__row-actions button { margin-left: 6px; }
.secret-management__status { display: inline-flex; padding: 3px 7px; border: 1px solid color-mix(in srgb, var(--status-success) 55%, var(--border-muted)); border-radius: 999px; color: var(--status-success); font-size: 0.72rem; font-weight: 700; }
.secret-management__status.is-disabled, .secret-management__status.is-expired { border-color: color-mix(in srgb, var(--status-warning) 55%, var(--border-muted)); color: var(--status-warning); }
.secret-management__tags { display: flex; flex-wrap: wrap; gap: 4px; }
.secret-management__tags span { padding: 2px 6px; border-radius: 3px; background: var(--bg-surface-alt); color: var(--text-secondary); font-size: 0.72rem; }
.secret-management__muted { color: var(--text-muted); }
.secret-management__empty { display: grid; justify-items: center; gap: 6px; padding: 42px 20px; border: 1px dashed var(--border-muted); color: var(--text-muted); text-align: center; }
.secret-management__empty-icon { font-size: 1.6rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 640px) { .secret-management__fields { grid-template-columns: 1fr; } .secret-management__actions { align-items: flex-start; flex-direction: column; } .secret-management__row-actions button { margin-bottom: 4px; } }
</style>
