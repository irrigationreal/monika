<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, setAuthToken, setRefreshToken } from '../lib/apiClient';
import { useForumState } from '../composables/useForumState';

const route = useRoute();
const router = useRouter();
const state = useForumState();

const subject = computed(() => (route.query['subject'] as string | undefined) ?? '');
const issuer = computed(() => (route.query['issuer'] as string | undefined) ?? undefined);
const providerKey = computed(() => (route.query['providerKey'] as string | undefined) ?? undefined);

const username = ref('');
const password = ref('');
const isSubmitting = ref(false);
const errorMessage = ref('');

onMounted(async () => {
  // If you're already logged in, you should use the "Link SSO" button in Profile,
  // but don't hard-block: just send you to Profile.
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  if (state.isLoggedIn.value) {
    await router.replace({ name: 'user.profile' });
    return;
  }
});

async function submit(): Promise<void> {
  errorMessage.value = '';
  if (!subject.value) {
    errorMessage.value = 'Missing OIDC subject. Please restart the SSO flow.';
    return;
  }
  if (!username.value.trim() || !password.value) {
    errorMessage.value = 'Please enter your forum username and password.';
    return;
  }

  isSubmitting.value = true;
  try {
    const res = await api.oidcLink({
      username: username.value.trim(),
      password: password.value,
      subject: subject.value,
      issuer: issuer.value,
      providerKey: providerKey.value
    });
    // Store tokens and load current user.
    setAuthToken(res.token);
    setRefreshToken(res.refreshToken ?? null);
    await state.checkAuth();
    await router.replace({ name: 'forum.home' });
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to link account.';
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<template>
  <section class="vb-section">
    <div class="vb-table-header">Link SSO to Forum Account</div>

    <div class="vb-profile-content">
      <div v-if="errorMessage" class="vb-login-error">{{ errorMessage }}</div>

      <p class="vb-hint">
        Your SSO identity isn’t linked to a forum account yet. Enter your existing forum username and password to link
        them.
      </p>

      <div class="vb-form-row">
        <label>Username</label>
        <input v-model="username" type="text" autocomplete="username" @keyup.enter="submit" />
      </div>

      <div class="vb-form-row">
        <label>Password</label>
        <input v-model="password" type="password" autocomplete="current-password" @keyup.enter="submit" />
      </div>

      <div class="vb-form-actions">
        <button class="vb-btn" type="button" :disabled="isSubmitting" @click="submit">
          {{ isSubmitting ? 'Linking…' : 'Link Account' }}
        </button>
        <button class="vb-btn vb-btn-secondary" type="button" :disabled="isSubmitting" @click="router.push({ name: 'forum.home' })">
          Cancel
        </button>
      </div>
    </div>
  </section>
</template>

