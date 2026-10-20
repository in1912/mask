<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { api, token } from '../api.js';

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(10);
const flash = ref('');
const busy = ref(false);
const fileEl = ref(null);

const cur = ref(null);          // { job, files, mapping_count, processed }
const view = ref(null);         // 单文件全文 { file, raw, masked, truncated }
const showChat = ref(false);
const convs = ref([]);
const picked = ref([]);
const timer = ref(null);

const JOB_ZH = { ready: '待执行', running: '执行中', done: '已完成', failed: '失败' };
const FILE_ZH = { pending: '待处理', running: '处理中', done: '完成', failed: '失败' };
const me = ref(null);
const isAdmin = computed(() => !!(me.value && me.value.role === 'admin'));

function say(s) { flash.value = s; setTimeout(() => { if (flash.value === s) flash.value = ''; }, 4000); }

async function load() {
  const out = await api(`/batch?size=${size.value}&page=${page.value}`);
  rows.value = out.rows;
  total.value = out.total;
}
async function openJob(id) {
  cur.value = await api('/batch/' + id);
  startPoll();
}
function startPoll() {
  stopPoll();
  if (!cur.value) return;
  if (cur.value.job.status !== 'running') return;
  timer.value = setTimeout(async () => {
    try {
      cur.value = await api('/batch/' + cur.value.job.id);
      if (cur.value.job.status === 'running') startPoll();
      else { await load(); }
    } catch { startPoll(); }
  }, 1200);
}
function stopPoll() { if (timer.value) { clearTimeout(timer.value); timer.value = null; } }
onBeforeUnmount(stopPoll);

async function upload() {
  const fs = [...(fileEl.value.files || [])];
  fileEl.value.value = '';
  if (!fs.length) return;
  busy.value = true;
  try {
    const fd = new FormData();
    for (const f of fs) fd.append('files', f);
    const r = await fetch('/api/batch', { method: 'POST', headers: { Authorization: 'Bearer ' + token() }, body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '上传失败');
    say(`已建批次：${j.files.length} 个文件，点「开始脱敏」执行`);
    await load();
    cur.value = j;
  } catch (e) { alert(e.message); }
  busy.value = false;
}

async function runJob() {
  if (!cur.value) return;
  try {
    await api(`/batch/${cur.value.job.id}/run`, { method: 'POST', body: {} });
    await openJob(cur.value.job.id);
  } catch (e) { alert(e.message); }
}
async function delJob(id) {
  if (!confirm('删除该批次的文件与结果？历史记录会保留，删除后不可恢复。')) return;
  try {
    await api('/batch/' + id, { method: 'DELETE' });
    if (cur.value && cur.value.job.id === id) cur.value = null;
    await load();
  } catch (e) { alert(e.message); }
}
async function openFile(f) {
  try { view.value = await api(`/batch/${cur.value.job.id}/file/${f.id}`); }
  catch (e) { alert(e.message); }
}
function dlFile(f, which) {
  window.open(`/api/batch/${cur.value.job.id}/file/${f.id}/download?which=${which}&token=${encodeURIComponent(token())}`, '_blank');
}
function dlZip() {
  window.open(`/api/batch/${cur.value.job.id}/download?token=${encodeURIComponent(token())}`, '_blank');
}

async function openChatPicker() {
  try {
    const out = await api('/conversations');
    convs.value = out.list || [];
    picked.value = [];
    showChat.value = true;
  } catch (e) { alert(e.message); }
}
async function exportChats() {
  if (!picked.value.length) return alert('先勾选会话');
  try {
    const j = await api('/batch/export', { method: 'POST', body: { conversation_ids: picked.value } });
    showChat.value = false;
    await load();
    cur.value = j;
    say('会话已生成批次，点「开始脱敏」执行');
  } catch (e) { alert(e.message); }
}

onMounted(async () => {
  try { me.value = (await api('/auth/me')).user; } catch { /* 401 已跳登录 */ }
  await load();
});
</script>

<template>
  <div class="card">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b>批量脱敏</b>
      <span class="mut" style="font-size:12.5px">多文件共用一张对照表（同一实体跨文件同码）；全部在本机完成。</span>
      <span style="flex:1"></span>
      <button class="btn sm" @click="openChatPicker">从会话生成批次</button>
    </div>
    <p v-if="flash" class="mut" style="margin:6px 0">{{ flash }}</p>

    <div style="border:1px dashed var(--bd);border-radius:8px;padding:12px;margin-top:10px">
      <input ref="fileEl" type="file" multiple accept=".txt,.md,.csv,.log,.json,.xml,.html,.htm,.docx,.pdf,.xlsx" />
      <button class="btn primary sm" style="margin-left:8px" :disabled="busy" @click="upload">{{ busy ? '上传中…' : '上传并建批次' }}</button>
      <p class="mut" style="margin:8px 0 0;font-size:12px">
        最多 50 个，单个 ≤20MB，合计 ≤200MB。输出是纯文本 <code>.txt</code>（不保留 Word/PDF/Excel 排版）；扫描件 PDF 提取不到文字会列进失败清单。
      </p>
    </div>

    <div style="display:flex;gap:8px;align-items:center;margin-top:14px">
      <b>批次列表</b><span class="mut" style="font-size:12px">共 {{ total }}</span>
      <span style="flex:1"></span>
      <select v-model.number="size" @change="page = 1; load()">
        <option v-for="n in [10, 20, 30, 50, 100]" :key="n" :value="n">{{ n }} 条/页</option>
      </select>
    </div>
    <div style="overflow-x:auto">
      <table class="tb" style="width:100%;margin-top:8px">
        <thead><tr><th>#</th><th>时间</th><th v-if="isAdmin">用户</th><th>文件</th><th>状态</th><th>成功/失败</th><th></th></tr></thead>
        <tbody>
          <tr v-for="j in rows" :key="j.id" style="cursor:pointer" @click="openJob(j.id)">
            <td>{{ j.id }}</td>
            <td class="mut" style="font-size:12px">{{ (j.created_at || '').slice(0, 16) }}</td>
            <td v-if="isAdmin" class="mut" style="font-size:12px">{{ j.username || j.user_id }}</td>
            <td>{{ j.total }}</td>
            <td><span class="tag" :class="{ ok: j.status === 'done', warn: j.status === 'failed' }">{{ JOB_ZH[j.status] || j.status }}</span></td>
            <td class="mut" style="font-size:12px">{{ j.ok_count }} / {{ j.fail_count }}</td>
            <td><button class="btn sm" @click.stop="delJob(j.id)">删除</button></td>
          </tr>
          <tr v-if="!rows.length"><td :colspan="isAdmin ? 7 : 6" class="mut">还没有批次</td></tr>
        </tbody>
      </table>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn sm" :disabled="page <= 1" @click="page--; load()">上一页</button>
      <button class="btn sm" :disabled="page * size >= total" @click="page++; load()">下一页</button>
    </div>
  </div>

  <div v-if="cur" class="card" style="margin-top:14px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b>批次 #{{ cur.job.id }}</b>
      <span class="tag">{{ JOB_ZH[cur.job.status] || cur.job.status }}</span>
      <span class="mut" style="font-size:12px">进度 {{ cur.processed }}/{{ cur.job.total }} · 对照 {{ cur.mapping_count }} 项</span>
      <span v-if="isAdmin" class="mut" style="font-size:12px">用户 {{ cur.job.username || cur.job.user_id }}</span>
      <span style="flex:1"></span>
      <button v-if="cur.job.status !== 'running'" class="btn primary sm" @click="runJob">开始脱敏</button>
      <button class="btn sm" :disabled="cur.job.status === 'running'" @click="dlZip">下载 zip</button>
      <button class="btn sm" @click="delJob(cur.job.id)">删除批次</button>
    </div>
    <p v-if="cur.job.error" class="err" style="margin:6px 0;font-size:12px">{{ cur.job.error }}</p>
    <p class="mut" style="margin:6px 0;font-size:12px">zip 内含脱敏文本、mapping.csv（原文→占位码）与 _errors.txt；原文件在列表里单独下载。</p>

    <div style="overflow-x:auto">
      <table class="tb" style="width:100%">
        <thead><tr><th>文件</th><th>状态</th><th>命中</th><th>说明</th><th></th></tr></thead>
        <tbody>
          <tr v-for="f in cur.files" :key="f.id">
            <td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ f.name }}</td>
            <td><span class="tag" :class="{ ok: f.status === 'done', warn: f.status === 'failed' }">{{ FILE_ZH[f.status] || f.status }}</span></td>
            <td>{{ f.match_count }}</td>
            <td class="err" style="font-size:12px;max-width:360px">{{ f.error }}</td>
            <td style="white-space:nowrap">
              <button class="btn sm" @click="openFile(f)">查看</button>
              <button class="btn sm" @click="dlFile(f, 'raw')">原文</button>
              <button class="btn sm" :disabled="f.status !== 'done'" @click="dlFile(f, 'masked')">脱敏</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="view" class="card" style="margin-top:14px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b>{{ view.file.name }}</b>
      <span class="tag">{{ FILE_ZH[view.file.status] || view.file.status }}</span>
      <span class="mut" style="font-size:12px">命中 {{ view.file.match_count }} 项</span>
      <span v-if="view.truncated" class="tag warn">预览截断</span>
      <span style="flex:1"></span>
      <button class="btn sm" @click="view = null">关闭</button>
    </div>
    <p v-if="view.file.error" class="err" style="font-size:12px">{{ view.file.error }}</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">
      <div>
        <div class="mut" style="font-size:12px;margin-bottom:4px">原文（提取后）</div>
        <pre style="white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;font-size:12px">{{ view.raw || '（无）' }}</pre>
      </div>
      <div>
        <div class="mut" style="font-size:12px;margin-bottom:4px">脱敏后</div>
        <pre style="white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;font-size:12px">{{ view.masked || '（这个文件还没有脱敏结果）' }}</pre>
      </div>
    </div>
  </div>

  <div v-if="showChat" style="position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:50" @click.self="showChat = false">
    <div class="card" style="width:min(680px,92vw);max-height:80vh;overflow:auto">
      <div style="display:flex;align-items:center;gap:8px">
        <b>从会话生成批次</b><span class="mut" style="font-size:12px">每个会话导成一个 txt，再一起脱敏</span>
        <span style="flex:1"></span>
        <button class="btn sm" @click="showChat = false">取消</button>
      </div>
      <div style="margin-top:10px;max-height:50vh;overflow:auto">
        <label v-for="c in convs" :key="c.id" style="display:flex;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid var(--bd)">
          <input type="checkbox" :value="c.id" v-model="picked" />
          <span style="flex:1">{{ c.title || ('会话 #' + c.id) }}</span>
          <span class="mut" style="font-size:12px">{{ (c.updated_at || '').slice(0, 16) }}</span>
        </label>
        <p v-if="!convs.length" class="mut">还没有会话</p>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
        <button class="btn primary" :disabled="!picked.length" @click="exportChats">生成批次（{{ picked.length }}）</button>
      </div>
    </div>
  </div>
</template>
