<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import VMonikaLogo from './components/VMonikaLogo.vue';
import { useForumState } from './composables/useForumState';
import { useTheme } from './composables/useTheme';
import { themeLabel } from './themes/forumThemes';

const apiBaseUrl = '/api';
const route = useRoute();
const router = useRouter();
const state = useForumState();
const { theme, resolvedTone, cycleTheme, initTheme } = useTheme();

const loginUsername = ref('');
const loginPassword = ref('');
const loginError = ref('');
const loggingIn = ref(false);
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

  if (route.name === 'user.files') {
    crumbs.push({ label: 'User Control Panel', to: { name: 'user.profile' } });
    crumbs.push({ label: 'File Storage' });
  }

  if (route.name === 'admin') {
    crumbs.push({ label: 'Admin Panel' });
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
    state.closeLoginModal();
    loginUsername.value = '';
    loginPassword.value = '';
  } else {
    loginError.value = 'Invalid credentials';
  }
}

async function handleLogout(): Promise<void> {
  await state.logout();
}

function openLoginForm(): void {
  state.openLoginModal();
  loginError.value = '';
}

function closeLoginForm(): void {
  state.closeLoginModal();
  loginUsername.value = '';
  loginPassword.value = '';
  loginError.value = '';
}

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
          <div class="vb-welcome-links">
            <router-link v-if="state.isLoggedIn.value" :to="{ name: 'user.profile' }">User CP</router-link>
            <router-link v-if="state.isLoggedIn.value" :to="{ name: 'user.files' }">Files</router-link>
            <router-link v-if="state.isLoggedIn.value" :to="{ name: 'chat.home' }">Chat</router-link>
            <router-link v-if="state.isLoggedIn.value" :to="{ name: 'developer.portal' }">Developers</router-link>
            <router-link v-if="state.isLoggedIn.value" :to="{ name: 'api.docs' }">API Docs</router-link>
            <router-link v-if="isAdmin" :to="{ name: 'admin' }">Admin</router-link>
            <template v-if="state.isLoggedIn.value">
              <button class="vb-link-btn" type="button" @click="handleLogout">Log Out</button>
            </template>
            <template v-else>
              <router-link v-if="state.canShowRegisterLink.value" :to="{ name: 'auth.register' }">Register</router-link>
              <button class="vb-link-btn" type="button" @click="openLoginForm">Log In</button>
            </template>
            <button class="vb-theme-toggle" type="button" @click="cycleTheme" :title="`Theme: ${themeLabel(theme)}`">
              <span v-if="resolvedTone === 'light'">&#9728;</span>
              <span v-else>&#9790;</span>
            </button>
          </div>
        </div>
      </header>

      <div v-if="state.showLoginModal.value" class="vb-modal-overlay" @click.self="closeLoginForm">
        <div class="vb-modal">
          <div class="vb-modal-header">
            <span>Log In</span>
            <button class="vb-modal-close" type="button" @click="closeLoginForm">&times;</button>
          </div>
          <div class="vb-modal-body">
            <div v-if="loginError" class="vb-login-error">{{ loginError }}</div>
            <label>Username:</label>
            <input v-model="loginUsername" type="text" @keyup.enter="handleLogin" />
            <label>Password:</label>
            <input v-model="loginPassword" type="password" @keyup.enter="handleLogin" />
            <div class="vb-login-hint" style="margin-top: 10px">
              <a class="vb-link" :href="`${apiBaseUrl}/auth/oidc/start`">Sign in with SSO</a>
            </div>
            <div class="vb-modal-actions">
              <button class="vb-btn" :disabled="loggingIn" @click="handleLogin">Log In</button>
              <button class="vb-btn vb-btn-secondary" @click="closeLoginForm">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <nav class="vb-nav">
        <button class="vb-nav-hamburger" type="button" aria-label="Toggle menu" @click="toggleMobileMenu">
          <span class="vb-hamburger-line"></span>
          <span class="vb-hamburger-line"></span>
          <span class="vb-hamburger-line"></span>
        </button>
        <div class="vb-nav-items" :class="{ 'vb-nav-open': mobileMenuOpen }">
          <router-link class="vb-nav-item" :to="{ name: 'forum.home' }" @click="closeMobileMenu"
            >Forum Home</router-link
          >
          <router-link
            v-if="state.isLoggedIn.value"
            class="vb-nav-item"
            :to="{ name: 'user.profile' }"
            @click="closeMobileMenu"
            >Profile</router-link
          >
          <router-link
            v-if="state.isLoggedIn.value"
            class="vb-nav-item"
            :to="{ name: 'user.files' }"
            @click="closeMobileMenu"
            >Files</router-link
          >
          <router-link
            v-if="state.isLoggedIn.value"
            class="vb-nav-item"
            :to="{ name: 'chat.home' }"
            @click="closeMobileMenu"
            >Chat</router-link
          >
          <router-link
            v-if="state.isLoggedIn.value"
            class="vb-nav-item"
            :to="{ name: 'developer.portal' }"
            @click="closeMobileMenu"
            >Developers</router-link
          >
          <router-link
            v-if="state.isLoggedIn.value"
            class="vb-nav-item"
            :to="{ name: 'api.docs' }"
            @click="closeMobileMenu"
            >API Docs</router-link
          >
          <router-link v-if="isAdmin" class="vb-nav-item" :to="{ name: 'admin' }" @click="closeMobileMenu"
            >Admin</router-link
          >
          <router-link
            v-if="!state.isLoggedIn.value && state.canShowRegisterLink.value"
            class="vb-nav-item"
            :to="{ name: 'auth.register' }"
            @click="closeMobileMenu"
            >Register</router-link
          >
          <button
            v-if="!state.isLoggedIn.value"
            class="vb-nav-item"
            type="button"
            @click="
              closeMobileMenu();
              openLoginForm();
            "
          >
            Log In
          </button>
          <button
            v-if="state.isLoggedIn.value"
            class="vb-nav-item"
            type="button"
            @click="
              closeMobileMenu();
              handleLogout();
            "
          >
            Log Out
          </button>
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
