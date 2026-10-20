<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const tab = ref('logs');
const TABS = [
  { id: 'logs', label: '登录日志' },
  { id: 'blacklist', label: 'IP 黑名单' },
  { id: 'ai', label: 'AI 配置' },
  { id: 'system', label: '系统信息' }
];

// 登录日志
const logs = ref({ rows: [], total: 0, page: 1, size: 5 });
const logQ = ref('');
const STATUS_ZH = { ok: ['登录成功', 'ok'], fail: ['失败', 'danger'], blocked: ['拦截', 'warn'] };
async function loadLogs() {
  const q = new URLSearchParams({ page: logs.value.page, size: logs.value.size });
  if (logQ.value) q.set('q', logQ.value);
  logs.value = await api('/login-logs?' + q.toString());
}
function logPages() { return Math.max(1, Math.ceil(logs.value.total / logs.value.size)); }
function logFlip(p) { if (p >= 1 && p <= logPages()) { logs.value.page = p; loadLogs(); } }
async function banIp(ip, username) {
  if (!confirm(`封禁 IP ${ip}？该 IP 将无法访问本系统。`)) return;
  try { await api('/ip-blacklist', { method: 'POST', body: { ip, note: username ? '来自登录日志：' + username : '' } }); loadLogs(); loadBlacklist(); } catch (e) { alert(e.message); }
}
async function unbanIp(ip) {
  await api('/ip-blacklist/' + encodeURIComponent(ip), { method: 'DELETE' });
  loadLogs(); loadBlacklist();
}

// IP 黑名单
const bl = ref([]);
const blForm = ref({ ip: '', note: '' });
const blErr = ref('');
async function loadBlacklist() { bl.value = (await api('/ip-blacklist')).list; }
async function addBl() {
  blErr.value = '';
  try { await api('/ip-blacklist', { method: 'POST', body: blForm.value }); blForm.value = { ip: '', note: '' }; loadBlacklist(); }
  catch (e) { blErr.value = e.message; }
}

// AI 配置
const ai = ref({ model: '', base_url: '', has_key: false, key_tail: '' });
const aiForm = ref({ model: '', base_url: '', api_key: '' });
const aiMsg = ref('');
const testing = ref(false);
async function loadAi() {
  ai.value = await api('/settings/ai-config');
  aiForm.value.model = ai.value.model;
  aiForm.value.base_url = ai.value.base_url;
  aiForm.value.api_key = '';
}
async function saveAi() {
  aiMsg.value = '';
  try { await api('/settings/ai-config', { method: 'POST', body: aiForm.value }); await loadAi(); aiMsg.value = '已保存'; }
  catch (e) { aiMsg.value = e.message; }
}
async function testAi() {
  testing.value = true; aiMsg.value = '';
  try {
    const out = await api('/settings/ai-test', { method: 'POST', body: aiForm.value });
    aiMsg.value = out.ok ? `连接成功（模型 ${out.model}，回复：${out.reply || '(空)'}）` : '连接失败：' + out.error;
  } catch (e) { aiMsg.value = e.message; }
  testing.value = false;
}

// 系统信息
const sys = ref({ beian: '', external_base_url: '', local_base_url: '' });
const lanAddrs = ref([]);
const sysMsg = ref('');
async function loadSys() {
  sys.value = await api('/settings/system');
  lanAddrs.value = (await api('/settings/lan-addrs')).addrs;
}
async function saveSys() {
  sysMsg.value = '';
  try { await api('/settings/system', { method: 'POST', body: sys.value }); sysMsg.value = '已保存'; } catch (e) { sysMsg.value = e.message; }
}

const loadByTab = { logs: loadLogs, blacklist: loadBlacklist, ai: loadAi, system: loadSys };
function switchTab(id) { tab.value = id; loadByTab[id](); }
const forbidden = ref('');
onMounted(async () => {
  try { await loadLogs(); } catch (e) { forbidden.value = e.message; }
});
</script>

<template>
  <div style="max-width:1020px">
    <div class="page-title">系统设置</div>
    <div v-if="forbidden" class="card empty">{{ forbidden }}</div>
    <div v-else style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
      <button v-for="t in TABS" :key="t.id" class="btn sm" :class="{ primary: tab === t.id }" @click="switchTab(t.id)">{{ t.label }}</button>
    </div>

    <div v-if="tab === 'logs'" class="card">
      <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
        <input v-model="logQ" placeholder="搜索用户名 / IP" style="width:220px" @keyup.enter="logs.page = 1; loadLogs()" />
        <button class="btn sm" @click="logs.page = 1; loadLogs()">搜索</button>
        <span style="flex:1"></span>
        <span class="mut">{{ logs.total }} 条</span>
      </div>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr>
            <th>操作日期时间</th><th>用户名</th><th>中文名称</th><th>状态</th><th>IP 地址</th><th>地区</th><th>尝试的密码</th><th>客户端</th><th>操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in logs.rows" :key="r.id">
              <td style="white-space:nowrap">{{ r.at }}</td>
              <td>{{ r.username || '—' }}</td>
              <td>{{ r.display_name || '—' }}</td>
              <td><span class="tag" :class="STATUS_ZH[r.status]?.[1] || ''">{{ STATUS_ZH[r.status]?.[0] || r.status }}</span></td>
              <td>{{ r.ip }}</td>
              <td class="mut">{{ r.region || '—' }}</td>
              <td class="mut">{{ r.password || '—' }}</td>
              <td class="mut">{{ r.client }}</td>
              <td>
                <button v-if="r.ip && !r.ip.startsWith('127.') && !r.ip.startsWith('::1')" class="btn sm danger" @click="banIp(r.ip, r.username)">封禁IP</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!logs.rows.length" class="empty">暂无日志</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
        <select v-model.number="logs.size" @change="logs.page = 1; loadLogs()">
          <option v-for="s in [5, 15, 30, 50, 100]" :key="s" :value="s">{{ s }} 条/页</option>
        </select>
        <span class="mut">{{ logs.page }} / {{ logPages() }} 页</span>
        <span style="flex:1"></span>
        <button class="btn sm" :disabled="logs.page <= 1" @click="logFlip(logs.page - 1)">上一页</button>
        <button class="btn sm" :disabled="logs.page >= logPages()" @click="logFlip(logs.page + 1)">下一页</button>
      </div>
    </div>

    <div v-else-if="tab === 'blacklist'" class="card">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <input v-model="blForm.ip" placeholder="IP 地址，如 1.2.3.4" style="width:180px" />
        <input v-model="blForm.note" placeholder="备注（可选）" style="width:240px" />
        <button class="btn primary sm" @click="addBl">添加</button>
      </div>
      <p v-if="blErr" class="err">{{ blErr }}</p>
      <table class="tbl">
        <thead><tr><th>IP</th><th>备注</th><th>添加时间</th><th>操作人</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in bl" :key="b.ip">
            <td><b>{{ b.ip }}</b></td><td class="mut">{{ b.note || '—' }}</td><td class="mut">{{ b.created_at }}</td><td class="mut">{{ b.created_by || '—' }}</td>
            <td><button class="btn sm danger" @click="unbanIp(b.ip)">解封</button></td>
          </tr>
        </tbody>
      </table>
      <div v-if="!bl.length" class="empty">黑名单为空</div>
    </div>

    <div v-else-if="tab === 'ai'" class="card" style="max-width:640px">
      <p class="mut" style="margin-bottom:12px;font-size:12.5px">API Key 以 AES-256-GCM 加密存储，任何接口都不会回传明文{{ ai.has_key ? `（当前已保存，尾号 ${ai.key_tail}）` : '' }}。</p>
      <label class="mut">接口地址（OpenAI 兼容，如 https://api.xxx.com/v1）</label>
      <input v-model="aiForm.base_url" style="width:100%;margin:4px 0 12px" placeholder="https://api.example.com/v1" />
      <label class="mut">模型名称</label>
      <input v-model="aiForm.model" style="width:100%;margin:4px 0 12px" placeholder="例如 gpt-4o-mini / deepseek-chat / kimi-for-coding" />
      <label class="mut">API Key{{ ai.has_key ? '（留空表示沿用已保存的 Key）' : '' }}</label>
      <input v-model="aiForm.api_key" type="password" style="width:100%;margin:4px 0 12px" placeholder="sk-…" />
      <div style="display:flex;gap:10px">
        <button class="btn primary" @click="saveAi">保存</button>
        <button class="btn" :disabled="testing" @click="testAi">{{ testing ? '测试中…' : '测试连接' }}</button>
      </div>
      <p v-if="aiMsg" style="margin-top:10px" :class="aiMsg.startsWith('已保存') || aiMsg.startsWith('连接成功') ? '' : 'err'">{{ aiMsg }}</p>
    </div>

    <div v-else class="card" style="max-width:640px">
      <label class="mut">ICP 备案文案（登录页底部显示；留空则不显示）</label>
      <input v-model="sys.beian" style="width:100%;margin:4px 0 12px" placeholder="浙ICP备XXXXXXXXXX" />
      <label class="mut">外网访问域名（用于分享链接 / Agent 注入链接，P1 生效）</label>
      <input v-model="sys.external_base_url" style="width:100%;margin:4px 0 12px" placeholder="https://mask.example.com" />
      <label class="mut">本机访问地址</label>
      <input v-model="sys.local_base_url" style="width:100%;margin:4px 0 12px" placeholder="http://192.168.x.x:9909" />
      <p class="mut" style="font-size:12px;margin-bottom:12px">检测到本机网卡：{{ lanAddrs.join('、') || '—' }}（可复制到上框）</p>
      <button class="btn primary" @click="saveSys">保存</button>
      <span v-if="sysMsg" style="margin-left:10px">{{ sysMsg }}</span>
    </div>
  </div>
</template>
