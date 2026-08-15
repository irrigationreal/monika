import { createRouter, createWebHistory } from 'vue-router';

import { useForumState } from '../composables/useForumState';
import AdminView from '../views/AdminView.vue';
import AnalyticsView from '../views/AnalyticsView.vue';
import ApiDocsView from '../views/ApiDocsView.vue';
import ChatView from '../views/ChatView.vue';
import DeveloperPortalView from '../views/DeveloperPortalView.vue';
import DraftsView from '../views/DraftsView.vue';
import ForumHomeView from '../views/ForumHomeView.vue';
import ForumIndexView from '../views/ForumIndexView.vue';
import MessageTemplatesView from '../views/MessageTemplatesView.vue';
import NewThreadView from '../views/NewThreadView.vue';
import NotepadView from '../views/NotepadView.vue';
import ProfileView from '../views/ProfileView.vue';
import RegisterView from '../views/RegisterView.vue';
import ReplyView from '../views/ReplyView.vue';
import RobotDashboardView from '../views/RobotDashboardView.vue';
import TopicView from '../views/TopicView.vue';
import UserFilesView from '../views/UserFilesView.vue';
import UserProfileView from '../views/UserProfileView.vue';
import VerifyView from '../views/VerifyView.vue';

import type { RouteRecordRaw } from 'vue-router';

const SITE_NAME = 'vMonika';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'forum.home', component: ForumHomeView, meta: { title: 'Forum Home' } },
  { path: '/forums/:forumId', name: 'forum.view', component: ForumIndexView, meta: { title: 'Forum' } },
  {
    path: '/forums/:forumId/newthread',
    name: 'forum.newthread',
    component: NewThreadView,
    meta: { title: 'New Thread' },
  },
  { path: '/topics/:topicId/reply', name: 'topic.reply', component: ReplyView, meta: { title: 'Post Reply' } },
  { path: '/topics/:topicId', name: 'topic.view', component: TopicView, meta: { title: 'Topic' } },
  { path: '/topics/:topicId/state', name: 'topic.state', component: TopicView, meta: { title: 'Topic State' } },
  { path: '/sessions/:sessionId', name: 'session.inspect', component: TopicView, meta: { title: 'Session Inspector' } },
  { path: '/register', name: 'auth.register', component: RegisterView, meta: { title: 'Register' } },
  { path: '/verify/:token', name: 'auth.verify', component: VerifyView, meta: { title: 'Verify Account' } },
  { path: '/profile', name: 'user.profile', component: ProfileView, meta: { title: 'User Control Panel' } },
  {
    path: '/profile/message-templates',
    name: 'user.messageTemplates',
    component: MessageTemplatesView,
    meta: { title: 'Message Templates', requiresAuth: true },
  },
  {
    path: '/profile/drafts',
    name: 'user.drafts',
    component: DraftsView,
    meta: { title: 'My Drafts', requiresAuth: true },
  },
  { path: '/notepad', name: 'user.notepad', component: NotepadView, meta: { title: 'My Notepad', requiresAuth: true } },
  { path: '/chat', name: 'chat.home', component: ChatView, meta: { title: 'Chat Rooms', requiresAuth: true } },
  { path: '/chat/:roomId', name: 'chat.room', component: ChatView, meta: { title: 'Chat Room', requiresAuth: true } },
  { path: '/users/:identityId', name: 'user.view', component: UserProfileView, meta: { title: 'User Profile' } },
  { path: '/files', name: 'user.files', component: UserFilesView, meta: { title: 'User Files' } },
  { path: '/admin', name: 'admin', component: AdminView, meta: { title: 'Admin Panel', requiresAdmin: true } },
  {
    path: '/admin/analytics',
    name: 'admin.analytics',
    component: AnalyticsView,
    meta: { title: 'Analytics', requiresAdmin: true },
  },
  {
    path: '/admin/robot-dashboard',
    name: 'admin.robotDashboard',
    component: RobotDashboardView,
    meta: { title: 'Robot Dashboard', requiresAdmin: true },
  },
  {
    path: '/developers',
    name: 'developer.portal',
    component: DeveloperPortalView,
    meta: { title: 'Developer Portal', requiresAuth: true },
  },
  { path: '/docs/api', name: 'api.docs', component: ApiDocsView, meta: { title: 'API Docs', requiresAuth: true } },
  { path: '/:pathMatch(.*)*', name: 'not-found', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return savedPosition;
    // If there's a hash, let the view handle it. (In TopicView, posts render async,
    // so we can't rely on the router's built-in element scroll timing.)
    if (to.hash) return false;
    return { left: 0, top: 0 };
  },
});

router.beforeEach(async (to) => {
  const state = useForumState();
  if (!state.authChecked.value) await state.checkAuth();

  const requiresAdmin = Boolean(to.meta['requiresAdmin']);
  const requiresAuth = Boolean(to.meta['requiresAuth']) || requiresAdmin;
  if (!requiresAuth) return true;

  if (!state.isLoggedIn.value) {
    state.openLoginModal();
    return { name: 'forum.home' };
  }
  if (requiresAdmin && state.currentUser.value?.kind !== 'admin') return { name: 'forum.home' };
  return true;
});

router.afterEach((to) => {
  const pageTitle = to.meta['title'] as string | undefined;
  document.title = pageTitle ? `${pageTitle} - ${SITE_NAME}` : SITE_NAME;
});
