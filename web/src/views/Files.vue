<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api, token } from '../api.js';
import { copyText } from '../md.js';

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(5);
const busy = ref(false);
const fileEl = ref(null);
const flash = ref('');

// 详情（三栏）
const cur = ref(null);        // GET /documents/:id 的完整回包
const panes = ref([34, 33, 33]);
const wrapEl = ref(null);
const instruction = ref('请总结这份文档的要点。');
const aiBusy = ref(false);
const selReply = ref(0);
const engineOpts = ref([]);   // 文件脱敏可选引擎（内置 + 外部文本引擎）
const engSel = ref('');       // '' = 跟随全局配置

// 分享弹层
const shareDlg = ref(null);   // {days, url, pair_url, write_url, guide, expires_hint, ...}
const shareDays = ref(1);
const shareBusy = ref(false);

const ENGINE_ZH = { plain: '文本', docx: 'Word', pdf: 'PDF', xlsx: 'Excel' };

function say(s) { flash.value = s; setTimeout(() => { if (flash.value === s) flash.value = ''; }, 4000); }

async function load() {
  const out = await api(`/documents?size=${size.value}&page=${page.value}`);
  rows.value = out.rows;
  total.value = out.total;
}
async function openDoc(id) {
  cur.value = await api('/documents/' + id);
  // 默认展示外部 agent 通过链接写入的回文；没有外部回文才退回最近一条
  const list = cur.value.replies || [];
  const ext = list.findIndex((r) => r.source === 'share');
  selReply.value = ext >= 0 ? ext : 0;
  engSel.value = cur.value.doc.mask_engine || '';
}
async function upload() {
  const f = fileEl.value.files[0];
  fileEl.value.value = '';
  if (!f) return;
  busy.value = true;
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await fetch('/api/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + token() }, body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '上传失败');
    say(`已提取「${j.engine}」文本，可点击行查看三栏`);
    await load();
    openDoc(j.id);
  } catch (e) { alert('上传失败：' + e.message); }
  busy.value = false;
}
async function doMask(id) {
  try {
    // 详情打开时用下拉选中的引擎；列表里直接点则沿用该文档上次保存的选择
    const engine = cur.value && cur.value.doc.id === id ? engSel.value : undefined;
    const out = await api(`/documents/${id}/mask`, { method: 'POST', body: engine === undefined ? {} : { engine } });
    if (out.skipped) { say('未脱敏：' + out.reason); return; }
    say(`已脱敏 ${out.count} 项（同实体同码，重复执行不换码）`);
    await load();
    if (cur.value && cur.value.doc.id === id) await openDoc(id);
  } catch (e) { alert(e.message); }
}
async function sendAi() {
  if (!cur.value || aiBusy.value) return;
  aiBusy.value = true;
  try {
    await api(`/documents/${cur.value.doc.id}/ai`, { method: 'POST', body: { instruction: instruction.value } });
    await openDoc(cur.value.doc.id);
    say('AI 已返回，第三栏为复原后的回文');
  } catch (e) { alert(e.message); }
  aiBusy.value = false;
}
async function del(id) {
  if (!confirm('删除该文档及其对照表、回文与分享链接？')) return;
  await api('/documents/' + id, { method: 'DELETE' });
  if (cur.value && cur.value.doc.id === id) cur.value = null;
  load();
}
function dl(id, which) {
  window.open(`/api/documents/${id}/download?which=${which}&token=${encodeURIComponent(token())}`, '_blank');
}
async function shareRow(d) {
  await openDoc(d.id);
  if (!cur.value || !cur.value.masked_text) { say('先脱敏才能分享（分享页只包含码文）'); return; }
  shareDlg.value = { pending: true };
}
async function makeShare() {
  if (!cur.value) return;
  shareBusy.value = true;
  try {
    shareDlg.value = await api(`/documents/${cur.value.doc.id}/share`, { method: 'POST', body: { days: shareDays.value } });
    await openDoc(cur.value.doc.id);
  } catch (e) { alert(e.message); }
  shareBusy.value = false;
}
async function revokeShare(tok) {
  if (!confirm('撤销该分享链接？已发出的地址立即失效。')) return;
  await api('/shares/' + tok, { method: 'DELETE' });
  if (cur.value) await openDoc(cur.value.doc.id);
}
async function cp(url) { say(await copyText(url) ? '已复制' : '复制失败，请手动选择复制'); }

// 三栏拖拽调宽
let drag = null;
function startDrag(i, e) {
  drag = { i, x: e.clientX, w1: panes.value[i], w2: panes.value[i + 1] };
  e.preventDefault();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', stopDrag);
}
function onMove(e) {
  if (!drag || !wrapEl.value) return;
  const pct = ((e.clientX - drag.x) / wrapEl.value.clientWidth) * 100;
  let a = drag.w1 + pct, b = drag.w2 - pct;
  a = Math.max(14, Math.min(72, a));
  b = Math.max(14, Math.min(72, b));
  panes.value[drag.i] = a;
  panes.value[drag.i + 1] = b;
}
function stopDrag() {
  drag = null;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', stopDrag);
}
onBeforeUnmount(stopDrag);

const pages = () => Math.max(1, Math.ceil(total.value / size.value));
function goPage(p) {
  if (p < 1 || p > pages()) return;
  page.value = p;
  load();
}
function setSize(s) { size.value = s; page.value = 1; load(); }

async function loadEngineOpts() {
  try {
    const out = await api('/engines/options');
    engineOpts.value = out.options || [];
  } catch { engineOpts.value = []; } // 选项拉不到不影响脱敏，后端仍按全局配置跑
}

onMounted(() => { load(); loadEngineOpts(); });
</script>

<template>
  <div class="files-page">
    <div class="toolbar">
      <input ref="fileEl" type="file" style="display:none" @change="upload" />
      <button class="btn primary" :disabled="busy" @click="fileEl.click()">
        <span class="material-icons">upload_file</span>{{ busy ? '提取中…' : '上传文档' }}
      </button>
      <span class="mut" style="font-size:12.5px">支持 txt / docx / pdf / xlsx（≤20MB，只提取正文文字，天然剥离文档元数据）</span>
      <span class="grow"></span>
      <select class="pgsize" :value="size" @change="setSize(Number($event.target.value))">
        <option v-for="s in [5, 15, 30, 50, 100]" :key="s" :value="s">{{ s }} 条/页</option>
      </select>
      <button class="btn" @click="load"><span class="material-icons">refresh</span></button>
    </div>
    <p v-if="flash" class="mut" style="margin:2px 0 8px">{{ flash }}</p>

    <table class="tbl">
      <thead><tr>
        <th>日期时间</th><th>用户</th><th>文档名</th><th>文档类型</th><th>匹配项数</th><th>回文</th><th style="width:370px">操作</th>
      </tr></thead>
      <tbody>
        <tr v-if="!rows.length"><td colspan="7" class="mut" style="text-align:center;padding:26px">还没有文档，点左上「上传文档」开始</td></tr>
        <tr v-for="d in rows" :key="d.id" :class="{ selrow: cur && cur.doc.id === d.id }" @click="openDoc(d.id)">
          <td class="mut">{{ d.at }}</td>
          <td>{{ d.display_name || d.username }}</td>
          <td class="ellip" :title="d.filename">{{ d.filename }}</td>
          <td><span class="tag">{{ ENGINE_ZH[d.type] || d.type || '—' }}</span></td>
          <td>{{ d.match_count || 0 }}</td>
          <td>{{ d.reply_count || 0 }}</td>
          <td @click.stop>
            <button class="mini" title="下载原文" @click="dl(d.id, 'raw')"><span class="material-icons">download</span>原文</button>
            <button class="mini" title="执行/刷新脱敏" @click="doMask(d.id)"><span class="material-icons">theater_comedy</span>脱敏</button>
            <button class="mini" title="下载最近一次 AI 回文（已复原）" :disabled="!d.reply_count" @click="dl(d.id, 'restored')"><span class="material-icons">reply</span>回文</button>
            <button class="mini" title="分享这份脱敏文档给外部 agent" :disabled="!d.masked" @click="shareRow(d)"><span class="material-icons">share</span>分享</button>
            <button class="mini danger" title="删除" @click="del(d.id)"><span class="material-icons">delete</span></button>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="pager" v-if="total > size">
      <button class="mini" :disabled="page <= 1" @click="goPage(page - 1)">‹</button>
      <span class="mut">{{ page }} / {{ pages() }}</span>
      <button class="mini" :disabled="page >= pages()" @click="goPage(page + 1)">›</button>
    </div>

    <div v-if="cur" class="detail">
      <div class="detail-head">
        <b>{{ cur.doc.filename }}</b>
        <span v-for="it in cur.doc.meta_report" :key="it.rule" class="tag ok">{{ it.rule }}×{{ it.count }}</span>
        <span class="grow"></span>
        <label class="eng-pick">脱敏引擎
          <select class="pgsize" v-model="engSel">
            <option value="">跟随全局</option>
            <option v-for="o in engineOpts" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </label>
        <button class="btn" @click="doMask(cur.doc.id)"><span class="material-icons">theater_comedy</span>脱敏</button>
        <button class="btn" @click="openDoc(cur.doc.id)"><span class="material-icons">refresh</span>刷新</button>
        <button class="btn" @click="makeShare" :disabled="shareBusy || !cur.masked_text"><span class="material-icons">share</span>分享…</button>
      </div>
      <div ref="wrapEl" class="panes3">
        <section class="pane" :style="{ width: panes[0] + '%' }">
          <h4>原文</h4>
          <pre>{{ cur.raw_text }}</pre>
        </section>
        <div class="vsplit" @pointerdown="startDrag(0, $event)"></div>
        <section class="pane" :style="{ width: panes[1] + '%' }">
          <h4>脱敏（发给外部 AI 的码文）</h4>
          <pre v-if="cur.masked_text">{{ cur.masked_text }}</pre>
          <p v-else class="mut" style="padding:10px">尚未脱敏。点上方操作列「脱敏」，或先看右栏说明。</p>
        </section>
        <div class="vsplit" @pointerdown="startDrag(1, $event)"></div>
        <section class="pane" :style="{ width: panes[2] + '%' }">
          <h4>外部 AI 返回（已按对照表复原）</h4>
          <details class="ai-fold">
            <summary>内置 AI 分析</summary>
            <div class="ai-box">
              <textarea v-model="instruction" placeholder="给内置 AI 的指令（会连同码文一起发送到本系统配置的 AI 接口）"></textarea>
              <button class="btn primary" :disabled="aiBusy || !cur.masked_text" @click="sendAi">
                {{ aiBusy ? '分析中…' : '内置AI分析' }}
              </button>
              <p v-if="!cur.masked_text" class="mut" style="font-size:12px;margin:4px 0 0">先脱敏才能发送——原文绝不直接出网。</p>
            </div>
          </details>
          <div v-if="cur.replies.length" class="replies">
            <div v-for="(rp, i) in cur.replies" :key="rp.id" class="reply-item" :class="{ on: i === selReply }" @click="selReply = i">
              <span class="tag" :class="rp.source === 'share' ? 'ok' : ''">{{ rp.source === 'share' ? '外部 agent 回文' : '内置 AI 分析' }}</span>
              <span class="mut" style="font-size:12px">{{ rp.at }}</span>
            </div>
            <pre>{{ cur.replies[selReply] ? cur.replies[selReply].restored_text : '' }}</pre>
            <p v-if="cur.replies[selReply] && cur.replies[selReply].review" class="mut" style="font-size:12px">
              复核：{{ cur.replies[selReply].review.verdict === 'complete' ? '完整复原' : '存在残留' }}
              <span v-if="cur.replies[selReply].review.residual && cur.replies[selReply].review.residual.length">，残留 {{ cur.replies[selReply].review.residual.join('、') }}</span>
            </p>
          </div>
        </section>
      </div>

      <div v-if="cur.shares.length" class="share-list">
        <h4>有效分享</h4>
        <div v-for="s in cur.shares" :key="s.id" class="share-row">
          <code class="mut">{{ s.url }}</code>
          <span class="mut" style="font-size:12px">至 {{ s.expires_at }} 失效</span>
          <button class="mini" @click="cp(s.url)"><span class="material-icons">content_copy</span>复制</button>
          <button class="mini danger" v-if="!s.revoked" @click="revokeShare(s.token)">撤销</button>
          <span v-else class="tag warn">已撤销</span>
        </div>
      </div>
    </div>

    <div v-if="shareDlg" class="modal-mask" @click.self="shareDlg = null">
      <div class="modal card">
        <h3>分享脱敏文档</h3>
        <div class="share-opt">
          <label><input type="radio" :value="1" v-model="shareDays" /> 1 天</label>
          <label><input type="radio" :value="7" v-model="shareDays" /> 7 天</label>
          <button class="btn primary" :disabled="shareBusy" @click="makeShare">生成新链接</button>
        </div>
        <template v-if="shareDlg.token">
          <p class="mut" style="font-size:12.5px">分享页只包含<b>码文</b>，原文不出网；{{ shareDlg.expires_hint }}。</p>
          <div class="share-row"><span class="lbl">分享页</span><code>{{ shareDlg.url }}</code><button class="mini" @click="cp(shareDlg.url)">复制</button><a class="mini" :href="shareDlg.url" target="_blank">打开</a></div>
          <div class="share-row"><span class="lbl">回文页</span><code>{{ shareDlg.pair_url }}</code><button class="mini" @click="cp(shareDlg.pair_url)">复制</button><a class="mini" :href="shareDlg.pair_url" target="_blank">打开</a></div>
          <div class="share-row"><span class="lbl">程序化</span><code style="font-size:11px">{{ shareDlg.write_url }}</code><button class="mini" @click="cp(shareDlg.write_url)">复制</button></div>
          <h4 style="margin:14px 0 4px">引导语（分享页上已写明）</h4>
          <pre class="guide-pre">{{ shareDlg.guide }}</pre>
        </template>
        <button class="btn" style="margin-top:10px" @click="shareDlg = null">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.files-page { display: flex; flex-direction: column; gap: 10px; }
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pgsize { background: var(--panel2, var(--panel)); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
.selrow { background: var(--hover, rgba(128, 128, 128, .08)); }
.ellip { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pager { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }

.detail { border-top: 1px dashed var(--line); padding-top: 12px; }
.detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.eng-pick { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--mut); }
.panes3 { display: flex; gap: 0; height: 46vh; min-height: 300px; }
.pane { min-width: 14%; overflow: auto; display: flex; flex-direction: column; }
.pane h4 { margin: 0 0 6px; font-size: 13px; color: var(--mut); }
.pane pre { margin: 0; flex: 1; overflow: auto; background: var(--panel2, rgba(127, 127, 127, .08)); border-radius: 8px; padding: 10px; white-space: pre-wrap; word-break: break-all; font-size: 12.5px; line-height: 1.6; }
.vsplit { flex: 0 0 7px; cursor: col-resize; border-left: 1px solid var(--line); border-right: 1px solid var(--line); margin: 0 3px; border-radius: 3px; }
.vsplit:hover, .vsplit:active { background: var(--hover, rgba(127, 127, 127, .2)); }
.ai-fold { margin-bottom: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
.ai-fold summary { cursor: pointer; font-size: 13px; color: var(--mut); user-select: none; }
.ai-fold[open] summary { margin-bottom: 8px; color: var(--fg); }
.ai-box { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; flex-wrap: wrap; }
.ai-box textarea { flex: 1; min-width: 180px; min-height: 44px; resize: vertical; }
.replies { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.replies pre { flex: 1; }
.reply-item { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
.reply-item.on { background: var(--hover, rgba(127, 127, 127, .12)); }
.share-list { margin-top: 12px; }
.share-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
.share-row .lbl { width: 48px; color: var(--mut); font-size: 12px; }
.share-row code { font-size: 12px; word-break: break-all; }
.guide-pre { white-space: pre-wrap; font-size: 12.5px; background: var(--panel2, rgba(127,127,127,.08)); border-radius: 8px; padding: 10px; }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: min(92vw, 640px); max-height: 86vh; overflow: auto; }
.share-opt { display: flex; gap: 18px; align-items: center; margin: 8px 0 12px; }

@media (max-width: 860px) {
  .panes3 { flex-direction: column; height: auto; }
  .pane { width: 100% !important; }
  .pane pre { max-height: 32vh; }
  .vsplit { display: none; }
}
</style>
