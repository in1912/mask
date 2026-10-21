import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import './style.css';
import App from './App.vue';
import Login from './views/Login.vue';
import Chat from './views/Chat.vue';
import Files from './views/Files.vue';
import Batch from './views/Batch.vue';
import Agent from './views/Agent.vue';
import Engines from './views/Engines.vue';
import History from './views/History.vue';
import About from './views/About.vue';
import Users from './views/Users.vue';
import Settings from './views/Settings.vue';
import { token } from './api.js';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: Login },
    { path: '/', component: Chat },
    { path: '/files', component: Files },
    { path: '/batch', component: Batch },
    { path: '/agents', component: Agent },
    { path: '/rules', redirect: '/engines' },   // v1.03：规则配置迁入「脱敏引擎」页签，旧链接不落空
    { path: '/engines', component: Engines },
    { path: '/history', component: History },
    { path: '/about', component: About },
    { path: '/users', component: Users },
    { path: '/settings', component: Settings },
    { path: '/:x(.*)', redirect: '/' }
  ]
});

router.beforeEach((to) => {
  if (to.path !== '/login' && !token()) return '/login';
  if (to.path === '/login' && token()) return '/';
});

createApp(App).use(router).mount('#app');
