<script setup>
import { ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, token, THEMES, applyTheme } from './api.js';

const route = useRoute();
const router = useRouter();
const user = ref(null);
const theme = ref('dark');

const NAV = [
  { path: '/', icon: 'forum', label: '数据脱敏' },
  { path: '/rules', icon: 'tune', label: '规则配置' },
  { path: '/history', icon: 'history', label: '脱敏历史' },
  { path: '/about', icon: 'science', label: '脱敏原理' },
  { path: '/users', icon: 'manage_accounts', label: '用户管理', admin: true },
  { path: '/settings', icon: 'settings', label: '系统设置', admin: true }
];

const collapsed = ref(localStorage.getItem('mask_nav') === '1');
function toggleNav() {
  if (window.innerWidth <= 860) {
    document.body.classList.toggle('nav-open');
    return;
  }
  collapsed.value = !collapsed.value;
  localStorage.setItem('mask_nav', collapsed.value ? '1' : '0');
  document.body.classList.toggle('nav-collapsed', collapsed.value);
}
function closeDrawer() { document.body.classList.remove('nav-open'); }

async function setTheme(t) {
  theme.value = t;
  applyTheme(t);
  try { if (token()) await api('/auth/theme', { method: 'POST', body: { theme: t } }); } catch { /* 离线也能切 */ }
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  localStorage.removeItem('mask_token');
  closeDrawer();
  router.push('/login');
}

onMounted(async () => {
  document.body.classList.toggle('nav-collapsed', collapsed.value);
  applyTheme(localStorage.getItem('mask_theme') || 'dark');
  if (!token()) return;
  try {
    const me = await api('/auth/me');
    user.value = me.user;
    theme.value = me.theme || 'dark';
    applyTheme(theme.value);
  } catch { /* 401 已跳登录 */ }
});

watch(() => route.path, () => { closeDrawer(); if (route.path === '/login') user.value = null; });
watch(theme, (t) => localStorage.setItem('mask_theme', t));
watch(user, (u) => { if (u && route.path === '/login') router.push('/'); });
</script>

<template>
  <div v-if="route.path === '/login'" class="login-root"><router-view /></div>
  <div v-else class="layout">
    <aside class="sidebar">
      <div class="nav-brand"><span class="material-icons">theater_comedy</span><span class="lbl">面具 · AI 脱敏</span></div>
      <router-link v-for="n in NAV.filter(x => !x.admin || (user && user.role === 'admin'))" :key="n.path" :to="n.path"
        class="nav-item" :class="{ active: route.path === n.path }" :title="n.label">
        <span class="material-icons">{{ n.icon }}</span><span class="lbl">{{ n.label }}</span>
      </router-link>
      <div class="nav-spacer"></div>
      <router-link to="/login" class="nav-item" title="退出登录" @click.prevent="logout">
        <span class="material-icons">logout</span><span class="lbl">退出登录</span>
      </router-link>
    </aside>
    <div class="nav-backdrop" @click="closeDrawer"></div>
    <div class="main-col">
      <header class="topbar">
        <button class="theme-dot hamburger" @click="toggleNav"><span class="material-icons">menu</span></button>
        <b>{{ (NAV.find(x => x.path === route.path) || {}).label || '面具' }}</b>
        <span class="grow"></span>
        <button v-for="t in THEMES" :key="t.id" class="theme-dot" :class="{ on: theme === t.id }" :title="t.label"
          @click="setTheme(t.id)"><span class="material-icons">{{ t.icon }}</span></button>
        <span v-if="user" class="mut" style="margin-left:8px">{{ user.display_name || user.username }}</span>
      </header>
      <main class="page"><router-view /></main>
    </div>
  </div>
</template>

<style>
.login-root { height: 100%; }
</style>
