<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type SecretMetadataDto } from '../lib/apiClient';

const items = ref<SecretMetadataDto[]>([]);
const name = ref('');
const value = ref('');
const tags = ref('');
const expiresAt = ref('');
const editingId = ref<string | null>(null);
const error = ref('');
const load = async () => { try { items.value = (await api.listSecrets()).items; } catch (e) { error.value = String(e); } };
const create = async () => {
  error.value = '';
  try {
    const input = { name: name.value, value: value.value, tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean), expiresAt: expiresAt.value ? new Date(expiresAt.value).toISOString() : null };
    if (editingId.value) await api.replaceSecret(editingId.value, input); else await api.createSecret(input);
    editingId.value = null; name.value = ''; value.value = ''; tags.value = ''; expiresAt.value = ''; await load();
  } catch (e) { error.value = String(e); }
};
const disable = async (id: string) => { await api.disableSecret(id); await load(); };
const remove = async (id: string) => { await api.deleteSecret(id); await load(); };
onMounted(load);
</script>
<template>
  <main class="content-page">
    <h1>Secrets</h1>
    <p>Values are encrypted by agentd and are never shown after saving.</p>
    <form @submit.prevent="create">
      <input v-model="name" required placeholder="Name" />
      <input v-model="value" required type="password" placeholder="Secret value" autocomplete="new-password" />
      <input v-model="tags" placeholder="Tags (comma separated)" />
      <input v-model="expiresAt" type="datetime-local" aria-label="Expiration" />
      <button type="submit">{{ editingId ? 'Replace secret' : 'Create secret' }}</button>
      <button v-if="editingId" type="button" @click="editingId = null; name = ''; value = ''; tags = ''; expiresAt = ''">Cancel</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <ul><li v-for="secret in items" :key="secret.id"><strong>{{ secret.name }}</strong> · {{ secret.tags.join(', ') || 'untagged' }} · {{ secret.enabled ? 'enabled' : 'disabled' }} <button v-if="secret.enabled" @click="disable(secret.id)">Disable</button> <button @click="editingId = secret.id; name = secret.name; tags = secret.tags.join(', '); value = ''">Replace</button> <button @click="remove(secret.id)">Delete</button></li></ul>
  </main>
</template>
