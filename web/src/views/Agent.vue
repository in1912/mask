<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { mdToHtml, copyText } from '../md.js';

const links = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(5);
const days = ref(0);
const flash = ref('');

// 选中的链接 → 回文列表
const curLink = ref(null);
const writes = ref([]);
const writesTotal = ref(0);
const writesPage = ref(1);
const writesSize = ref(5);
const curWrite = ref(null); // 完整内容
const mdHtml = computed(() => mdToHtml(curWrite.value ? curWrite.value.content : ''));

function say(s) { flash.value = s; setTimeout(() => { if (flash.value === s) flash.value = ''; }, 3500); }

const validity = (l) => l.revoked ? '已撤销' : (l.expires_at ? '至 ' + l.expires_at : '永久');

async function load() {
  const out = await api(`/agents?size=${size.value}&page=${page.value}`);
  links.value = out.rows;
  total.value = out.total;
}
async function create() {
  const out = await api('/agents', { method: 'POST', body: { days: days.value } });
  await load();
  openLink(out);
  say('已创建' + (out.days ? `（${out.days} 天有效）` : '（永久有效）'));
}
async function openLink(l) {
  curLink.value = l;
  curWrite.value = null;
  writesPage.value = 1;
  await loadWrites();
}
async function loadWrites() {
  if (!curLink.value) return;
  const out = await api(`/agents/${curLink.value.id}/writes?size=${writesSize.value}&page=${writesPage.value}`);
  writes.value = out.rows;
  writesTotal.value = out.total;
}
async function viewWrite(w) {
  curWrite.value = await api('/agents/writes/' + w.id);
}
async function del(l) {
  if (!confirm('删除该链接及其全部回文？已发给外部 AI 的地址立即失效。')) return;
  await api('/agents/' + l.id, { method: 'DELETE' });
  if (curLink.value && curLink.value.id === l.id) { curLink.value = null; writes.value = []; }
  load();
}
async function cp(url) { say(await copyText(url) ? '已复制' : '复制失败，请手动选择复制'); }

const pages = computed(() => Math.max(1, Math.ceil(total.value / size.value)));
const wPages = computed(() => Math.max(1, Math.ceil(writesTotal.value / writesSize.value)));
function goPage(p) { page.value = p; load(); }
function goWPage(p) { writesPage.value = p; loadWrites(); }
function setSize(s) { size.value = s; page.value = 1; load(); }
function setWSize(s) { writesSize.value = s; writesPage.value = 1; loadWrites(); }

onMounted(load);
</script>

<template>
  <div class="agent-page">
    <div class="toolbar">
      <span class="mut" style="font-size:12.5px">给外部 AI 的只写地址：对方打开只能看到引导语并提交回文，写入内容只有你能看到。默认永久。</span>
      <span class="grow"></span>
      <select :value="days" @change="days = Number($event.target.value)">
        <option :value="0">永久</option>
        <option :value="7">7 天</option>
        <option :value="14">14 天</option>
        <option :value="30">30 天</option>
      </select>
      <button class="btn primary" @click="create"><span class="material-icons">add_link</span>创建链接</button>
    </div>
    <p v-if="flash" class="mut" style="margin:2px 0 8px">{{ flash }}</p>

    <table class="tbl">
      <thead><tr>
        <th>创建时间</th><th>创建人</th><th>有效期</th><th>回文数</th><th>最近回文</th><th style="width:250px">操作</th>
      </tr></thead>
      <tbody>
        <tr v-if="!links.length"><td colspan="6" class="mut" style="text-align:center;padding:26px">还没有链接，点右上「创建链接」生成一个给外部 AI 用</td></tr>
        <tr v-for="l in links" :key="l.id" :class="{ selrow: curLink && curLink.id === l.id }" @click="openLink(l)">
          <td class="mut">{{ l.at }}</td>
          <td>{{ l.created_by }}</td>
          <td><span class="tag" :class="l.revoked ? 'warn' : 'ok'">{{ validity(l) }}</span></td>
          <td>{{ l.writes }}</td>
          <td class="mut">{{ l.last_write || '—' }}</td>
          <td @click.stop>
            <button class="mini" title="复制链接地址" @click="cp(l.url)"><span class="material-icons">content_copy</span>地址</button>
            <a class="mini" :href="l.url" target="_blank" title="打开对方看到的页面"><span class="material-icons">open_in_new</span>预览</a>
            <button class="mini danger" @click="del(l)"><span class="material-icons">delete</span></button>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="pager" v-if="total > size">
      <button class="mini" :disabled="page <= 1" @click="goPage(page - 1)">‹</button>
      <span class="mut">{{ page }} / {{ pages }}</span>
      <button class="mini" :disabled="page >= pages" @click="goPage(page + 1)">›</button>
      <select :value="size" @change="setSize(Number($event.target.value))">
        <option v-for="s in [5, 15, 30, 50, 100]" :key="s" :value="s">{{ s }} 条/页</option>
      </select>
    </div>

    <div v-if="curLink" class="writes">
      <div class="writes-head">
        <b>回文列表</b>
        <code class="mut" style="font-size:12px">{{ curLink.url }}</code>
        <span class="grow"></span>
        <select :value="writesSize" @change="setWSize(Number($event.target.value))">
          <option v-for="s in [5, 15, 30, 50, 100]" :key="s" :value="s">{{ s }} 条/页</option>
        </select>
      </div>
      <table class="tbl">
        <thead><tr><th style="width:150px">时间</th><th>字数</th><th>摘要</th></tr></thead>
        <tbody>
          <tr v-if="!writes.length"><td colspan="3" class="mut" style="text-align:center;padding:18px">还没有回文</td></tr>
          <tr v-for="w in writes" :key="w.id" :class="{ selrow: curWrite && curWrite.id === w.id }" @click="viewWrite(w)">
            <td class="mut">{{ w.at }}</td>
            <td>{{ w.word_count }}</td>
            <td class="ellip">{{ w.excerpt }}</td>
          </tr>
        </tbody>
      </table>
      <div class="pager" v-if="writesTotal > writesSize">
        <button class="mini" :disabled="writesPage <= 1" @click="goWPage(writesPage - 1)">‹</button>
        <span class="mut">{{ writesPage }} / {{ wPages }}</span>
        <button class="mini" :disabled="writesPage >= wPages" @click="goWPage(writesPage + 1)">›</button>
      </div>
      <div v-if="curWrite" class="card md-view">
        <div class="writes-head" style="margin-bottom:6px">
          <span class="tag">回文 #{{ curWrite.id }}</span>
          <span class="mut" style="font-size:12px">{{ curWrite.created_at }} · {{ curWrite.word_count }} 字</span>
        </div>
        <div v-html="mdHtml"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-page { display: flex; flex-direction: column; gap: 10px; }
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.selrow { background: var(--hover); }
.ellip { max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pager { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
.writes { border-top: 1px dashed var(--line); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.writes-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
