<script setup>
import { ref, onMounted } from 'vue';
import { api, token } from '../api.js';

const username = ref('');
const password = ref('');
const err = ref('');
const busy = ref(false);
const beian = ref('');
const showPw = ref(false);

onMounted(async () => {
  try {
    const info = await fetch('/api/system-info').then((r) => r.json());
    beian.value = info.beian || '';
  } catch { /* 系统信息拿不到也不影响登录 */ }
});

async function submit() {
  if (busy.value) return;
  if (!username.value.trim() || !password.value) { err.value = '请输入账号和密码'; return; }
  busy.value = true; err.value = '';
  try {
    const out = await api('/auth/login', { method: 'POST', body: { username: username.value.trim(), password: password.value } });
    localStorage.setItem('mask_token', out.token);
    location.hash = '#/';
    location.reload();
  } catch (e) { err.value = e.message; }
  busy.value = false;
}
</script>

<template>
  <div class="login-box">
    <div class="login-card">
      <div class="login-logo"><span class="material-icons" style="font-size:40px;color:var(--accent)">theater_comedy</span></div>
      <h1>面具</h1>
      <p class="mut" style="text-align:center;margin-bottom:22px">AI 脱敏系统 · 先脱敏，再上云</p>
      <input v-model="username" placeholder="账号" autocomplete="username" style="width:100%" @keyup.enter="$refs.pw.focus()" />
      <div style="position:relative;margin-top:12px">
        <input ref="pw" v-model="password" :type="showPw ? 'text' : 'password'" placeholder="密码"
          autocomplete="current-password" style="width:100%;padding-right:40px" @keyup.enter="submit" />
        <button style="position:absolute;right:6px;top:5px" class="theme-dot" @click="showPw = !showPw">
          <span class="material-icons">{{ showPw ? 'visibility_off' : 'visibility' }}</span>
        </button>
      </div>
      <p v-if="err" class="err" style="margin:10px 0 0">{{ err }}</p>
      <button class="btn primary" style="width:100%;justify-content:center;margin-top:16px" :disabled="busy" @click="submit">
        {{ busy ? '登录中…' : '登 录' }}
      </button>
    </div>
    <p v-if="beian" class="icp">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">{{ beian }}</a>
    </p>
  </div>
</template>

<style scoped>
.login-box { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; }
.login-card { width: min(92vw, 360px); padding: 34px 30px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
.login-logo { text-align: center; }
h1 { text-align: center; font-size: 26px; margin-top: 6px; }
.icp { font-size: 12px; color: var(--mut); }
.icp a { color: var(--mut); }
</style>
