<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { startRegistration } from '@simplewebauthn/browser';

import { useForumState } from '../composables/useForumState';
import { useMarkdown } from '../composables/useMarkdown';
import { useTheme } from '../composables/useTheme';
import { api } from '../lib/apiClient';
import { FORUM_THEMES, FORUM_THEME_BY_KEY } from '../themes/forumThemes';

import type { ForumThemeKey } from '@irrigationreal/codex-forum-contracts';

import type { ForumThemeDefinition } from '../themes/forumThemes';

const router = useRouter();
const state = useForumState();
const { renderBBCode } = useMarkdown();
const { setTheme } = useTheme();

const editMode = ref(false);
const displayName = ref('');
const location = ref('');
const signature = ref('');
const privateEmail = ref('');
const clearPrivateEmail = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmNewPassword = ref('');
const isSaving = ref(false);
const errorMessage = ref('');
const successMessage = ref('');
const isUploading = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
const selectedFile = ref<File | null>(null);
const selectedFilePreview = ref<string | null>(null);
const selectedTheme = ref<ForumThemeKey>('vmonika');
const originalTheme = ref<ForumThemeKey>('vmonika');
const passkeyName = ref('My passkey');
const passkeys = ref<{ id: string; name: string; deviceType: string }[]>([]);

const themeGroups = computed(() => {
  const groups = new Map<string, ForumThemeDefinition[]>();
  for (const theme of FORUM_THEMES) {
    const bucket = groups.get(theme.era) ?? [];
    bucket.push(theme);
    groups.set(theme.era, bucket);
  }
  return Array.from(groups.entries()).map(([era, themes]) => ({ era, themes }));
});

const selectedThemeInfo = computed(() => FORUM_THEME_BY_KEY[selectedTheme.value]);

function triggerFileInput(): void {
  fileInputRef.value?.click();
}

function handleFileSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  if (!file) {
    selectedFile.value = null;
    selectedFilePreview.value = null;
    return;
  }

  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    errorMessage.value = 'Invalid file type. Please upload a JPEG, PNG, GIF, or WebP image.';
    selectedFile.value = null;
    selectedFilePreview.value = null;
    return;
  }

  // Validate file size (max 10MB)
  if (file.size > 10 * 1024 * 1024) {
    errorMessage.value = 'File too large. Maximum size is 10MB.';
    selectedFile.value = null;
    selectedFilePreview.value = null;
    return;
  }

  selectedFile.value = file;
  errorMessage.value = '';

  // Create preview URL
  const reader = new FileReader();
  reader.onload = (e) => {
    selectedFilePreview.value = e.target?.result as string;
  };
  reader.readAsDataURL(file);
}

async function uploadAvatar(): Promise<void> {
  if (!selectedFile.value || !currentUser.value) return;

  isUploading.value = true;
  errorMessage.value = '';
  successMessage.value = '';

  try {
    const result = await api.uploadAvatar(currentUser.value.id, selectedFile.value);

    // Update the current user's avatar in the state
    await state.checkAuth();

    successMessage.value = result.message;
    selectedFile.value = null;
    selectedFilePreview.value = null;

    // Clear file input
    if (fileInputRef.value) {
      fileInputRef.value.value = '';
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to upload avatar.';
  } finally {
    isUploading.value = false;
  }
}

function cancelFileSelect(): void {
  selectedFile.value = null;
  selectedFilePreview.value = null;
  if (fileInputRef.value) {
    fileInputRef.value.value = '';
  }
}

const currentUser = computed(() => state.currentUser.value);
const signaturePreview = computed(() => {
  if (!currentUser.value?.signature) return '';
  return renderBBCode(currentUser.value.signature);
});

function startEdit(): void {
  if (!currentUser.value) return;
  displayName.value = currentUser.value.displayName;
  location.value = currentUser.value.location || '';
  signature.value = currentUser.value.signature || '';
  privateEmail.value = '';
  clearPrivateEmail.value = false;
  selectedTheme.value = currentUser.value.theme ?? 'vmonika';
  originalTheme.value = selectedTheme.value;
  editMode.value = true;
  errorMessage.value = '';
  successMessage.value = '';
}

function cancelEdit(): void {
  editMode.value = false;
  errorMessage.value = '';
  setTheme(originalTheme.value);
}

function isValidPrivateEmail(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true; // empty is allowed (interpreted as "no change")
  if (trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes('.');
}

async function loadPasskeys(): Promise<void> {
  if (!currentUser.value) return;
  try {
    const result = await api.listWebauthnCredentials();
    passkeys.value = result.items;
  } catch {
    passkeys.value = [];
  }
}

async function enrollPasskey(): Promise<void> {
  errorMessage.value = '';
  try {
    const ceremony = await api.webauthnRegistrationOptions();
    const response = await startRegistration({ optionsJSON: ceremony.options as never });
    await api.webauthnRegistrationVerify({
      challengeId: ceremony.challengeId,
      name: passkeyName.value,
      response: response as unknown as Record<string, unknown>,
    });
    successMessage.value = 'Passkey added.';
    await loadPasskeys();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to add passkey.';
  }
}

async function removePasskey(id: string): Promise<void> {
  errorMessage.value = '';
  try {
    await api.removeWebauthnCredential(id);
    successMessage.value = 'Passkey removed.';
    await loadPasskeys();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to remove passkey.';
  }
}

async function removePassword(): Promise<void> {
  errorMessage.value = '';
  try {
    await api.removePassword();
    await state.checkAuth();
    successMessage.value = 'Password login removed from this account.';
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to remove password.';
  }
}

async function createPassword(): Promise<void> {
  errorMessage.value = '';
  if (newPassword.value.length < 8 || newPassword.value !== confirmNewPassword.value) {
    errorMessage.value = 'Passwords must match and be at least 8 characters.';
    return;
  }
  try {
    await api.createPassword(newPassword.value);
    await state.checkAuth();
    successMessage.value = 'Password login enabled for this account.';
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to create password.';
  }
}

async function changePassword(): Promise<void> {
  if (!currentUser.value) return;
  errorMessage.value = '';
  successMessage.value = '';

  if (!currentPassword.value || !newPassword.value) {
    errorMessage.value = 'Please enter your current password and a new password.';
    return;
  }
  if (newPassword.value.length < 8) {
    errorMessage.value = 'New password must be at least 8 characters.';
    return;
  }
  if (newPassword.value !== confirmNewPassword.value) {
    errorMessage.value = 'New password and confirmation do not match.';
    return;
  }

  isSaving.value = true;
  try {
    await api.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value });
    currentPassword.value = '';
    newPassword.value = '';
    confirmNewPassword.value = '';
    successMessage.value = 'Password updated successfully.';
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to update password.';
  } finally {
    isSaving.value = false;
  }
}

async function saveProfile(): Promise<void> {
  if (!currentUser.value) return;

  errorMessage.value = '';
  successMessage.value = '';

  if (!displayName.value.trim()) {
    errorMessage.value = 'Display name cannot be empty.';
    return;
  }

  if (displayName.value.trim().length < 2) {
    errorMessage.value = 'Display name must be at least 2 characters.';
    return;
  }

  if (signature.value.trim().length > 500) {
    errorMessage.value = 'Signature must be 500 characters or fewer.';
    return;
  }

  if (!clearPrivateEmail.value && !isValidPrivateEmail(privateEmail.value)) {
    errorMessage.value = 'Please enter a valid email address (or leave it blank).';
    return;
  }

  isSaving.value = true;
  try {
    await state.updateProfile(currentUser.value.id, {
      displayName: displayName.value.trim(),
      location: location.value.trim() || null,
      signature: signature.value.trim() || null,
      theme: selectedTheme.value,
    });

    if (clearPrivateEmail.value) {
      await state.updatePrivateEmail(null);
    } else if (privateEmail.value.trim()) {
      await state.updatePrivateEmail(privateEmail.value.trim());
    }

    successMessage.value = 'Profile updated successfully.';
    editMode.value = false;
    originalTheme.value = selectedTheme.value;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('409') || err.message.toLowerCase().includes('taken')) {
        errorMessage.value = 'This display name is already taken.';
      } else {
        errorMessage.value = err.message;
      }
    } else {
      errorMessage.value = 'Failed to update profile.';
    }
  }
  isSaving.value = false;
}

watch(
  () => selectedTheme.value,
  (next) => {
    if (editMode.value) {
      setTheme(next);
    }
  }
);

function goHome(): void {
  router.push({ name: 'forum.home' });
}

onMounted(async () => {
  if (!state.authChecked.value) {
    await state.checkAuth();
  }
  if (!state.isLoggedIn.value) {
    router.push({ name: 'forum.home' });
  }

  await loadPasskeys();
});
</script>

<template>
  <section class="vb-section">
    <div class="vb-table-header">User Control Panel</div>

    <div v-if="!currentUser" class="vb-profile-content">
      <p>You must be logged in to view your profile.</p>
      <div class="vb-modal-actions">
        <button class="vb-btn" @click="goHome">Return to Forum</button>
      </div>
    </div>

    <div v-else class="vb-profile-content">
      <div v-if="successMessage" class="vb-success-banner">{{ successMessage }}</div>
      <div v-if="errorMessage" class="vb-login-error">{{ errorMessage }}</div>

      <div class="vb-profile-card">
        <div class="vb-profile-avatar">
          <img
            :src="selectedFilePreview || currentUser.avatarUrl || '/avatars/user.svg'"
            alt="Avatar"
            class="vb-avatar-large"
          />
          <input
            ref="fileInputRef"
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            class="vb-file-input-hidden"
            @change="handleFileSelect"
          />
          <div class="vb-avatar-actions">
            <button
              v-if="!selectedFile"
              class="vb-small-btn vb-avatar-upload-btn"
              type="button"
              :disabled="isUploading"
              @click="triggerFileInput"
            >
              Change Avatar
            </button>
            <template v-else>
              <button
                class="vb-small-btn vb-avatar-confirm-btn"
                type="button"
                :disabled="isUploading"
                @click="uploadAvatar"
              >
                <span v-if="isUploading" class="vb-btn-spinner"></span>
                {{ isUploading ? 'Uploading...' : 'Upload' }}
              </button>
              <button
                class="vb-small-btn vb-btn-secondary"
                type="button"
                :disabled="isUploading"
                @click="cancelFileSelect"
              >
                Cancel
              </button>
            </template>
          </div>
          <div v-if="selectedFile" class="vb-avatar-file-info">
            {{ selectedFile.name }} ({{ Math.round(selectedFile.size / 1024) }}KB)
          </div>
        </div>

        <div class="vb-profile-info">
          <template v-if="!editMode">
            <div class="vb-profile-row">
              <span class="vb-profile-label">Display Name:</span>
              <span class="vb-profile-value">{{ currentUser.displayName }}</span>
            </div>
            <div class="vb-profile-row">
              <span class="vb-profile-label">Account Type:</span>
              <span class="vb-profile-value">{{ currentUser.kind }}</span>
            </div>
            <div class="vb-profile-row">
              <span class="vb-profile-label">Location:</span>
              <span class="vb-profile-value">{{ currentUser.location || 'Not set' }}</span>
            </div>
            <div class="vb-profile-row">
              <span class="vb-profile-label">Robot Email:</span>
              <span class="vb-profile-value">
                {{ currentUser.hasPrivateEmail ? 'Set (hidden)' : 'Not set' }}
              </span>
            </div>
            <div class="vb-profile-row vb-signature-row">
              <span class="vb-profile-label">Signature:</span>
              <span
                v-if="currentUser.signature"
                class="vb-profile-value vb-signature-value vb-rendered-content"
                v-html="signaturePreview"
              ></span>
              <span v-else class="vb-profile-value vb-signature-value">Not set</span>
            </div>
            <div class="vb-profile-row">
              <span class="vb-profile-label">Theme:</span>
              <span class="vb-profile-value">{{ FORUM_THEME_BY_KEY[currentUser.theme ?? 'vmonika']?.label }}</span>
            </div>
            <div class="vb-modal-actions">
              <button class="vb-btn" @click="startEdit">Edit Profile</button>
              <router-link class="vb-btn vb-btn-secondary" :to="{ name: 'user.messageTemplates' }"
                >Message Templates</router-link
              >
              <router-link class="vb-btn vb-btn-secondary" :to="{ name: 'user.drafts' }">My Drafts</router-link>
              <button class="vb-btn vb-btn-secondary" @click="goHome">Back to Forum</button>
            </div>
          </template>

          <template v-else>
            <div class="vb-form-row">
              <label for="editDisplayName">Display Name:</label>
              <input
                id="editDisplayName"
                v-model="displayName"
                type="text"
                maxlength="50"
                placeholder="Enter your display name"
              />
              <span class="vb-form-hint">Minimum 2 characters.</span>
            </div>
            <div class="vb-form-row">
              <label for="editLocation">Location:</label>
              <input
                id="editLocation"
                v-model="location"
                type="text"
                maxlength="100"
                placeholder="e.g. New York, USA"
              />
              <span class="vb-form-hint">Shown on your posts. Optional.</span>
            </div>
            <div class="vb-form-row">
              <label for="editSignature">Signature:</label>
              <textarea
                id="editSignature"
                v-model="signature"
                rows="3"
                maxlength="500"
                placeholder="Your signature appears at the bottom of your posts..."
              ></textarea>
              <span class="vb-form-hint">{{ signature.length }}/500 characters. BBCode allowed.</span>
            </div>
            <div class="vb-form-row">
              <label for="editTheme">Forum Theme:</label>
              <select id="editTheme" v-model="selectedTheme">
                <template v-for="group in themeGroups" :key="group.era">
                  <optgroup :label="group.era">
                    <option v-for="theme in group.themes" :key="theme.key" :value="theme.key">
                      {{ theme.label }}
                    </option>
                  </optgroup>
                </template>
              </select>
              <span class="vb-form-hint">{{ selectedThemeInfo?.description }}</span>
              <span class="vb-form-hint">Live preview: picking a theme applies instantly while you browse.</span>
            </div>
            <div class="vb-form-row">
              <label for="editPrivateEmail">Robot-only email address:</label>
              <input
                id="editPrivateEmail"
                v-model="privateEmail"
                type="email"
                maxlength="254"
                :disabled="clearPrivateEmail"
                placeholder="Enter an email to set/replace (value is never shown after save)"
              />
              <div class="vb-form-hint">
                Status:
                <strong>{{ currentUser.hasPrivateEmail ? 'set (hidden)' : 'not set' }}</strong
                >. This email is not displayed publicly and is reserved for robot workflows (e.g., internal
                attribution).
              </div>
              <label class="vb-checkbox-row">
                <input v-model="clearPrivateEmail" type="checkbox" />
                Clear robot-only email
              </label>
            </div>
            <div class="vb-modal-actions">
              <button class="vb-btn" :disabled="isSaving || !displayName.trim()" @click="saveProfile">
                <span v-if="isSaving" class="vb-btn-spinner"></span>
                {{ isSaving ? 'Saving...' : 'Save Changes' }}
              </button>
              <button class="vb-btn vb-btn-secondary" @click="cancelEdit">Cancel</button>
            </div>
          </template>
        </div>
      </div>

      <div v-if="currentUser" class="vb-card" style="margin-top: 12px">
        <div class="vb-card-header">Passkeys</div>
        <div class="vb-card-body">
          <p class="vb-hint">Passkeys are discoverable credentials protected by device user verification.</p>
          <ul v-if="passkeys.length" style="margin: 8px 0 8px 18px">
            <li v-for="credential in passkeys" :key="credential.id">
              <strong>{{ credential.name }}</strong> — {{ credential.deviceType }}
              <button class="vb-btn vb-btn-secondary" type="button" @click="removePasskey(credential.id)">
                Remove
              </button>
            </li>
          </ul>
          <div v-else class="vb-hint">No passkeys enrolled.</div>
          <div class="vb-form-field" style="margin-top: 10px">
            <label for="passkey-name">Passkey name</label>
            <input
              id="passkey-name"
              v-model="passkeyName"
              class="vb-text-input"
              name="passkeyName"
              type="text"
              autocomplete="off"
              placeholder="e.g. MacBook Pro"
            />
          </div>
          <div class="vb-form-actions" style="margin-top: 10px">
            <button class="vb-btn" type="button" @click="enrollPasskey">Add passkey</button>
            <button
              v-if="currentUser.hasPassword && passkeys.length"
              class="vb-btn vb-btn-secondary"
              type="button"
              @click="removePassword"
            >
              Remove password
            </button>
          </div>
          <form
            v-if="!currentUser.hasPassword && state.passwordLoginEnabled.value"
            autocomplete="on"
            @submit.prevent="createPassword"
          >
            <div v-if="currentUser.username" class="vb-form-field" style="margin-top: 10px">
              <label for="create-password-username">Account username</label>
              <input
                id="create-password-username"
                :value="currentUser.username"
                class="vb-text-input"
                name="username"
                type="text"
                autocomplete="username"
                readonly
              />
            </div>
            <div class="vb-form-field" style="margin-top: 10px">
              <label for="create-password">New password</label>
              <input
                id="create-password"
                v-model="newPassword"
                class="vb-text-input"
                name="newPassword"
                type="password"
                autocomplete="new-password"
              />
            </div>
            <div class="vb-form-field" style="margin-top: 10px">
              <label for="confirm-created-password">Confirm password</label>
              <input
                id="confirm-created-password"
                v-model="confirmNewPassword"
                class="vb-text-input"
                name="confirmPassword"
                type="password"
                autocomplete="new-password"
              />
            </div>
            <div class="vb-form-actions" style="margin-top: 10px">
              <button class="vb-btn" type="submit">Create password</button>
            </div>
          </form>
        </div>
      </div>
      <div v-if="currentUser?.hasPassword && state.passwordLoginEnabled.value" class="vb-card" style="margin-top: 12px">
        <div class="vb-card-header">Change Password</div>
        <form class="vb-card-body" autocomplete="on" @submit.prevent="changePassword">
          <div v-if="currentUser.username" class="vb-form-row">
            <label for="change-password-username">Account username</label>
            <input
              id="change-password-username"
              :value="currentUser.username"
              class="vb-text-input"
              name="username"
              type="text"
              autocomplete="username"
              readonly
            />
          </div>
          <div class="vb-form-row">
            <label for="current-password">Current password</label>
            <input
              id="current-password"
              v-model="currentPassword"
              class="vb-text-input"
              name="currentPassword"
              type="password"
              autocomplete="current-password"
            />
          </div>
          <div class="vb-form-row">
            <label for="new-password">New password</label>
            <input
              id="new-password"
              v-model="newPassword"
              class="vb-text-input"
              name="newPassword"
              type="password"
              autocomplete="new-password"
            />
          </div>
          <div class="vb-form-row">
            <label for="confirm-new-password">Confirm new password</label>
            <input
              id="confirm-new-password"
              v-model="confirmNewPassword"
              class="vb-text-input"
              name="confirmNewPassword"
              type="password"
              autocomplete="new-password"
            />
          </div>
          <div class="vb-form-actions">
            <button class="vb-btn" :disabled="isSaving" type="submit">Update Password</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.vb-profile-content {
  background: var(--bg-surface-alt);
  padding: 20px;
  border: 1px solid var(--border-muted);
  animation: fade-in 0.3s ease-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.vb-profile-card {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  background: var(--bg-surface);
  padding: 20px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
}

.vb-profile-avatar {
  flex-shrink: 0;
}

.vb-avatar-large {
  width: 120px;
  height: 120px;
  border: 2px solid var(--brand-secondary);
  border-radius: 4px;
  object-fit: cover;
  box-shadow: 0 2px 8px var(--shadow-color);
}

.vb-profile-info {
  flex: 1;
}

.vb-profile-row {
  margin-bottom: 14px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.vb-profile-row:last-of-type {
  border-bottom: none;
}

.vb-signature-row {
  flex-direction: column;
  align-items: flex-start;
}

.vb-signature-value {
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.vb-profile-label {
  display: inline-block;
  font-weight: bold;
  width: 130px;
  color: var(--brand-accent);
}

.vb-profile-value {
  color: var(--text-secondary);
}

.vb-form-row {
  margin-bottom: 20px;
}

.vb-form-row label {
  display: block;
  font-weight: bold;
  margin-bottom: 6px;
  color: var(--text-primary);
}

.vb-form-row input:not([type='checkbox']):not([type='radio']),
.vb-form-row select {
  width: 100%;
  max-width: 400px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  font-size: 13px;
  background: var(--bg-input);
  color: var(--text-primary);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.vb-form-row input:not([type='checkbox']):not([type='radio']):focus,
.vb-form-row select:focus,
.vb-form-row textarea:focus {
  outline: none;
  border-color: var(--brand-secondary);
  box-shadow: 0 0 0 3px rgba(92, 112, 153, 0.2);
}

.vb-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.vb-checkbox-row input[type='checkbox'] {
  /* Prevent generic form input styles from making the checkbox huge / pushing the label text away. */
  width: auto;
  max-width: none;
  padding: 0;
  margin: 0;
}

.vb-form-row textarea {
  width: 100%;
  max-width: 400px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  min-height: 80px;
  background: var(--bg-input);
  color: var(--text-primary);
}

.vb-form-hint {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.vb-avatar-input-group {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.vb-avatar-input-group input {
  flex: 1;
  min-width: 200px;
}

.vb-avatar-preview-container {
  flex-shrink: 0;
}

.vb-avatar-preview-label {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.vb-avatar-preview {
  width: 60px;
  height: 60px;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  object-fit: cover;
  animation: fade-in 0.2s ease-out;
}

.vb-avatar-preview-error {
  width: 60px;
  height: 60px;
  border: 1px dashed var(--status-error);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: var(--status-error);
  text-align: center;
  padding: 4px;
  background: var(--status-error-bg);
}

.vb-btn-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--text-inverse);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 6px;
  vertical-align: middle;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.vb-success-banner {
  background: linear-gradient(var(--status-success-bg), var(--status-success-light));
  border: 1px solid var(--status-success);
  color: var(--status-success);
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: fade-in 0.3s ease-out;
}

.vb-success-banner::before {
  content: '\2713';
  font-weight: bold;
  font-size: 14px;
}

@media (max-width: 600px) {
  .vb-profile-card {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .vb-profile-label {
    display: block;
    width: auto;
    margin-bottom: 4px;
  }

  .vb-avatar-input-group {
    flex-direction: column;
    align-items: stretch;
  }
}

/* Avatar upload styles */
.vb-file-input-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.vb-avatar-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

.vb-avatar-upload-btn {
  background: linear-gradient(var(--grad-nav-start), var(--grad-nav-end));
  font-size: 11px;
  padding: 6px 12px;
}

.vb-avatar-upload-btn:hover:not(:disabled) {
  background: linear-gradient(var(--grad-btn-hover-start), var(--grad-btn-hover-end));
}

.vb-avatar-confirm-btn {
  background: linear-gradient(var(--status-success), var(--grad-success-end));
  border-color: var(--status-success);
}

.vb-avatar-confirm-btn:hover:not(:disabled) {
  background: linear-gradient(var(--grad-success-start), var(--status-success));
}

.vb-avatar-file-info {
  margin-top: 8px;
  font-size: 10px;
  color: var(--text-muted);
  text-align: center;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vb-profile-avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
}
</style>
