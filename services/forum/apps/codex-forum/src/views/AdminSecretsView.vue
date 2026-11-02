<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type SecretMetadataDto } from '../lib/apiClient';
const items = ref<SecretMetadataDto[]>([]);
const error = ref('');
const editingId = ref<string | null>(null);
const name = ref('');
const value = ref('');
const tags = ref('');
const expiresAt = ref('');
async function load(): Promise<void> {
  try { items.value = (await api.listAdminSecrets()).items; } catch (e) { error.value = String(e); }
}
function edit(secret: SecretMetadataDto): void {
  editingId.value = secret.id; name.value = secret.name; tags.value = secret.tags.join(', '); value.value = ''; expiresAt.value = secret.expiresAt ?? '';
}
async function replace(): Promise<void> {
  if (!editingId.value || !value.value) return;
  try {
    await api.replaceAdminSecret(editingId.value, { name: name.value, value: value.value, tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean), expiresAt: expiresAt.value || null });
    editingId.value = null; value.value = ''; await load();
  } catch (e) { error.value = String(e); }
}
async function disable(id: string): Promise<void> { try { await api.disableAdminSecret(id); await load(); } catch (e) { error.value = String(e); } }
async function remove(id: string): Promise<void> { try { await api.deleteAdminSecret(id); await load(); } catch (e) { error.value = String(e); } }
onMounted(load);
</script>
<template>
  <main class="content-page">
    <h1>Secret metadata</h1>
    <p>Administrators can manage all secret records. Values are write-only and encrypted by agentd; they are never returned.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <form v-if="editingId" @submit.prevent="replace">
      <input v-model="name" required placeholder="Name" />
      <input v-model="value" required type="password" placeholder="Replacement value" autocomplete="new-password" />
      <input v-model="tags" placeholder="Tags (comma separated)" />
      <input v-model="expiresAt" type="datetime-local" aria-label="Expiration" />
      <button type="submit">Replace secret</button>
      <button type="button" @click="editingId = null">Cancel</button>
    </form>
    <ul>
      <li v-for="secret in items" :key="secret.id">
        {{ secret.name }} · owner {{ secret.ownerIdentityId }} · {{ secret.enabled ? 'enabled' : 'disabled' }} · {{ secret.tags.join(', ') || 'untagged' }}
        <span v-if="secret.expiresAt"> · expires {{ secret.expiresAt }}</span>
        <button type="button" @click="edit(secret)">Replace</button>
        <button v-if="secret.enabled" type="button" @click="disable(secret.id)">Disable</button>
        <button type="button" @click="remove(secret.id)">Delete</button>
      </li>
    </ul>
  </main>
</template>
