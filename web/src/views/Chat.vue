<script setup>
import { ref, nextTick, onMounted } from 'vue';
import { api, token } from '../api.js';

const convs = ref([]);
const convId = ref(null);
const messages = ref([]);
const input = ref('');
const useMask = ref(localStorage.getItem('mask_use') !== '0');
const engineOpts = ref([]);   // 本页可选脱敏引擎
const engSel = ref(localStorage.getItem('mask_chat_engine') || ''); // '' = 跟随全局
const streaming = ref(false);
const curMask = ref(null);   // 本轮 start 事件：mapping/count/skipped
const curReview = ref(null); // done 事件里的复核
const bubblesEl = ref(null);
const fileEl = ref(null);
const attachBusy = ref(false);

const METHOD_ZH = { regex: '正则', anchor: '锚定', luhn: '校验', heuristic: '启发式', dict: '词典' };
const CAT_ZH = { pii: '个人隐私', ent: '企业业务', tech: '技术系统' };

async function loadConvs(pickLast = true) {
  const out = await api('/conversations');
  convs.value = out.list;
  if (pickLast && out.list.length && convId.value == null) openConv(out.list[0].id);
}
async function openConv(id) {
  convId.value = id;
  curMask.value = null;
  curReview.value = null;
  const out = await api('/conversations/' + id + '/messages');
  messages.value = out.messages.map((m) => ({ role: m.role, content: m.content, mask_count: m.mask_count }));
  // 打开会话默认落在最后一条：显示最新对话的完整内容，而不是从头（最早）开始
  scrollBottom();
}
function newConv() {
  convId.value = null;
  messages.value = [];
  curMask.value = null;
  curReview.value = null;
}
async function delConv(id) {
  if (!confirm('删除该会话及其对照表？')) return;
  await api('/conversations/' + id, { method: 'DELETE' });
  if (convId.value === id) newConv();
  loadConvs(false);
}

function toggleMask() {
  useMask.value = !useMask.value;
  localStorage.setItem('mask_use', useMask.value ? '1' : '0');
}
function saveEngine() {
  localStorage.setItem('mask_chat_engine', engSel.value);
}
async function loadEngines() {
  try {
    const out = await api('/engines/options');
    engineOpts.value = out.options || [];
  } catch { engineOpts.value = []; } // 拉不到就让选择留在「跟随全局」，发送仍走全局配置
}

async function attach() {
  const f = fileEl.value.files[0];
  fileEl.value.value = '';
  if (!f) return;
  attachBusy.value = true;
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await fetch('/api/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + token() }, body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '上传失败');
    input.value = (input.value ? input.value + '\n\n' : '') + `【附件：${j.name}】\n${j.text}`;
  } catch (e) { alert('附件处理失败：' + e.message); }
  attachBusy.value = false;
}

function scrollBottom() {
  nextTick(() => { if (bubblesEl.value) bubblesEl.value.scrollTop = bubblesEl.value.scrollHeight; });
}

async function send(forceMask) {
  const text = input.value.trim();
  if (!text || streaming.value) return;
  const masked = forceMask === true ? true : useMask.value;
  messages.value.push({ role: 'user', content: text });
  const asst = { role: 'assistant', content: '' };
  messages.value.push(asst);
  input.value = '';
  streaming.value = true;
  scrollBottom();
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({
        conv_id: convId.value,
        messages: messages.value.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
        desensitize: masked,
        engine: engSel.value,
        with_rules: true
      })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'start') {
          convId.value = ev.conv_id;
          curMask.value = ev;
          curReview.value = null;
          loadConvs(false);
        } else if (ev.type === 'delta') {
          asst.content += ev.text;
          scrollBottom();
        } else if (ev.type === 'done') {
          asst.content = ev.content;
          curReview.value = ev.review;
          scrollBottom();
        } else if (ev.type === 'error') {
          asst.content += '\n⚠ ' + ev.error;
        }
      }
    }
  } catch (e) {
    asst.content += (asst.content ? '\n' : '') + '⚠ ' + e.message;
  }
  streaming.value = false;
  scrollBottom();
}

function onKey(e) {
  if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(false); }
  else if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); send(true); }
}

onMounted(() => { loadConvs(); loadEngines(); });
</script>

<template>
  <div class="chat-wrap">
    <aside class="conv-pane">
      <button class="btn primary" @click="newConv"><span class="material-icons">add</span>新对话</button>
      <div v-for="c in convs" :key="c.id" class="conv-item" :class="{ on: c.id === convId }" @click="openConv(c.id)">
        <span class="t" :title="c.title">{{ c.title }}</span>
        <button class="del" title="删除会话" @click.stop="delConv(c.id)"><span class="material-icons" style="font-size:16px">close</span></button>
      </div>
    </aside>

    <section class="chat-main">
      <div class="chat-head">
        <b>{{ (convs.find(c => c.id === convId) || {}).title || '新对话' }}</b>
        <span class="grow" style="flex:1"></span>
        <label class="switch" title="回车发送是否自动脱敏（Ctrl+回车 强制脱敏发送）">
          <input type="checkbox" :checked="useMask" @change="toggleMask"><i></i>
        </label>
        <span class="mut" style="font-size:13px">发送前脱敏</span>
        <label class="eng-pick" title="本页选用的脱敏引擎；「跟随全局」= 用「脱敏引擎」页设置的主引擎/并行配置">
          <select v-model="engSel" @change="saveEngine">
            <option value="">跟随全局</option>
            <option v-for="o in engineOpts" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </label>
        <span v-if="curMask && !curMask.skipped" class="tag ok">本轮替换 {{ curMask.count }} 项</span>
        <span v-else-if="curMask && curMask.skipped" class="tag warn">未脱敏：{{ curMask.reason || '开关关闭' }}</span>
      </div>

      <div ref="bubblesEl" class="bubbles">
        <div v-if="!messages.length" class="empty">
          左侧选择或新建对话。支持回车发送、Ctrl+回车强制脱敏发送、上传附件自动提取文本。
        </div>
        <div v-for="(m, i) in messages" :key="i" class="bubble" :class="m.role === 'user' ? 'user' : 'ai'">
          <div>{{ m.content }}<span v-if="streaming && i === messages.length - 1" class="cursor">▋</span></div>
          <div v-if="m.role === 'user' && m.mask_count" class="meta">已脱敏 {{ m.mask_count }} 项后发送</div>
        </div>
      </div>

      <div class="composer">
        <div class="composer-row">
          <input ref="fileEl" type="file" style="display:none" @change="attach" />
          <button class="btn" :disabled="attachBusy || streaming" title="上传附件（txt/docx 提取为文本）" @click="fileEl.click()">
            <span class="material-icons">attach_file</span>
          </button>
          <textarea v-model="input" placeholder="输入内容…（附件文本会合并进来一起脱敏）"
            @keydown="onKey"></textarea>
          <button class="btn primary" :disabled="streaming || !input.trim()" @click="send(false)">
            {{ streaming ? '生成中…' : '确认发送' }}
          </button>
        </div>
        <div class="tip-line">
          <span>回车 = 按当前开关发送</span>
          <span>Ctrl + 回车 = 强制脱敏发送（自动附上脱敏要求）</span>
          <span v-if="curReview">复核：{{ curReview.verdict === 'complete' ? '完整复原' : '有残留' }}{{ curReview.residual && curReview.residual.length ? '，残留 ' + curReview.residual.join(' ') : '' }}</span>
        </div>
      </div>
    </section>

    <aside class="info-pane">
      <div class="card">
        <h4>说明</h4>
        <p class="mut" style="font-size:12.5px">发送时先把个人隐私 / 企业业务 / 技术系统三类敏感词替换成占位码，AI 只见到码文；回复流式到达时按<b>对照表</b>原样复原。同一实体在同一会话内始终同码，AI 能保持上下文连贯。总开关关闭时系统会如实提示「未脱敏」，绝不假装脱敏。</p>
      </div>
      <div class="card">
        <h4>本轮对照关系（{{ curMask && !curMask.skipped ? curMask.count : 0 }} 项）</h4>
        <p v-if="curMask && !curMask.skipped" class="mut" style="font-size:12px;margin-bottom:6px">
          识别引擎：<b>{{ curMask.engine || '内置规则引擎' }}</b>
        </p>
        <div v-if="!curMask || curMask.skipped" class="mut" style="font-size:12px">{{ curMask ? curMask.reason : '尚未发送' }}</div>
        <div v-else class="tbl-scroll">
          <table class="tbl map-tbl">
            <thead><tr><th>原文</th><th>占位码</th><th>类别</th></tr></thead>
            <tbody>
              <tr v-for="e in curMask.mapping" :key="e.term">
                <td>{{ e.term }}</td>
                <td><code class="code-chip">{{ e.style === 'C' ? e.code : '[' + e.code + ']' }}</code></td>
                <td class="mut">{{ CAT_ZH[e.cat] || e.cat }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card" v-if="curReview">
        <h4>本轮回文复核</h4>
        <p style="font-size:12.5px">
          <span class="tag" :class="curReview.verdict === 'complete' ? 'ok' : 'warn'">{{ curReview.verdict === 'complete' ? '完整复原' : '存在残留' }}</span>
          <span v-if="curReview.residual && curReview.residual.length" class="err"> 残留代码：{{ curReview.residual.join('、') }}</span>
          <span v-if="curReview.unused && curReview.unused.length" class="mut">（本轮对照中未在回复里出现的：{{ curReview.unused.join('、') }}）</span>
        </p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.cursor { animation: blink 1s step-start infinite; }
@keyframes blink { 50% { opacity: 0; } }
.eng-pick select { background: var(--panel2, var(--panel)); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 4px 6px; font-size: 12.5px; max-width: 170px; }
</style>
