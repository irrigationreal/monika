<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { startAuthentication } from '@simplewebauthn/browser';

import VMonikaLogo from './components/VMonikaLogo.vue';
import { useForumState } from './composables/useForumState';
import { useTheme } from './composables/useTheme';
import { api } from './lib/apiClient';
import { themeLabel } from './themes/forumThemes';

import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { RouteLocationRaw } from 'vue-router';

const route = useRoute();
const router = useRouter();
const state = useForumState();
const { theme, resolvedTone, cycleTheme, initTheme } = useTheme();

const loginUsername = ref('');
const loginPassword = ref('');
const loginError = ref('');
const loggingIn = ref(false);
const loginDialog = ref<HTMLElement | null>(null);
const loginUsernameInput = ref<HTMLInputElement | null>(null);
const passkeyLoginButton = ref<HTMLButtonElement | null>(null);
const logoutButton = ref<HTMLButtonElement | null>(null);
let loginTrigger: HTMLElement | null = null;
const mobileMenuOpen = ref(false);

const buildCommit = import.meta.env.VITE_BUILD_COMMIT?.trim() ?? '';
const buildSource = import.meta.env.VITE_BUILD_SOURCE?.trim() ?? '';
const commitPattern = /^[0-9a-f]{7,40}$/i;
const buildLabel = buildCommit && commitPattern.test(buildCommit) ? buildCommit.slice(0, 7) : 'local';
const buildHref =
  buildSource && buildCommit && /^[0-9a-f]{40}$/i.test(buildCommit)
    ? `${buildSource.replace(/\/$/, '')}/commit/${buildCommit}`
    : '';

function toggleMobileMenu(): void {
  mobileMenuOpen.value = !mobileMenuOpen.value;
}

function closeMobileMenu(): void {
  mobileMenuOpen.value = false;
}

interface BreadcrumbItem {
  label: string;
  to?: { name: string; params?: Record<string, string> };
}

const breadcrumbs = computed((): BreadcrumbItem[] => {
  const crumbs: BreadcrumbItem[] = [{ label: 'Forum Home', to: { name: 'forum.home' } }];

  const isForumRoute = route.name === 'forum.view' || route.name === 'forum.newthread';
  const isTopicRoute = route.name === 'topic.view' || route.name === 'topic.state' || route.name === 'session.inspect';
  const forumId = isForumRoute
    ? ((route.params['forumId'] as string | undefined) ?? null)
    : isTopicRoute
      ? (state.selectedTopic.value?.forumId ?? null)
      : null;

  if (forumId) {
    const forum = state.forums.value.find((item) => item.id === forumId) ?? null;
    crumbs.push({
      label: forum?.name ?? 'Forum',
      to: { name: 'forum.view', params: { forumId } },
    });
  }

  if (isTopicRoute && state.selectedTopic.value) {
    crumbs.push({ label: state.selectedTopic.value.title });
  }

  if (route.name === 'user.profile') {
    crumbs.push({ label: 'User Control Panel' });
  }

  if (route.name === 'user.messageTemplates') {
    crumbs.push({ label: 'User Control Panel', to: { name: 'user.profile' } });
    crumbs.push({ label: 'Message Templates' });
  }

  if (route.name === 'user.files') {
    crumbs.push({ label: 'User Control Panel', to: { name: 'user.profile' } });
    crumbs.push({ label: 'User Files' });
  }

  if (route.name === 'user.notepad') {
    crumbs.push({ label: 'My Notepad' });
  }

  if (route.name === 'admin') {
    crumbs.push({ label: 'Admin Panel' });
  }

  if (route.name === 'admin.analytics' || route.name === 'admin.robotDashboard') {
    crumbs.push({ label: 'Admin Panel', to: { name: 'admin' } });
    crumbs.push({ label: route.name === 'admin.analytics' ? 'Analytics' : 'Robot Dashboard' });
  }

  if (route.name === 'developer.portal') {
    crumbs.push({ label: 'Developer Portal' });
  }

  if (route.name === 'api.docs') {
    crumbs.push({ label: 'API Docs' });
  }

  return crumbs;
});

const displayName = computed(() => {
  return state.currentUser.value?.displayName ?? 'Guest_User';
});

const isAdmin = computed(() => state.currentUser.value?.kind === 'admin');

interface NavigationLink {
  label: string;
  to: RouteLocationRaw;
}

const accountLinks = computed<NavigationLink[]>(() =>
  state.isLoggedIn.value
    ? [
        { label: 'User CP', to: { name: 'user.profile' } },
        { label: 'Drafts', to: { name: 'user.drafts' } },
        { label: 'Notepad', to: { name: 'user.notepad' } },
        { label: 'Files', to: { name: 'user.files' } },
        { label: 'Message Templates', to: { name: 'user.messageTemplates' } },
      ]
    : []
);

const forumLinks = computed<NavigationLink[]>(() => {
  const links: NavigationLink[] = [{ label: 'Forum Home', to: { name: 'forum.home' } }];
  if (isAdmin.value) {
    links.push(
      { label: 'Admin', to: { name: 'admin' } },
      { label: 'Robot Dashboard', to: { name: 'admin.robotDashboard' } },
      { label: 'Analytics', to: { name: 'admin.analytics' } }
    );
  }
  if (state.isLoggedIn.value) {
    links.push(
      { label: 'Chat', to: { name: 'chat.home' } },
      { label: 'Developers', to: { name: 'developer.portal' } },
      { label: 'API Docs', to: { name: 'api.docs' } }
    );
  }
  return links;
});

async function goHome(): Promise<void> {
  if (route.path !== '/') {
    await router.push({ name: 'forum.home' });
  }
}

async function handleLogin(): Promise<void> {
  if (!loginUsername.value || !loginPassword.value) {
    loginError.value = 'Please enter username and password';
    return;
  }
  loggingIn.value = true;
  loginError.value = '';
  const success = await state.login(loginUsername.value, loginPassword.value);
  loggingIn.value = false;
  if (success) {
    closeLoginForm('logout');
  } else {
    loginError.value = 'Invalid credentials';
  }
}

async function handlePasskeyLogin(): Promise<void> {
  loggingIn.value = true;
  loginError.value = '';
  try {
    const ceremony = await api.webauthnLoginOptions();
    const response = await startAuthentication({
      optionsJSON: ceremony.options as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    await api.webauthnLoginVerify({
      challengeId: ceremony.challengeId,
      response: response as unknown as Record<string, unknown>,
    });
    await state.checkAuth();
    closeLoginForm('logout');
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : 'Passkey login failed';
  } finally {
    loggingIn.value = false;
  }
}

async function handleLogout(): Promise<void> {
  await state.logout();
}

function openLoginForm(): void {
  loginTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.openLoginModal();
  loginError.value = '';
}

function closeLoginForm(restoreFocusTo: 'trigger' | 'logout' = 'trigger'): void {
  state.closeLoginModal();
  loginUsername.value = '';
  loginPassword.value = '';
  loginError.value = '';
  void nextTick(() => (restoreFocusTo === 'logout' ? logoutButton.value : loginTrigger)?.focus());
}

function handleLoginDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLoginForm();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = Array.from(
    loginDialog.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  ).filter((element) => element.offsetParent !== null);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => state.showLoginModal.value,
  async (isOpen) => {
    if (!isOpen) return;
    await nextTick();
    (loginUsernameInput.value ?? passkeyLoginButton.value)?.focus();
  }
);

onMounted(async () => {
  initTheme();
  try {
    await state.checkAuth();
    await state.loadForums();
    await state.loadTopics();
  } catch (err) {
    state.setError(err instanceof Error ? err.message : 'Failed to load forum data.');
  }
});
</script>

<template>
  <div class="vb-body">
    <div class="vb-topbar"></div>

    <div class="vb-shell">
      <header class="vb-header">
        <button class="vb-logo" type="button" aria-label="Go to forum home" @click="goHome">
          <VMonikaLogo aria-hidden="true" />
          <span class="vb-logo-text">ⱱMonika</span>
        </button>
        <div class="vb-welcome">
          <div class="vb-welcome-summary">
            <span class="vb-welcome-main"
              >Welcome, <strong>{{ displayName }}</strong
              >.</span
            >
            <span class="vb-welcome-divider">•</span>
            <span class="vb-welcome-sub">Last visit: {{ new Date().toLocaleString() }}</span>
          </div>
          <nav class="vb-welcome-links" aria-label="Account navigation">
            <router-link v-for="link in accountLinks" :key="link.label" :to="link.to">{{ link.label }}</router-link>
            <template v-if="state.isLoggedIn.value">
              <button ref="logoutButton" class="vb-link-btn" type="button" @click="handleLogout">Log Out</button>
            </template>
            <template v-else>
              <router-link v-if="state.canShowRegisterLink.value" :to="{ name: 'auth.register' }">Register</router-link>
              <button class="vb-link-btn" type="button" @click="openLoginForm">Log In</button>
            </template>
            <button
              class="vb-theme-toggle"
              type="button"
              :aria-label="`Change theme. Current theme: ${themeLabel(theme)}`"
              :title="`Theme: ${themeLabel(theme)}`"
              @click="cycleTheme"
            >
              <span v-if="resolvedTone === 'light'">&#9728;</span>
              <span v-else>&#9790;</span>
            </button>
          </nav>
        </div>
      </header>

      <div v-if="state.showLoginModal.value" class="vb-modal-overlay" @click.self="closeLoginForm()">
        <div
          ref="loginDialog"
          class="vb-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-dialog-title"
          @keydown="handleLoginDialogKeydown"
        >
          <div class="vb-modal-header">
            <span id="login-dialog-title">Log In</span>
            <button class="vb-modal-close" type="button" aria-label="Close login dialog" @click="closeLoginForm()">
              &times;
            </button>
          </div>
          <form class="vb-modal-body" autocomplete="on" @submit.prevent="handleLogin">
            <div v-if="loginError" class="vb-login-error" role="alert">{{ loginError }}</div>
            <template v-if="state.passwordLoginEnabled.value">
              <div class="vb-form-field">
                <label for="login-username">Username:</label>
                <input
                  id="login-username"
                  ref="loginUsernameInput"
                  v-model="loginUsername"
                  class="vb-text-input"
                  name="username"
                  type="text"
                  autocomplete="username"
                />
              </div>
              <div class="vb-form-field">
                <label for="login-password">Password:</label>
                <input
                  id="login-password"
                  v-model="loginPassword"
                  class="vb-text-input"
                  name="password"
                  type="password"
                  autocomplete="current-password"
                />
              </div>
            </template>
            <div class="vb-modal-actions">
              <button v-if="state.passwordLoginEnabled.value" class="vb-btn" :disabled="loggingIn" type="submit">
                Log In
              </button>
              <button
                ref="passkeyLoginButton"
                class="vb-btn"
                :disabled="loggingIn"
                type="button"
                @click="handlePasskeyLogin"
              >
                Sign in with a passkey
              </button>
              <button class="vb-btn vb-btn-secondary" type="button" @click="closeLoginForm()">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <nav class="vb-nav" aria-label="Forum navigation">
        <button
          class="vb-nav-hamburger"
          type="button"
          aria-label="Toggle forum navigation"
          aria-controls="forum-navigation-items"
          :aria-expanded="mobileMenuOpen"
          @click="toggleMobileMenu"
        >
          <span class="vb-hamburger-line"></span>
          <span class="vb-hamburger-line"></span>
          <span class="vb-hamburger-line"></span>
        </button>
        <div id="forum-navigation-items" class="vb-nav-items" :class="{ 'vb-nav-open': mobileMenuOpen }">
          <router-link
            v-for="link in forumLinks"
            :key="link.label"
            class="vb-nav-item"
            :to="link.to"
            @click="closeMobileMenu"
          >
            {{ link.label }}
          </router-link>
        </div>
      </nav>

      <nav class="vb-breadcrumb">
        <span class="vb-breadcrumb-icon">&#9679;</span>
        <span v-for="(crumb, idx) in breadcrumbs" :key="idx" class="vb-breadcrumb-item">
          <span v-if="idx > 0" class="vb-breadcrumb-sep">&gt;</span>
          <router-link v-if="crumb.to && idx < breadcrumbs.length - 1" :to="crumb.to" class="vb-breadcrumb-link">
            {{ crumb.label }}
          </router-link>
          <span v-else class="vb-breadcrumb-current">{{ crumb.label }}</span>
        </span>
      </nav>

      <div v-if="state.error.value" class="vb-banner">{{ state.error.value }}</div>

      <router-view />

      <footer class="vb-footer">
        <div class="vb-footer-bar"></div>
        <div class="vb-footer-links">
          <span>Contact Us</span>
          <span>Archive</span>
          <span>Top</span>
        </div>
        <div class="vb-footer-copy">
          Powered by
          <a class="vb-footer-link" href="https://github.com/irrigationreal/monika" target="_blank" rel="noreferrer"
            >Monika</a
          >
          <span class="vb-footer-build">
            · Build
            <a v-if="buildHref" :href="buildHref" target="_blank" rel="noreferrer">{{ buildLabel }}</a>
            <span v-else>{{ buildLabel }}</span>
          </span>
        </div>
      </footer>
    </div>
  </div>
</template>
