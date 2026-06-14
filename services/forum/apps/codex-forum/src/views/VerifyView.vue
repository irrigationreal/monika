<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useForumState } from '../composables/useForumState';

const route = useRoute();
const router = useRouter();
const state = useForumState();

const isVerifying = ref(true);
const errorMessage = ref('');
const successMessage = ref('');

async function verifyToken(): Promise<void> {
  const token = route.params['token'] as string;

  if (!token) {
    errorMessage.value = 'No verification token provided.';
    isVerifying.value = false;
    return;
  }

  try {
    const result = await state.verify(token);
    successMessage.value = `Welcome, ${result.displayName}! Your account has been verified.`;
    // Redirect to home after a brief delay
    setTimeout(() => {
      router.push({ name: 'forum.home' });
    }, 2000);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('404') || err.message.includes('expired')) {
        errorMessage.value = 'This verification link is invalid or has expired.';
      } else if (err.message.includes('400')) {
        errorMessage.value = 'Invalid verification token.';
      } else {
        errorMessage.value = err.message;
      }
    } else {
      errorMessage.value = 'Verification failed. Please try again.';
    }
  }
  isVerifying.value = false;
}

function goHome(): void {
  router.push({ name: 'forum.home' });
}

function goRegister(): void {
  router.push({ name: 'auth.register' });
}

onMounted(() => {
  void verifyToken();
});
</script>

<template>
  <section class="vb-section">
    <div class="vb-table-header">Account Verification</div>

    <div class="vb-verify-content">
      <div v-if="isVerifying" class="vb-verify-loading">
        <p>Verifying your account...</p>
      </div>

      <div v-else-if="successMessage" class="vb-verify-success">
        <h3>Verification Successful</h3>
        <p>{{ successMessage }}</p>
        <p class="vb-redirect-note">Redirecting to the forum...</p>
        <div class="vb-modal-actions">
          <button class="vb-btn" @click="goHome">Go to Forum Now</button>
        </div>
      </div>

      <div v-else-if="errorMessage" class="vb-verify-error">
        <h3>Verification Failed</h3>
        <p class="vb-login-error">{{ errorMessage }}</p>
        <div class="vb-modal-actions">
          <button class="vb-btn" @click="goRegister">Register Again</button>
          <button class="vb-btn vb-btn-secondary" @click="goHome">Return to Forum</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-verify-content {
  background: var(--bg-surface-alt);
  padding: 32px 24px;
  border: 1px solid var(--border-muted);
  text-align: center;
  max-width: 500px;
  margin: 0 auto;
  animation: fade-in 0.3s ease-out;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes success-pop {
  0% { transform: scale(0.8); opacity: 0; }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); opacity: 1; }
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
  20%, 40%, 60%, 80% { transform: translateX(4px); }
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.vb-verify-loading {
  padding: 20px;
}

.vb-verify-loading p {
  font-size: 14px;
  color: var(--text-muted);
  animation: pulse 1.5s ease-in-out infinite;
}

.vb-verify-loading::before {
  content: '';
  display: block;
  width: 40px;
  height: 40px;
  margin: 0 auto 16px;
  border: 3px solid var(--border-default);
  border-top-color: var(--brand-secondary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.vb-verify-success {
  animation: success-pop 0.4s ease-out;
}

.vb-verify-success h3 {
  color: var(--status-success);
  margin: 0 0 16px;
  font-size: 22px;
}

.vb-verify-success h3::before {
  content: '\\2713 ';
  font-weight: bold;
}

.vb-verify-success p {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.vb-verify-error {
  animation: shake 0.4s ease-in-out;
}

.vb-verify-error h3 {
  color: var(--status-error);
  margin: 0 0 16px;
  font-size: 22px;
}

.vb-verify-error h3::before {
  content: '\\2717 ';
  font-weight: bold;
}

.vb-redirect-note {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 16px;
  padding: 10px;
  background: var(--status-success-bg);
  border-radius: 4px;
}

.vb-modal-actions {
  margin-top: 20px;
}

@media (max-width: 600px) {
  .vb-verify-content {
    padding: 24px 16px;
    margin: 0;
  }
}
</style>
