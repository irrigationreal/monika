import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import ForumHomeView from '../views/ForumHomeView.vue';
import ForumIndexView from '../views/ForumIndexView.vue';
import NewThreadView from '../views/NewThreadView.vue';
import ReplyView from '../views/ReplyView.vue';
import TopicView from '../views/TopicView.vue';
import RegisterView from '../views/RegisterView.vue';
import VerifyView from '../views/VerifyView.vue';
import ProfileView from '../views/ProfileView.vue';
import OidcLinkView from '../views/OidcLinkView.vue';
import UserProfileView from '../views/UserProfileView.vue';
import UserFilesView from '../views/UserFilesView.vue';
import AdminView from '../views/AdminView.vue';
import RobotDashboardView from '../views/RobotDashboardView.vue';
import DeveloperPortalView from '../views/DeveloperPortalView.vue';
import ChatView from '../views/ChatView.vue';
import ApiDocsView from '../views/ApiDocsView.vue';

const SITE_NAME = 'vMonika';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'forum.home', component: ForumHomeView, meta: { title: 'Forum Home' } },
  { path: '/forums/:forumId', name: 'forum.view', component: ForumIndexView, meta: { title: 'Forum' } },
  { path: '/forums/:forumId/newthread', name: 'forum.newthread', component: NewThreadView, meta: { title: 'New Thread' } },
  { path: '/topics/:topicId/reply', name: 'topic.reply', component: ReplyView, meta: { title: 'Post Reply' } },
  { path: '/topics/:topicId', name: 'topic.view', component: TopicView, meta: { title: 'Topic' } },
  { path: '/topics/:topicId/state', name: 'topic.state', component: TopicView, meta: { title: 'Topic State' } },
  { path: '/sessions/:sessionId', name: 'session.inspect', component: TopicView, meta: { title: 'Session Inspector' } },
  { path: '/register', name: 'auth.register', component: RegisterView, meta: { title: 'Register' } },
  { path: '/verify/:token', name: 'auth.verify', component: VerifyView, meta: { title: 'Verify Account' } },
  { path: '/profile', name: 'user.profile', component: ProfileView, meta: { title: 'User Control Panel' } },
  { path: '/oidc/link', name: 'auth.oidc.link', component: OidcLinkView, meta: { title: 'Link SSO' } },
  { path: '/chat', name: 'chat.home', component: ChatView, meta: { title: 'Chat Rooms' } },
  { path: '/chat/:roomId', name: 'chat.room', component: ChatView, meta: { title: 'Chat Room' } },
  { path: '/users/:identityId', name: 'user.view', component: UserProfileView, meta: { title: 'User Profile' } },
  { path: '/files', name: 'user.files', component: UserFilesView, meta: { title: 'File Storage' } },
  { path: '/admin', name: 'admin', component: AdminView, meta: { title: 'Admin Panel' } },
  { path: '/admin/robot-dashboard', name: 'admin.robotDashboard', component: RobotDashboardView, meta: { title: 'Robot Dashboard' } },
  { path: '/developers', name: 'developer.portal', component: DeveloperPortalView, meta: { title: 'Developer Portal' } },
  { path: '/docs/api', name: 'api.docs', component: ApiDocsView, meta: { title: 'API Docs' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', redirect: '/' }
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
  }
});

router.afterEach((to) => {
  const pageTitle = to.meta['title'] as string | undefined;
  document.title = pageTitle ? `${pageTitle} - ${SITE_NAME}` : SITE_NAME;
});
