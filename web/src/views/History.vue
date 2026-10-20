<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(10);
const scope = ref('');
const detail = ref(null);
const reviewOut = ref(null);
const err = ref('');

const SCOPE_ZH = { chat: '对话', preview: '试运行', file: '文件' };

async function load() {
  err.value = '';
  try {
    const q = new URLSearchParams({ page: page.value, size: size.value });
    if (scope.value) q.set('scope', scope.value);
    const out = await api('/history?' + q.toString());
    rows.value = out.rows;
    total.value = out.total;
  } catch (e) { err.value = e.message; }
}
function pages() { return Math.max(1, Math.ceil(total.value / size.value)); }
function flip(p) { if (p >= 1 && p <= pages()) { page.value = p; load(); } }

async function open(id) {
  reviewOut.value = null;
  detail.value = detail.value && detail.value.id === id ? null : await api('/history/' + id);
}
async function del(id) {
  if (!confirm('删除这条历史记录（含对照表快照）？')) return;
  await api('/history/' + id, { method: 'DELETE' });
  if (detail.value && detail.value.id === id) detail.value = null;
  load();
}
async function review(id) {
  reviewOut.value = await api('/history/' + id + '/review', { method: 'POST' });
}

onMounted(load);
</script>

<template>
  <div style="max-width:980px">
    <div class="page-title">脱敏历史</div>
    <div class="card">
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
        <select v-model="scope" @change="page = 1; load()">
          <option value="">全部来源</option>
          <option value="chat">对话</option>
          <option value="preview">试运行</option>
          <option value="file">文件</option>
        </select>
        <span class="mut" style="font-size:12px">来源列「对话」可回查该会话；删除为硬删除</span>
        <span style="flex:1"></span>
        <span class="mut">{{ total }} 条</span>
      </div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>时间</th><th>来源</th><th>用户</th><th>项数</th><th style="width:150px">操作</th></tr></thead>
          <tbody>
            <template v-for="r in rows" :key="r.id">
              <tr @click="open(r.id)" style="cursor:pointer">
                <td>{{ r.at }}</td>
                <td><span class="tag">{{ SCOPE_ZH[r.scope] || r.scope }}</span></td>
                <td>{{ r.display_name || r.username || '—' }}</td>
                <td>{{ r.item_count }}</td>
                <td>
                  <button class="btn sm" @click.stop="open(r.id)">对照表</button>
                  <button class="btn sm danger" style="margin-left:6px" @click.stop="del(r.id)">删除</button>
                </td>
              </tr>
              <tr v-if="detail && detail.id === r.id">
                <td colspan="5">
                  <div class="mut" style="font-size:12px;margin-bottom:6px">脱敏后文本（快照前 2000 字）：</div>
                  <div style="background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;font-size:12.5px">{{ detail.masked_preview || '（空）' }}</div>
                  <table class="tbl map-tbl" style="margin-top:8px">
                    <thead><tr><th>原文</th><th>占位码</th><th>类别</th></tr></thead>
                    <tbody><tr v-for="(e, i) in detail.mapping" :key="i"><td>{{ e.term }}</td><td><code class="code-chip">{{ e.style === 'C' ? e.code : '[' + e.code + ']' }}</code></td><td class="mut">{{ e.cat }}</td></tr></tbody>
                  </table>
                  <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
                    <button class="btn sm" @click="review(r.id)">二次复核</button>
                    <span v-if="reviewOut" style="font-size:12.5px">
                      <span class="tag" :class="reviewOut.verdict === 'complete' ? 'ok' : 'warn'">{{ reviewOut.verdict === 'complete' ? '完整' : '有残留' }}</span>
                      <span v-if="reviewOut.residual.length" class="err">残留：{{ reviewOut.residual.join('、') }}</span>
                      <span v-if="reviewOut.unused.length" class="mut">未引用：{{ reviewOut.unused.join('、') }}</span>
                    </span>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-if="!rows.length" class="empty">暂无记录</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
        <select v-model.number="size" @change="page = 1; load()">
          <option v-for="s in [10, 20, 30, 50, 100]" :key="s" :value="s">{{ s }} 条/页</option>
        </select>
        <span class="mut">{{ page }} / {{ pages() }} 页</span>
        <span style="flex:1"></span>
        <button class="btn sm" :disabled="page <= 1" @click="flip(page - 1)">上一页</button>
        <button class="btn sm" :disabled="page >= pages()" @click="flip(page + 1)">下一页</button>
      </div>
    </div>
  </div>
</template>
