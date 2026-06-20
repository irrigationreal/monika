<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useForumState } from '../composables/useForumState';
import { api } from '../lib/apiClient';

import type { ApiKeyDto, ImpersonationTokenDto } from '../lib/apiClient';

const router = useRouter();
const state = useForumState();

const apiKeys = ref<ApiKeyDto[]>([]);
const impersonationTokens = ref<ImpersonationTokenDto[]>([]);
const isLoading = ref(false);
const errorMessage = ref('');

const showCreateModal = ref(false);
const showImpersonationModal = ref(false);

const newKeyLabel = ref('');
const newKeyScopes = ref<string[]>(['read', 'write']);
const newKeyExpiresDays = ref('');
const createError = ref('');
const generatedKey = ref('');

const newImpersonationLabel = ref('');
const newImpersonationDisplayName = ref('');
const newImpersonationAvatarUrl = ref('');
const newImpersonationScopes = ref<string[]>(['read', 'write']);
const newImpersonationExpiresDays = ref('');
const impersonationError = ref('');
const generatedImpersonationKey = ref('');

const lastCopied = ref('');
const llmCopied = ref(false);

const currentUser = computed(() => state.currentUser.value);
const isLoggedIn = computed(() => state.isLoggedIn.value);
const isAdmin = computed(() => currentUser.value?.kind === 'admin');

const apiBase = computed(() => {
  if (typeof window === 'undefined') return 'https://forum.irrigate.cc';
  return window.location.origin;
});

const curlQuickstart = computed(() => {
  return [
    `# Base URL`,
    `BASE_URL=\"${apiBase.value}\"`,
    '',
    '# List forums',
    'curl -sS \"$BASE_URL/api/forums\"',
    '',
    '# Create an API key (requires session token)',
    'curl -sS -H \"Authorization: Bearer <SESSION_TOKEN>\" -H \"Content-Type: application/json\" \\',
    '  -d \"{\\\"label\\\":\\\"my key\\\",\\\"scopes\\\":[\\\"read\\\",\\\"write\\\"]}\" \\',
    '  \"$BASE_URL/api/api-keys\"',
    '',
    '# Use API key',
    'curl -sS -H \"Authorization: Bearer <API_KEY>\" \"$BASE_URL/api/forums\"',
  ].join('\\n');
});

const llmContextPack = computed(() => {
  return [
    'Codex Forum LLM Context Pack',
    '',
    `Base URL: ${apiBase.value}`,
    'Auth: API key via Authorization: Bearer <API_KEY> (or X-Api-Key header)',
    '',
    'Core endpoints:',
    'GET /api/forums',
    'GET /api/forums/{forumId}/topics',
    'POST /api/forums/{forumId}/topics',
    'GET /api/topics/{topicId}',
    'POST /api/topics/{topicId}/posts',
    'GET /api/user-files',
    'POST /api/user-files',
    '',
    'Key management:',
    'GET /api/api-keys',
    'POST /api/api-keys',
    'DELETE /api/api-keys/{id}',
    '',
    'Machine-readable docs:',
    'GET /api/openapi.json',
    'GET /api/postman/collection.json',
    '',
    'Notes:',
    '- Use scopes: read, write, admin.',
    '- Keep API keys secret and rotate if leaked.',
    '- Use markdown or BBCode for formatted posts.',
  ].join('\n');
});

function openCreateModal(): void {
  showCreateModal.value = true;
  newKeyLabel.value = '';
  newKeyScopes.value = ['read', 'write'];
  newKeyExpiresDays.value = '';
  createError.value = '';
  generatedKey.value = '';
}

function openImpersonationModal(): void {
  showImpersonationModal.value = true;
  newImpersonationLabel.value = '';
  newImpersonationDisplayName.value = '';
  newImpersonationAvatarUrl.value = '';
  newImpersonationScopes.value = ['read', 'write'];
  newImpersonationExpiresDays.value = '';
  impersonationError.value = '';
  generatedImpersonationKey.value = '';
}

function closeCreateModal(): void {
  showCreateModal.value = false;
  createError.value = '';
  generatedKey.value = '';
}

function closeImpersonationModal(): void {
  showImpersonationModal.value = false;
  impersonationError.value = '';
  generatedImpersonationKey.value = '';
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function formatScopes(scopes: string[]): string {
  if (scopes.length === 0) return '—';
  return scopes.join(', ');
}

function tokenPreview(prefix: string): string {
  return `${prefix}...`;
}

async function copyText(text: string, key: string): Promise<void> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
    lastCopied.value = key;
    setTimeout(() => {
      if (lastCopied.value === key) lastCopied.value = '';
    }, 2000);
  } catch (err) {
    console.error('Copy failed', err);
  }
}

async function copyLlmPack(): Promise<void> {
  await copyText(llmContextPack.value, 'llm');
  llmCopied.value = true;
  setTimeout(() => {
    llmCopied.value = false;
  }, 2000);
}

function parseExpiresAt(daysInput: string): string | null {
  if (!daysInput.trim()) return null;
  const days = Number(daysInput);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('Expiration must be a positive number of days.');
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function loadKeys(): Promise<void> {
  if (!isLoggedIn.value) return;
  isLoading.value = true;
  errorMessage.value = '';
  try {
    const res = await api.listApiKeys();
    apiKeys.value = res.items;
    if (isAdmin.value) {
      const impersonations = await api.listImpersonationTokens();
      impersonationTokens.value = impersonations.items;
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load API keys.';
  } finally {
    isLoading.value = false;
  }
}

async function createKey(): Promise<void> {
  if (!newKeyLabel.value.trim()) {
    createError.value = 'Provide a label so you can identify the key later.';
    return;
  }
  createError.value = '';
  try {
    const expiresAt = parseExpiresAt(newKeyExpiresDays.value);
    const payload: { label: string; scopes?: string[]; expiresAt?: string | null } = {
      label: newKeyLabel.value.trim(),
    };
    if (newKeyScopes.value.length) payload.scopes = newKeyScopes.value;
    if (expiresAt !== null) payload.expiresAt = expiresAt;
    const res = await api.createApiKey(payload);
    apiKeys.value = [res.apiKey, ...apiKeys.value];
    generatedKey.value = res.token;
  } catch (err) {
    createError.value = err instanceof Error ? err.message : 'Failed to create API key.';
  }
}

async function revokeKey(id: string): Promise<void> {
  try {
    await api.revokeApiKey(id);
    apiKeys.value = apiKeys.value.map((key: ApiKeyDto) =>
      key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key
    );
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to revoke API key.';
  }
}

async function createImpersonationToken(): Promise<void> {
  if (!newImpersonationLabel.value.trim()) {
    impersonationError.value = 'Provide a label for this impersonation token.';
    return;
  }
  if (!newImpersonationDisplayName.value.trim()) {
    impersonationError.value = 'Provide a display name for the impersonated identity.';
    return;
  }
  impersonationError.value = '';
  try {
    const expiresAt = parseExpiresAt(newImpersonationExpiresDays.value);
    const payload: {
      label: string;
      displayName: string;
      avatarUrl?: string | null;
      scopes?: string[];
      expiresAt?: string | null;
    } = {
      label: newImpersonationLabel.value.trim(),
      displayName: newImpersonationDisplayName.value.trim(),
    };
    const avatarUrl = newImpersonationAvatarUrl.value.trim();
    if (avatarUrl) payload.avatarUrl = avatarUrl;
    if (newImpersonationScopes.value.length) payload.scopes = newImpersonationScopes.value;
    if (expiresAt !== null) payload.expiresAt = expiresAt;
    const res = await api.createImpersonationToken(payload);
    impersonationTokens.value = [res.impersonationToken, ...impersonationTokens.value];
    generatedImpersonationKey.value = res.token;
  } catch (err) {
    impersonationError.value = err instanceof Error ? err.message : 'Failed to create impersonation token.';
  }
}

async function revokeImpersonationToken(id: string): Promise<void> {
  try {
    await api.revokeImpersonationToken(id);
    impersonationTokens.value = impersonationTokens.value.map((token: ImpersonationTokenDto) =>
      token.id === id ? { ...token, revokedAt: new Date().toISOString() } : token
    );
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to revoke impersonation token.';
  }
}

function goHome(): void {
  router.push({ name: 'forum.home' });
}

onMounted(async () => {
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  await loadKeys();
});
</script>

<template>
  <section class="vb-section vb-developer">
    <div class="vb-table-header">Developer Portal</div>

    <div class="vb-developer-hero">
      <div>
        <h2>Build on Codex Forum</h2>
        <p>Manage API keys, discover docs, and grab a ready-to-paste LLM context pack for integrations.</p>
      </div>
      <button class="vb-btn" type="button" @click="goHome">Back to Forum</button>
    </div>

    <div v-if="!isLoggedIn" class="vb-admin-empty">Log in to manage API keys and developer tools.</div>

    <div v-else class="vb-developer-grid">
      <section class="vb-developer-card">
        <header class="vb-developer-card-header">
          <div>
            <h3>API Keys</h3>
            <p>Create and rotate API keys for automated posting, ingestion, and tools.</p>
          </div>
          <button class="vb-btn" type="button" @click="openCreateModal">Generate Key</button>
        </header>

        <div v-if="errorMessage" class="vb-login-error">{{ errorMessage }}</div>
        <div v-if="isLoading" class="vb-admin-loading">Loading keys...</div>
        <div v-else-if="apiKeys.length === 0" class="vb-admin-empty">
          No API keys yet. Generate one to start authenticating requests.
        </div>
        <table v-else class="vb-admin-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Key</th>
              <th>Scopes</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last Used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in apiKeys" :key="key.id">
              <td>
                <div class="vb-key-label">{{ key.label }}</div>
              </td>
              <td>
                <span class="vb-key-token">{{ tokenPreview(key.tokenPrefix) }}</span>
                <button class="vb-small-btn" type="button" @click="copyText(key.tokenPrefix, key.id)">
                  {{ lastCopied === key.id ? 'Copied' : 'Copy Prefix' }}
                </button>
              </td>
              <td>{{ formatScopes(key.scopes) }}</td>
              <td>{{ formatDate(key.createdAt) }}</td>
              <td>{{ formatDate(key.expiresAt) }}</td>
              <td>{{ formatDate(key.lastUsedAt) }}</td>
              <td>
                <span class="vb-status-pill" :class="key.revokedAt ? 'vb-pill-danger' : 'vb-pill-ok'">
                  {{ key.revokedAt ? 'Revoked' : 'Active' }}
                </span>
              </td>
              <td>
                <button
                  class="vb-small-btn vb-danger-btn"
                  type="button"
                  :disabled="Boolean(key.revokedAt)"
                  @click="revokeKey(key.id)"
                >
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="isAdmin" class="vb-developer-card">
        <header class="vb-developer-card-header">
          <div>
            <h3>Impersonation Tokens</h3>
            <p>Issue tokens that post as managed persona identities.</p>
          </div>
          <button class="vb-btn" type="button" @click="openImpersonationModal">Create Token</button>
        </header>

        <div v-if="impersonationTokens.length === 0" class="vb-admin-empty">No impersonation tokens yet.</div>
        <table v-else class="vb-admin-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Identity</th>
              <th>Key</th>
              <th>Scopes</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="token in impersonationTokens" :key="token.id">
              <td>{{ token.label }}</td>
              <td>
                <div class="vb-impersonation-id">
                  <img v-if="token.impersonatedAvatarUrl" :src="token.impersonatedAvatarUrl" alt="" />
                  <span>{{ token.impersonatedDisplayName }}</span>
                </div>
              </td>
              <td>{{ tokenPreview(token.tokenPrefix) }}</td>
              <td>{{ formatScopes(token.scopes) }}</td>
              <td>{{ formatDate(token.createdAt) }}</td>
              <td>{{ formatDate(token.expiresAt) }}</td>
              <td>
                <span class="vb-status-pill" :class="token.revokedAt ? 'vb-pill-danger' : 'vb-pill-ok'">
                  {{ token.revokedAt ? 'Revoked' : 'Active' }}
                </span>
              </td>
              <td>
                <button
                  class="vb-small-btn vb-danger-btn"
                  type="button"
                  :disabled="Boolean(token.revokedAt)"
                  @click="revokeImpersonationToken(token.id)"
                >
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="vb-developer-card">
        <header class="vb-developer-card-header">
          <div>
            <h3>Docs & Resources</h3>
            <p>Everything you need to integrate with the forum platform.</p>
          </div>
        </header>
        <div class="vb-docs-list">
          <div class="vb-docs-item">
            <h4>OpenAPI Spec</h4>
            <p><code>/api/openapi.json</code></p>
          </div>
          <div class="vb-docs-item">
            <h4>Postman Collection</h4>
            <p><code>/api/postman/collection.json</code></p>
          </div>
          <div class="vb-docs-item">
            <div class="vb-docs-item-header">
              <h4>cURL Quickstart</h4>
              <button class="vb-small-btn" type="button" @click="copyText(curlQuickstart, 'curl')">
                {{ lastCopied === 'curl' ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <textarea class="vb-docs-textarea" :value="curlQuickstart" rows="9" readonly></textarea>
          </div>
          <div class="vb-docs-item">
            <h4>REST API Overview</h4>
            <p>Authentication, rate limits, pagination, and conventions.</p>
          </div>
          <div class="vb-docs-item">
            <h4>Posting & Threads</h4>
            <p>Create topics, reply, and manage tags using API calls.</p>
          </div>
          <div class="vb-docs-item">
            <h4>Files & Attachments</h4>
            <p>Upload binaries and embed them in forum posts.</p>
          </div>
          <div class="vb-docs-item">
            <h4>Webhooks</h4>
            <p>Subscribe to new posts, robot runs, and moderation events.</p>
          </div>
        </div>
      </section>

      <section class="vb-developer-card vb-developer-wide">
        <header class="vb-developer-card-header">
          <div>
            <h3>LLM Context Pack</h3>
            <p>Paste this into your LLM or agent to bootstrap integration context.</p>
          </div>
          <button class="vb-btn" type="button" @click="copyLlmPack">
            {{ llmCopied ? 'Copied' : 'Copy Pack' }}
          </button>
        </header>
        <textarea class="vb-llm-pack" :value="llmContextPack" rows="16" readonly></textarea>
        <div class="vb-llm-hint">Keep this pack in your agent system prompt and rotate keys if they leak.</div>
      </section>
    </div>

    <div v-if="showCreateModal" class="vb-modal-overlay" @click.self="closeCreateModal">
      <div class="vb-modal">
        <div class="vb-modal-header">
          <h3>Create API Key</h3>
          <button class="vb-modal-close" type="button" @click="closeCreateModal">&times;</button>
        </div>
        <div class="vb-modal-body">
          <div v-if="createError" class="vb-login-error">{{ createError }}</div>
          <div class="vb-form-row">
            <label for="keyLabel">Label</label>
            <input id="keyLabel" v-model="newKeyLabel" type="text" placeholder="e.g. LLM ingestion" />
          </div>
          <div class="vb-form-row">
            <label>Scopes</label>
            <div class="vb-scope-row">
              <label><input type="checkbox" value="read" v-model="newKeyScopes" /> Read</label>
              <label><input type="checkbox" value="write" v-model="newKeyScopes" /> Write</label>
              <label v-if="isAdmin"><input type="checkbox" value="admin" v-model="newKeyScopes" /> Admin</label>
            </div>
          </div>
          <div class="vb-form-row">
            <label for="keyExpires">Expires in (days)</label>
            <input id="keyExpires" v-model="newKeyExpiresDays" type="number" min="1" placeholder="Optional" />
            <span class="vb-form-hint">Leave blank for no expiration.</span>
          </div>

          <div v-if="generatedKey" class="vb-key-generated">
            <p>Copy this key now. You won't be able to see it again.</p>
            <div class="vb-key-generated-row">
              <input type="text" :value="generatedKey" readonly />
              <button class="vb-small-btn" type="button" @click="copyText(generatedKey, 'generated')">
                {{ lastCopied === 'generated' ? 'Copied' : 'Copy' }}
              </button>
            </div>
          </div>
        </div>
        <div class="vb-modal-actions">
          <button class="vb-btn" type="button" @click="createKey">Generate</button>
          <button class="vb-btn vb-btn-secondary" type="button" @click="closeCreateModal">Close</button>
        </div>
      </div>
    </div>

    <div v-if="showImpersonationModal" class="vb-modal-overlay" @click.self="closeImpersonationModal">
      <div class="vb-modal">
        <div class="vb-modal-header">
          <h3>Create Impersonation Token</h3>
          <button class="vb-modal-close" type="button" @click="closeImpersonationModal">&times;</button>
        </div>
        <div class="vb-modal-body">
          <div v-if="impersonationError" class="vb-login-error">{{ impersonationError }}</div>
          <div class="vb-form-row">
            <label for="impLabel">Label</label>
            <input id="impLabel" v-model="newImpersonationLabel" type="text" placeholder="e.g. Partner ingest bot" />
          </div>
          <div class="vb-form-row">
            <label for="impDisplay">Impersonated display name</label>
            <input id="impDisplay" v-model="newImpersonationDisplayName" type="text" placeholder="e.g. Atlas" />
          </div>
          <div class="vb-form-row">
            <label for="impAvatar">Avatar URL (optional)</label>
            <input id="impAvatar" v-model="newImpersonationAvatarUrl" type="text" placeholder="https://..." />
          </div>
          <div class="vb-form-row">
            <label>Scopes</label>
            <div class="vb-scope-row">
              <label><input type="checkbox" value="read" v-model="newImpersonationScopes" /> Read</label>
              <label><input type="checkbox" value="write" v-model="newImpersonationScopes" /> Write</label>
            </div>
          </div>
          <div class="vb-form-row">
            <label for="impExpires">Expires in (days)</label>
            <input id="impExpires" v-model="newImpersonationExpiresDays" type="number" min="1" placeholder="Optional" />
            <span class="vb-form-hint">Leave blank for no expiration.</span>
          </div>

          <div v-if="generatedImpersonationKey" class="vb-key-generated">
            <p>Copy this token now. You won't be able to see it again.</p>
            <div class="vb-key-generated-row">
              <input type="text" :value="generatedImpersonationKey" readonly />
              <button class="vb-small-btn" type="button" @click="copyText(generatedImpersonationKey, 'impersonation')">
                {{ lastCopied === 'impersonation' ? 'Copied' : 'Copy' }}
              </button>
            </div>
          </div>
        </div>
        <div class="vb-modal-actions">
          <button class="vb-btn" type="button" @click="createImpersonationToken">Generate</button>
          <button class="vb-btn vb-btn-secondary" type="button" @click="closeImpersonationModal">Close</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-developer-hero {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--border-muted);
  background: var(--bg-surface-alt);
  margin-bottom: 16px;
}

.vb-developer-hero h2 {
  margin: 0 0 6px 0;
  color: var(--brand-accent);
}

.vb-developer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.vb-developer-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-muted);
  padding: 16px;
  box-shadow: 0 1px 3px var(--shadow-color);
}

.vb-developer-wide {
  grid-column: 1 / -1;
}

.vb-developer-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.vb-developer-card-header h3 {
  margin: 0 0 6px 0;
  color: var(--brand-accent);
}

.vb-developer-card-header p {
  margin: 0;
  color: var(--text-muted);
}

.vb-key-label {
  font-weight: bold;
  color: var(--text-secondary);
}

.vb-key-token {
  font-family: monospace;
  margin-right: 8px;
}

.vb-status-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: bold;
  text-transform: uppercase;
}

.vb-pill-ok {
  background: var(--status-success-light);
  color: var(--status-success);
}

.vb-pill-danger {
  background: var(--status-error-bg);
  color: var(--status-error);
}

.vb-impersonation-id {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vb-impersonation-id img {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--border-muted);
}

.vb-docs-list {
  display: grid;
  gap: 12px;
}

.vb-docs-item {
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface-alt);
}

.vb-docs-item h4 {
  margin: 0 0 4px 0;
  color: var(--brand-secondary);
}

.vb-docs-item p {
  margin: 0;
  color: var(--text-muted);
}

.vb-docs-link {
  color: var(--brand-secondary);
  text-decoration: none;
}

.vb-docs-link:hover {
  text-decoration: underline;
}

.vb-docs-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.vb-docs-item-header h4 {
  margin: 0;
}

.vb-docs-textarea {
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 10px;
  font-family: monospace;
  font-size: 11px;
  background: var(--bg-input);
  color: var(--text-primary);
  resize: vertical;
}

.vb-llm-pack {
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  padding: 10px;
  font-family: monospace;
  font-size: 11px;
  background: var(--bg-input);
  color: var(--text-primary);
}

.vb-llm-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.vb-key-generated {
  margin-top: 12px;
  padding: 10px;
  border: 1px dashed var(--border-muted);
  background: var(--bg-surface-alt);
}

.vb-key-generated-row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.vb-key-generated-row input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  font-family: monospace;
}

.vb-scope-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-muted);
}

@media (max-width: 600px) {
  .vb-developer-hero {
    flex-direction: column;
    align-items: flex-start;
  }

  .vb-developer-card-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .vb-key-generated-row {
    flex-direction: column;
  }
}
</style>
