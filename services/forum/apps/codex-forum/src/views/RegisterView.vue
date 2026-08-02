<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useForumState } from '../composables/useForumState';

const route = useRoute();
const router = useRouter();
const state = useForumState();

const displayName = ref('');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const inviteCode = ref('');
const isSubmitting = ref(false);
const errorMessage = ref('');
const successData = ref<{ verifyUrl: string; expiresAt: string } | null>(null);
const inviteValid = ref<boolean | null>(null);
const inviteChecking = ref(false);

const registrationClosed = computed(() => !state.registrationSettingsLoading.value && !state.canShowRegisterLink.value);
const registrationRequiresInvite = computed(() => state.canInviteRegister.value && !state.canPublicRegister.value);
const registrationAllowsPublic = computed(() => state.canPublicRegister.value);

// Show credential fields when invite code is valid
const showCredentialFields = computed(() => inviteValid.value === true && state.passwordLoginEnabled.value);

async function checkInviteCode(): Promise<void> {
  if (!inviteCode.value.trim()) {
    inviteValid.value = null;
    return;
  }
  inviteChecking.value = true;
  try {
    const result = await state.checkInviteCode(inviteCode.value.trim());
    inviteValid.value = result;
  } catch {
    inviteValid.value = false;
  }
  inviteChecking.value = false;
}

async function handleSubmit(): Promise<void> {
  errorMessage.value = '';

  if (!displayName.value.trim()) {
    errorMessage.value = 'Please enter a display name.';
    return;
  }

  if (displayName.value.trim().length < 2) {
    errorMessage.value = 'Display name must be at least 2 characters.';
    return;
  }

  if (registrationClosed.value) {
    errorMessage.value = 'Registration is currently closed.';
    return;
  }

  if (registrationRequiresInvite.value && showCredentialFields.value !== true) {
    errorMessage.value = 'Please enter a valid invite code.';
    return;
  }

  // If invite is valid, require username and password
  if (showCredentialFields.value) {
    if (!username.value.trim()) {
      errorMessage.value = 'Please enter a username.';
      return;
    }
    if (username.value.trim().length < 3) {
      errorMessage.value = 'Username must be at least 3 characters.';
      return;
    }
    if (!password.value) {
      errorMessage.value = 'Please enter a password.';
      return;
    }
    if (password.value.length < 8) {
      errorMessage.value = 'Password must be at least 8 characters.';
      return;
    }
    if (password.value !== confirmPassword.value) {
      errorMessage.value = 'Passwords do not match.';
      return;
    }
  }

  isSubmitting.value = true;
  try {
    const result = await state.register(
      displayName.value.trim(),
      inviteCode.value.trim() || undefined,
      showCredentialFields.value ? username.value.trim() : undefined,
      showCredentialFields.value ? password.value : undefined
    );

    // Invite registration creates a cookie session and logs in directly.
    if (showCredentialFields.value) {
      await router.push({ name: 'forum.home' });
      return;
    }

    // Otherwise show the verification URL
    if (!result.verifyUrl || !result.expiresAt) {
      errorMessage.value = 'Registration succeeded, but verification details were missing.';
      return;
    }
    successData.value = {
      verifyUrl: result.verifyUrl,
      expiresAt: result.expiresAt
    };
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('409') || err.message.toLowerCase().includes('taken')) {
        errorMessage.value = 'This display name or username is already taken. Please choose another.';
      } else if (err.message.toLowerCase().includes('username') || err.message.toLowerCase().includes('password')) {
        errorMessage.value = err.message;
      } else if (err.message.includes('403') || err.message.toLowerCase().includes('registration disabled')) {
        errorMessage.value = 'Registration is currently closed.';
      } else if (err.message.includes('400') || err.message.toLowerCase().includes('invite')) {
        errorMessage.value = 'Invalid invite code.';
      } else {
        errorMessage.value = err.message;
      }
    } else {
      errorMessage.value = 'Registration failed. Please try again.';
    }
  }
  isSubmitting.value = false;
}

function goHome(): void {
  router.push({ name: 'forum.home' });
}

onMounted(() => {
  const code = route.query['invite'];
  if (typeof code === 'string' && code) {
    inviteCode.value = code;
    void checkInviteCode();
  }
});
</script>

<template>
  <section class="vb-section">
    <div class="vb-table-header">User Registration</div>

    <div v-if="successData" class="vb-register-success">
      <div class="vb-success-message">
        <h3>Registration Successful</h3>
        <p>Your account has been created. To complete registration, visit the verification link below:</p>
        <div class="vb-verify-link">
          <a :href="successData.verifyUrl">{{ successData.verifyUrl }}</a>
        </div>
        <p class="vb-expiry-note">
          This link expires at {{ new Date(successData.expiresAt).toLocaleString() }}
        </p>
        <div class="vb-modal-actions">
          <button class="vb-btn" @click="goHome">Return to Forum</button>
        </div>
      </div>
    </div>

    <div v-else-if="state.registrationSettingsLoading.value" class="vb-register-form">
      Loading registration settings...
    </div>

    <div v-else-if="registrationClosed" class="vb-register-form">
      <div class="vb-success-message">
        <h3>Registration Closed</h3>
        <p>Public account registration is currently closed. If you already have an account, use the Log In button in the header.</p>
        <div class="vb-modal-actions">
          <button class="vb-btn" @click="goHome">Return to Forum</button>
        </div>
      </div>
    </div>

    <div v-else class="vb-register-form">
      <div v-if="errorMessage" class="vb-login-error">{{ errorMessage }}</div>

      <div v-if="registrationRequiresInvite" class="vb-register-note vb-register-note-top">
        Registration is invite-only. Enter a valid invite code to create an account.
      </div>
      <div v-else-if="registrationAllowsPublic" class="vb-register-note vb-register-note-top">
        <template v-if="state.canInviteRegister.value">
          You can register with an invite code, or continue without one to create a passwordless account using a verification link.
        </template>
        <template v-else>
          Continue without an invite to verify your account, then enroll your first passkey.
        </template>
      </div>

      <div class="vb-form-row">
        <label for="displayName">Display Name:</label>
        <input
          id="displayName"
          v-model="displayName"
          type="text"
          maxlength="50"
          placeholder="Enter your display name"
          @keyup.enter="handleSubmit"
        />
        <span class="vb-form-hint">Minimum 3 characters</span>
      </div>

      <div v-if="state.canInviteRegister.value" class="vb-form-row">
        <label for="inviteCode">Invite Code:</label>
        <div class="vb-input-with-status">
          <input
            id="inviteCode"
            v-model="inviteCode"
            type="text"
            placeholder="Enter your invite code"
            @blur="checkInviteCode"
            @input="checkInviteCode"
          />
          <span v-if="inviteChecking" class="vb-invite-status vb-checking">Checking...</span>
          <span v-else-if="inviteValid === true" class="vb-invite-status vb-valid">Valid</span>
          <span v-else-if="inviteValid === false" class="vb-invite-status vb-invalid">Invalid</span>
        </div>
        <span class="vb-form-hint">{{ registrationRequiresInvite ? 'Required to create an account' : 'Optional; invite registration creates a password login' }}</span>
      </div>

      <template v-if="showCredentialFields">
        <div class="vb-form-row">
          <label for="username">Username:</label>
          <input
            id="username"
            v-model="username"
            type="text"
            maxlength="50"
            placeholder="Choose a username for login"
            autocomplete="username"
          />
          <span class="vb-form-hint">Used to log in (can differ from display name)</span>
        </div>

        <div class="vb-form-row">
          <label for="password">Password:</label>
          <input
            id="password"
            v-model="password"
            type="password"
            placeholder="Choose a password"
            autocomplete="new-password"
          />
          <span class="vb-form-hint">Minimum 8 characters</span>
        </div>

        <div class="vb-form-row">
          <label for="confirmPassword">Confirm Password:</label>
          <input
            id="confirmPassword"
            v-model="confirmPassword"
            type="password"
            placeholder="Confirm your password"
            autocomplete="new-password"
            @keyup.enter="handleSubmit"
          />
        </div>
      </template>

      <div class="vb-modal-actions">
        <button class="vb-btn" :disabled="isSubmitting" @click="handleSubmit">
          {{ isSubmitting ? 'Registering...' : 'Register' }}
        </button>
        <button class="vb-btn vb-btn-secondary" @click="goHome">Cancel</button>
      </div>

      <div class="vb-register-note">
        Already have an account? Use the Log In button in the header.
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-register-form,
.vb-register-success {
  background: var(--bg-surface-alt);
  padding: 24px;
  border: 1px solid var(--border-muted);
  max-width: 500px;
  margin: 0 auto;
  animation: fade-in 0.3s ease-out;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
  20%, 40%, 60%, 80% { transform: translateX(4px); }
}

@keyframes success-bounce {
  0% { transform: scale(0.8); opacity: 0; }
  50% { transform: scale(1.05); }
  100% { transform: scale(1); opacity: 1; }
}

.vb-form-row {
  margin-bottom: 20px;
}

.vb-form-row label {
  display: block;
  font-weight: bold;
  margin-bottom: 6px;
  color: var(--brand-accent);
}

.vb-form-row input {
  width: 100%;
  max-width: 400px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  font-size: 13px;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.vb-form-row input:focus {
  outline: none;
  border-color: var(--brand-secondary);
  box-shadow: 0 0 0 3px rgba(92, 112, 153, 0.2);
}

.vb-form-hint {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.vb-input-with-status {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.vb-input-with-status input {
  flex: 1;
  min-width: 200px;
}

.vb-invite-status {
  font-size: 12px;
  font-weight: bold;
  padding: 4px 8px;
  border-radius: 3px;
  transition: all 0.2s ease;
}

.vb-invite-status.vb-checking {
  color: var(--text-muted);
  background: var(--bg-surface-muted);
}

.vb-invite-status.vb-valid {
  color: var(--status-success);
  background: var(--status-success-bg);
  animation: fade-in 0.2s ease-out;
}

.vb-invite-status.vb-invalid {
  color: var(--status-error);
  background: var(--status-error-bg);
  animation: shake 0.4s ease-in-out;
}

.vb-success-message {
  text-align: center;
  animation: success-bounce 0.4s ease-out;
}

.vb-success-message h3 {
  color: var(--status-success);
  margin: 0 0 16px;
  font-size: 20px;
}

.vb-verify-link {
  background: var(--bg-surface);
  border: 1px solid var(--brand-secondary);
  padding: 16px;
  margin: 20px 0;
  word-break: break-all;
  border-radius: 4px;
  box-shadow: 0 2px 8px var(--shadow-color);
}

.vb-verify-link a {
  color: var(--brand-primary-light);
  text-decoration: underline;
  font-weight: bold;
}

.vb-verify-link a:hover {
  color: var(--brand-primary);
}

.vb-expiry-note {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 12px;
}

.vb-register-note {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

/* Error animation on the login-error class */
.vb-login-error {
  animation: shake 0.4s ease-in-out;
}

@media (max-width: 600px) {
  .vb-register-form,
  .vb-register-success {
    padding: 16px;
    margin: 0;
  }

  .vb-input-with-status {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
