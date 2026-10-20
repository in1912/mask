<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const users = ref([]);
const err = ref('');
const form = ref({ username: '', password: '', role: 'user', display_name: '' });
const adding = ref(false);
const me = ref(null);

async function load() {
  const out = await api('/users');
  users.value = out.users;
}
async function add() {
  err.value = ''; adding.value = true;
  try {
    await api('/users', { method: 'POST', body: form.value });
    form.value = { username: '', password: '', role: 'user', display_name: '' };
    load();
  } catch (e) { err.value = e.message; }
  adding.value = false;
}
async function resetPw(u) {
  const pw = prompt(`为 ${u.username} 设置新密码（至少 6 位）：`);
  if (pw === null) return;
  try { await api('/users/' + u.id, { method: 'PUT', body: { password: pw } }); alert('已重置'); }
  catch (e) { alert(e.message); }
}
async function toggleStatus(u) {
  await api('/users/' + u.id, { method: 'PUT', body: { status: u.status === 'active' ? 'disabled' : 'active' } });
  load();
}
async function unlock(u) {
  await api('/users/' + u.id, { method: 'PUT', body: { unlock: true } });
  load();
}
async function del(u) {
  if (!confirm(`删除用户 ${u.username}？其会话、对照表与历史将一并删除。`)) return;
  try { await api('/users/' + u.id, { method: 'DELETE' }); load(); } catch (e) { alert(e.message); }
}

onMounted(async () => {
  const meOut = await api('/auth/me');
  me.value = meOut.user;
  load();
});
</script>

<template>
  <div style="max-width:860px">
    <div class="page-title">用户管理</div>
    <div class="card" style="margin-bottom:14px">
      <h3 style="font-size:14px;margin-bottom:10px">新建用户</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input v-model="form.username" placeholder="用户名（2-32 位字母数字）" style="width:200px" />
        <input v-model="form.display_name" placeholder="中文名称（可选）" style="width:160px" />
        <input v-model="form.password" type="password" placeholder="密码（至少 6 位）" style="width:180px" />
        <select v-model="form.role"><option value="user">普通用户</option><option value="admin">管理员</option></select>
        <button class="btn primary" :disabled="adding" @click="add">创建</button>
      </div>
      <p v-if="err" class="err" style="margin-top:8px">{{ err }}</p>
    </div>
    <div class="card tbl-scroll">
      <table class="tbl">
        <thead><tr><th>ID</th><th>用户名</th><th>中文名称</th><th>角色</th><th>状态</th><th>最近登录</th><th style="width:230px">操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.id }}</td>
            <td>{{ u.username }}</td>
            <td>{{ u.display_name || '—' }}</td>
            <td><span class="tag" :class="u.role === 'admin' ? '' : 'ok'">{{ u.role === 'admin' ? '管理员' : '用户' }}</span></td>
            <td>
              <span v-if="u.locked_permanent" class="tag danger">永久锁定</span>
              <span v-else class="tag" :class="u.status === 'active' ? 'ok' : 'warn'">{{ u.status === 'active' ? '正常' : '停用' }}</span>
            </td>
            <td class="mut">{{ u.last_login_at || '—' }}</td>
            <td>
              <button class="btn sm" @click="resetPw(u)">重置密码</button>
              <button class="btn sm" style="margin-left:4px" @click="toggleStatus(u)">{{ u.status === 'active' ? '停用' : '启用' }}</button>
              <button v-if="u.locked_permanent" class="btn sm" style="margin-left:4px" @click="unlock(u)">解锁</button>
              <button v-if="u.id !== me?.id" class="btn sm danger" style="margin-left:4px" @click="del(u)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
