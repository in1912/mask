<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api, token } from '../api.js';

const tab = ref('logs');
const TABS = [
  { id: 'logs', label: '登录日志' },
  { id: 'blacklist', label: 'IP 黑名单' },
  { id: 'ai', label: 'AI 配置' },
  { id: 'engines', label: '引擎' },
  { id: 'ack', label: '致谢' },
  { id: 'upgrade', label: '升级' },
  { id: 'ssl', label: 'HTTPS 证书' },
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

// 升级（承游巷方案：上传 zip → 只读预检 → 一次性 token 应用 → 服务自我接替重启）
const up = ref({ current_version: '', package_json_version: '', latest_dist: '', dist_dirs: [], restart_pending: false, restart_suppressed: false, keep: {} });
const upLogs = ref([]);
const upFile = ref(null);
const planning = ref(false);
const applying = ref(false);
const plan = ref(null);        // 预检结果（含 token）
const planErr = ref('');
const applyOut = ref(null);
const waitVer = ref('');       // 非空 = 正在等重启后的新版本
function fmtKB(n) { return (Number(n) / 1024).toFixed(0) + ' KB'; }
async function loadUp() {
  up.value = await api('/upgrade/status');
  upLogs.value = (await api('/upgrade/logs?limit=20')).logs;
}
function pickUpFile(e) {
  plan.value = null; applyOut.value = null; planErr.value = '';
  upFile.value = e.target.files && e.target.files[0] || null;
}
async function doPlan() {
  if (!upFile.value) { planErr.value = '请先选择升级包（zip）'; return; }
  planning.value = true; planErr.value = ''; plan.value = null; applyOut.value = null;
  try {
    const buf = await upFile.value.arrayBuffer();
    // 上传二进制体必须自己 fetch（api() 只发 JSON）；nginx 拒收时回来的是 HTML，先看 content-type 再 json()
    const r = await fetch('/api/upgrade/plan', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token() },
      body: buf
    });
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.includes('json')) throw new Error('预检请求被拒（HTTP ' + r.status + '，反代或体积上限？）');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    plan.value = j.plan;
    planToken = j.token;
  } catch (e) { planErr.value = e.message; }
  planning.value = false;
}
let planToken = '';
async function doApply() {
  applying.value = true; planErr.value = '';
  try {
    applyOut.value = await api('/upgrade/apply', { method: 'POST', body: { token: planToken } });
    plan.value = null;
    if (applyOut.value.restart === 'scheduled') waitRestart(applyOut.value.version.to);
  } catch (e) { planErr.value = e.message; }
  applying.value = false;
}
// 等重启只许裸 fetch('/api/system-info')（EXEMPT 免登录）：api() 在重启窗口里 401 会把管理员踢回登录页
function waitRestart(expectVer) {
  waitVer.value = expectVer;
  const t0 = Date.now();
  (async function poll() {
    if (Date.now() - t0 > 30000) { waitVer.value = ''; planErr.value = '等了 30 秒新版本还没上线（可能接替失败，看 Logs/restart-child.log）'; return; }
    try {
      const r = await fetch('/api/system-info');
      if (r.ok) {
        const j = await r.json();
        if (j.version === expectVer) { waitVer.value = ''; loadUp(); return; }
      }
    } catch { /* 重启窗口里连接失败是预期 */ }
    setTimeout(poll, 800);
  })();
}
function backupUrl(id) { return '/api/upgrade/backup/' + encodeURIComponent(id) + '/download?token=' + encodeURIComponent(token()); }

// HTTPS 证书（自签名，承教材方案）
const sslS = ref(null);
const sslForm = ref({ cn: '', org: '', san: '', days: 820 });
const sslMsg = ref('');
const sslBusy = ref(false);
async function loadSsl() { sslS.value = await api('/ssl/status'); }
async function genCert() {
  sslBusy.value = true; sslMsg.value = '';
  try {
    const out = await api('/ssl/generate', { method: 'POST', body: { ...sslForm.value, san: sslForm.value.san } });
    sslS.value = out.status;
    sslMsg.value = `已生成 ${out.days} 天证书（SAN: ${[...out.dns, ...out.ips].join('、')}），重启服务后生效`;
  } catch (e) { sslMsg.value = e.message; }
  sslBusy.value = false;
}
const upCert = ref(null);
const upKey = ref(null);
async function pickPem(which, e) { (which === 'cert' ? upCert : upKey).value = (e.target.files && e.target.files[0]) || null; }
async function uploadPair() {
  if (!upCert.value || !upKey.value) { sslMsg.value = '请同时选择 cert.pem 与 key.pem'; return; }
  sslBusy.value = true; sslMsg.value = '';
  try {
    const [cert, key] = [await upCert.value.text(), await upKey.value.text()];
    const out = await api('/ssl/upload', { method: 'POST', body: { cert, key } });
    sslS.value = out.status;
    sslMsg.value = '已替换证书，重启服务后生效';
  } catch (e) { sslMsg.value = e.message; }
  sslBusy.value = false;
}
async function sslRestart() {
  if (!confirm('重启服务以应用新证书？页面会短暂打不开（1~3 秒）。')) return;
  try {
    await api('/ssl/restart', { method: 'POST', body: {} });
    const t0 = Date.now();
    (async function poll() {
      try { const r = await fetch('/api/system-info'); if (r.ok) { await loadSsl(); sslMsg.value = '服务已重启，新证书已生效'; return; } } catch { /* 预期 */ }
      if (Date.now() - t0 > 30000) { sslMsg.value = '等了 30 秒服务还没回来（看 Logs/restart-child.log）'; return; }
      setTimeout(poll, 800);
    })();
  } catch (e) { sslMsg.value = e.message; }
}
function sslFileUrl(which) { return '/api/ssl/file/' + which + '?token=' + encodeURIComponent(token()); }

// 脱敏引擎（v0.3.0 多引擎）：注册表/开关/主引擎或并行/命令/边车地址/探测/试跑
const eng = ref({ config: { mode: 'primary', primary: 'builtin', enabled: {}, commands: {}, sidecar_url: '' }, engines: [] });
const engVisible = ref([]); // hidden 引擎（自检用）不上 UI
const engMsg = ref('');
const engProbing = ref('');
const engTesting = ref('');
const engTest = ref({ id: '', text: '联系人张三，手机 13812345678，邮箱 test@example.com' });
const engTestOut = ref(null);
const KIND_ZH = { builtin: '内置', stdio: '命令行', sidecar: 'Python 边车', tool: '数据工具' };
const CATEGORY_ZH = { text: '文本识别', database: '数据库脱敏', platform: '大数据平台', stats: '统计发布', testdata: '测试数据' };
// 能直接用的（参与文本识别）永远排前面；不能用的数据/统计工具放后面
const engText = computed(() => engVisible.value.filter((e) => e.applicable !== false));
const engTools = computed(() => engVisible.value.filter((e) => e.applicable === false));
async function loadEngines() {
  eng.value = await api('/engines');
  // 能直接用的文本引擎排前面，数据/统计工具排后面（sort 稳定，同组保持注册表顺序）
  engVisible.value = eng.value.engines.filter((e) => !e.hidden)
    .sort((a, b) => (a.applicable === false ? 1 : 0) - (b.applicable === false ? 1 : 0));
}
function engIsOn(e) {
  const c = eng.value.config;
  return c.mode === 'parallel' ? !!c.enabled[e.id] : c.primary === e.id;
}
async function engToggle(e) {
  const c = eng.value.config;
  const enabled = { ...c.enabled };
  if (c.mode === 'parallel') {
    enabled[e.id] = !enabled[e.id];
    await api('/engines/config', { method: 'PUT', body: { mode: c.mode, primary: c.primary, enabled, commands: c.commands, sidecar_url: c.sidecar_url } });
    await loadEngines();
  } else {
    const primary = c.primary === e.id ? 'builtin' : e.id; // 主引擎模式下点卡片=换主引擎，再点一次切回内置
    await api('/engines/config', { method: 'PUT', body: { mode: c.mode, primary, enabled, commands: c.commands, sidecar_url: c.sidecar_url } });
    await loadEngines();
    engMsg.value = primary === 'builtin' ? '已切回内置规则引擎' : `主引擎已切换为 ${e.name}`;
  }
}
async function engSetMode(mode) {
  const c = eng.value.config;
  await api('/engines/config', { method: 'PUT', body: { mode, primary: mode === 'parallel' ? 'builtin' : c.primary, enabled: c.enabled, commands: c.commands, sidecar_url: c.sidecar_url } });
  await loadEngines();
}
async function engSaveCmd(e) {
  const c = eng.value.config;
  const commands = { ...c.commands, [e.id]: e.command };
  try {
    await api('/engines/config', { method: 'PUT', body: { mode: c.mode, primary: c.primary, enabled: c.enabled, commands, sidecar_url: c.sidecar_url } });
    engMsg.value = `${e.name} 命令已保存`;
    await loadEngines();
  } catch (err) { engMsg.value = err.message; }
}
async function engSaveSidecar() {
  const c = eng.value.config;
  try {
    await api('/engines/config', { method: 'PUT', body: { mode: c.mode, primary: c.primary, enabled: c.enabled, commands: c.commands, sidecar_url: c.sidecar_url } });
    engMsg.value = '边车地址已保存';
    await loadEngines();
  } catch (err) { engMsg.value = err.message; }
}
async function engProbe(e) {
  engProbing.value = e.id; engMsg.value = '';
  const r = await api('/engines/probe', { method: 'POST', body: { id: e.id } });
  await loadEngines();
  engMsg.value = r.ok ? `「${e.name}」探测可用 ✓` : `「${e.name}」不可用：${r.error || ''}`;
  engProbing.value = '';
}
async function engDoTest() {
  if (!engTest.value.id) { engTestOut.value = { ok: false, error: '请先选择引擎' }; return; }
  engTesting.value = engTest.value.id;
  engTestOut.value = await api('/engines/test', { method: 'POST', body: engTest.value });
  engTesting.value = '';
}

// 外部引擎依赖安装（v0.4.2）：网页里触发 scripts/engines-setup.mjs，轮询日志
const setup = ref({ running: false, scope: '', started_at: '', finished_at: '', ok: null, exit_code: null, error: '', lines: [], platform: '', arch: '', cli_supported: true });
let setupTimer = null;
const setupElapsed = computed(() => {
  if (!setup.value.started_at) return '';
  const end = setup.value.running ? Date.now() : Date.parse(setup.value.finished_at || Date.now());
  const s = Math.max(0, Math.round((end - Date.parse(setup.value.started_at)) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
});
function stopSetupPolling() {
  if (setupTimer) { clearInterval(setupTimer); setupTimer = null; }
}
function startSetupPolling() {
  if (setupTimer) return;
  setupTimer = setInterval(async () => {
    try {
      const s = await api('/engines/setup/status');
      setup.value = s;
      if (!s.running) {
        stopSetupPolling();
        await loadEngines();
        engMsg.value = s.ok ? '外部引擎依赖安装完成，点对应引擎的「探测」验证' : `安装失败：${s.error || '看下方日志'}`;
      }
    } catch { /* 网络抖动，下一拍再试 */ }
  }, 1500);
}
async function loadSetupStatus() {
  setup.value = await api('/engines/setup/status');
  if (setup.value.running) startSetupPolling();
}
async function startSetup(scope) {
  const sizeZh = scope === 'cli' ? '命令行引擎（JDK + Go + Maven + godlp + sensitive-word），下载约 500MB~1GB，通常 5~15 分钟'
    : scope === 'python' ? 'Python 引擎（pip 依赖 + 两个模型），数 GB，可能十几分钟到半小时'
      : '全部外部引擎（命令行 + Python），数 GB，时间较长';
  if (!confirm(`开始安装${sizeZh}。\n\n安装期间请勿关闭容器；进度和错误会实时显示在下方。继续？`)) return;
  try {
    setup.value = await api('/engines/setup', { method: 'POST', body: { scope } });
    engMsg.value = '';
    startSetupPolling();
  } catch (e) { engMsg.value = e.message; }
}

// 致谢（探测成功的外部引擎）
const ackItems = ref([]);
async function loadAck() { ackItems.value = (await api('/engines/ack')).items; }

async function loadEnginesTab() {
  await loadEngines();
  try { await loadSetupStatus(); } catch { /* 状态接口失败不影响引擎列表 */ }
}
const loadByTab = { logs: loadLogs, blacklist: loadBlacklist, ai: loadAi, engines: loadEnginesTab, ack: loadAck, upgrade: loadUp, ssl: loadSsl, system: loadSys };
function switchTab(id) { tab.value = id; loadByTab[id](); }
onUnmounted(stopSetupPolling);
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

    <div v-else-if="tab === 'engines'" class="card">
      <div style="border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-bottom:16px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <b>外部引擎依赖</b>
          <span class="tag">按需安装</span>
          <span style="flex:1"></span>
          <button class="btn sm primary" :disabled="setup.running || !setup.cli_supported" @click="startSetup('cli')">安装命令行引擎</button>
          <button class="btn sm" :disabled="setup.running" @click="startSetup('python')">安装 Python 引擎</button>
          <button class="btn sm" :disabled="setup.running" @click="startSetup('all')">全部安装</button>
        </div>
        <p class="mut" style="margin:6px 0 0;font-size:12px">
          点按钮会在本机运行项目自带的安装器（<code>scripts/engines-setup.mjs</code>）联网拉依赖：命令行引擎 = JDK + Go + Maven 现场编译 godlp / sensitive-word（约 500MB~1GB）；
          Python 引擎 = pip 依赖 + GLiNER / OPF 模型（数 GB）。已装好的部分自动跳过，重复点不会重下。
          原文与模型都只在这台机器上。
        </p>
        <p v-if="!setup.cli_supported" class="mut" style="margin:6px 0 0;font-size:12px">
          当前平台（{{ setup.platform || '未知' }}）不会自动构建命令行引擎：macOS 目前只支持安装 Python 引擎；godlp / sensitive-word 需要自行准备 JDK/Go/Maven 后在卡片里改命令。
        </p>
        <p class="mut" style="margin:4px 0 0;font-size:12px">
          Docker：安装结果在容器内部，<b>容器重建会丢</b>；要保留请把 <code>vendor/</code>、<code>python/vendor</code>、<code>python/models</code> 挂成宿主机卷（部署说明里有示例）。已经是 v0.4.1+ 镜像时，godlp 与 sensitive-word 已内置，无需再装。
        </p>
        <div v-if="setup.running || setup.lines.length" style="margin-top:10px">
          <p style="margin:0 0 6px;font-size:12.5px" :class="setup.running ? '' : (setup.ok ? 'mut' : 'err')">
            <template v-if="setup.running">安装中（{{ setup.scope }}）… 已用 {{ setupElapsed }}</template>
            <template v-else-if="setup.ok">上次安装成功（{{ setup.scope }}，用时 {{ setupElapsed }}）</template>
            <template v-else>上次安装失败：{{ setup.error }}（退出码 {{ setup.exit_code }}）</template>
            <span v-if="setup.log_file" class="mut"> · 日志 {{ setup.log_file }}</span>
          </p>
          <pre style="margin:0;padding:8px 10px;max-height:220px;overflow:auto;background:rgba(127,127,127,.08);border-radius:6px;font-size:11.5px;line-height:1.45;white-space:pre-wrap">{{ setup.lines.join('\n') }}</pre>
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
        <b>工作模式</b>
        <button class="btn sm" :class="{ primary: eng.config.mode === 'primary' }" @click="engSetMode('primary')">主引擎（单选）</button>
        <button class="btn sm" :class="{ primary: eng.config.mode === 'parallel' }" @click="engSetMode('parallel')">并行使用（并集）</button>
        <span class="mut" style="font-size:12px">{{ eng.config.mode === 'primary' ? '只有主引擎负责识别（内置引擎让位）；点卡片换主引擎' : '勾选的引擎一起识别，结果合并去重；内置引擎始终参与' }}</span>
      </div>
      <p v-if="engMsg" :class="engMsg.includes('不可用') || engMsg.includes('失败') ? 'err' : 'mut'" style="margin:4px 0 10px;font-size:13px">{{ engMsg }}</p>

      <p class="mut" style="font-size:12.5px;margin:10px 0 8px">
        <b>可直接用于文本脱敏</b>（参与聊天与文档识别，依赖已随项目装好，点「探测」即验证）：
      </p>
      <div v-for="e in engText" :key="e.id" style="border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input v-if="eng.config.mode === 'parallel'" type="checkbox" :checked="engIsOn(e)" @change="engToggle(e)" />
          <b :style="eng.config.mode === 'primary' && eng.config.primary === e.id ? 'color:var(--acc)' : ''">{{ e.name }}</b>
          <span class="tag">{{ KIND_ZH[e.kind] || e.kind }}</span>
          <span class="mut" style="font-size:12px">{{ e.vendor }}</span>
          <span v-if="eng.config.mode === 'primary' && eng.config.primary === e.id" class="tag ok">当前主引擎</span>
          <span style="flex:1"></span>
          <span v-if="e.last_probe" class="mut" style="font-size:12px">{{ e.last_probe.ok ? '探测可用 ✓ ' + (e.last_probe.at || '').slice(0, 16).replace('T', ' ') : '探测失败 ✗' }}</span>
          <button v-if="e.kind !== 'builtin'" class="btn sm" :disabled="engProbing === e.id" @click="engProbe(e)">{{ engProbing === e.id ? '探测中…' : '探测' }}</button>
          <button v-if="eng.config.mode === 'primary' && !(e.id === 'builtin' && eng.config.primary === 'builtin')" class="btn sm" @click="engToggle(e)">
            {{ eng.config.primary === e.id ? '切回内置' : '设为主引擎' }}</button>
        </div>
        <p class="mut" style="margin:6px 0 0;font-size:12px">
          {{ e.desc }}
          <template v-if="e.home">· <a :href="e.home" target="_blank" rel="noopener">仓库</a></template>
          <template v-if="e.license && e.kind !== 'builtin'">· 许可证 {{ e.license }}</template>
        </p>
        <p v-if="e.last_probe && !e.last_probe.ok" class="err" style="margin:4px 0 0;font-size:12px;white-space:pre-wrap">{{ e.last_probe.error }}</p>
        <div v-if="e.kind === 'stdio'" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <input v-model="e.command" style="flex:1;min-width:260px;font-size:12px" placeholder="命令（stdin 进文本，stdout 出实体 JSON）" />
          <button class="btn sm" @click="engSaveCmd(e)">保存命令</button>
        </div>
      </div>

      <div style="border-top:1px solid var(--bd);margin:14px 0 10px"></div>
      <p class="mut" style="font-size:12.5px;margin:0 0 8px">
        <b>不能用于文本脱敏</b>（随项目源码归档在 <code>vendor/engines-src/</code>）：它们产出的是「整张表/整个库」的脱敏数据，不是文本里的实体坐标，
        所以进不了聊天与文档的识别管线。各自什么时候用得着，见每张卡片下的说明：
      </p>
      <div v-for="e in engTools" :key="e.id" style="border:1px dashed var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:8px;opacity:.85">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <b>{{ e.name }}</b>
          <span class="tag">{{ CATEGORY_ZH[e.category] || '数据工具' }}</span>
          <span class="mut" style="font-size:12px">{{ e.vendor }}</span>
          <span style="flex:1"></span>
          <span class="tag warn">不参与文本识别</span>
        </div>
        <p class="mut" style="margin:4px 0 0;font-size:12px">
          {{ e.desc }}
          <template v-if="e.home">· <a :href="e.home" target="_blank" rel="noopener">仓库</a></template>
          <template v-if="e.license">· 许可证 {{ e.license }}</template>
        </p>
        <p v-if="e.use" style="margin:4px 0 0;font-size:12px;color:var(--acc)">什么时候用：{{ e.use }}</p>
      </div>

      <div style="border-top:1px solid var(--bd);margin:14px 0 10px"></div>
      <label class="mut">Python 边车地址（Presidio / GLiNER-PII / argus-redact / scrubadub / OpenAI Privacy Filter 走它；主服务启动时会自动拉起，一般不用手开）</label>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
        <input v-model="eng.config.sidecar_url" style="width:280px" placeholder="http://127.0.0.1:9812" />
        <button class="btn sm" @click="engSaveSidecar">保存地址</button>
        <button class="btn sm" @click="eng.config.sidecar_url = 'http://127.0.0.1:9812'">用默认 9812</button>
      </div>
      <p class="mut" style="margin:6px 0 0;font-size:12px">
        边车 = 主服务旁边常驻的一个独立 Python 进程（默认端口 <code>9812</code>）：Python 引擎的模型只加载一次、常驻内存，主服务每次识别走本机 HTTP 问它。
        它只监听本机回环地址，原文不出机器。<b>不要填本系统自己的 9909</b>——那会把本系统的网页当成边车，探测只会报「响应异常（HTTP 200）」。
      </p>

      <div style="border-top:1px solid var(--bd);margin:14px 0 10px"></div>
      <label class="mut">单引擎试跑（不落库、不产生对照）</label>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
        <select v-model="engTest.id">
          <option value="">选择引擎…</option>
          <option v-for="e in engText" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
        <input v-model="engTest.text" style="flex:1;min-width:240px" placeholder="试跑文本" />
        <button class="btn sm" :disabled="!!engTesting" @click="engDoTest">{{ engTesting ? '运行中…' : '运行' }}</button>
      </div>
      <div v-if="engTestOut" style="margin-top:10px">
        <template v-if="engTestOut.ok">
          <table class="tbl">
            <thead><tr><th>实体</th><th>原始类型</th><th>映射为</th><th>坐标</th></tr></thead>
            <tbody>
              <tr v-for="(c, i) in engTestOut.candidates" :key="i">
                <td>{{ c.term }}</td><td class="mut">{{ c.ext_type }}</td><td>{{ c.key }}</td><td class="mut">{{ c.start }}–{{ c.end }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!engTestOut.candidates.length" class="mut">0 个实体</p>
        </template>
        <p v-else class="err">{{ engTestOut.error }}</p>
      </div>
      <p class="mut" style="font-size:12px;margin-top:10px">红线：所有引擎都在本机运行，原文不出网；引擎失败会如实报错、不会假装脱敏成功。项目引用的开源引擎都会出现在「致谢」页。</p>
    </div>

    <div v-else-if="tab === 'ack'" class="card">
      <p class="mut" style="margin:0 0 12px;font-size:13px">系统引用了的开源引擎在此致谢——谢谢它们让脱敏更准。状态一栏只是「这台机器上是否配置可用」，不影响致谢。</p>
      <div v-if="!ackItems.length" class="empty">（无外部引擎引用）</div>
      <div v-for="(a, i) in ackItems" :key="i" style="border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <b>{{ a.name }}</b><span class="mut">{{ a.vendor }}</span>
          <span class="tag">{{ CATEGORY_ZH[a.category] || '文本识别' }}</span>
          <span style="flex:1"></span>
          <template v-if="a.applicable !== false">
            <span v-if="a.probe && a.probe.ok" class="tag ok">可用 ✓ {{ (a.probe.at || '').slice(0, 16).replace('T', ' ') }}</span>
            <span v-else-if="a.probe" class="tag danger">探测失败</span>
            <span v-else class="tag">未探测（装好后在「引擎」页点探测）</span>
          </template>
          <span v-else class="tag warn">不参与文本识别</span>
        </div>
        <p class="mut" style="margin:4px 0 0;font-size:12px">
          <a v-if="a.home" :href="a.home" target="_blank" rel="noopener">{{ a.home }}</a>
          <template v-if="a.license"> · 许可证 {{ a.license }}</template>
        </p>
        <p class="mut" style="margin:4px 0 0;font-size:12px">{{ a.desc }}</p>
        <p v-if="a.probe && !a.probe.ok && a.probe.error" class="err" style="margin:4px 0 0;font-size:12px;white-space:pre-wrap">{{ a.probe.error }}</p>
      </div>
    </div>

    <div v-else-if="tab === 'upgrade'" class="card">
      <p class="mut" style="font-size:12.5px;margin-bottom:12px">
        当前运行 <b>v{{ up.current_version }}</b> · 磁盘 package.json <b>v{{ up.package_json_version }}</b>
        · 前端目录 {{ up.latest_dist || '（无）' }}（{{ up.dist_dirs.length }} 份）
        <span v-if="up.current_version && up.package_json_version && up.current_version !== up.package_json_version" class="err">（文件已换但进程没重启）</span>
        <span v-if="up.restart_pending" class="err">⚠️ 上次重启没有完成交接</span>
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <input type="file" accept=".zip" style="max-width:320px" @change="pickUpFile" />
        <button class="btn primary sm" :disabled="!upFile || planning" @click="doPlan">{{ planning ? '预检中…' : '预检（只读）' }}</button>
        <button v-if="plan" class="btn sm" :disabled="applying || !planToken" @click="doApply">{{ applying ? '应用中…' : '应用升级' }}</button>
        <span v-if="waitVer" class="mut">等待 v{{ waitVer }} 上线…（重启窗口里页面会短暂打不开）</span>
      </div>
      <p v-if="planErr" class="err">{{ planErr }}</p>

      <div v-if="plan" style="border:1px solid var(--bd);border-radius:8px;padding:12px;margin-bottom:14px">
        <p style="margin:0 0 8px"><b>预检通过</b>：v{{ plan.version.current }} → <b>v{{ plan.version.incoming }}</b>
          <span v-if="plan.version.downgrade" class="err">（降级！）</span>
          · {{ plan.summary.files_total }} 个文件（新增 {{ plan.summary.add }} / 覆盖 {{ plan.summary.overwrite }} / 跳过 {{ plan.summary.skip }}）
          · {{ fmtKB(plan.summary.bytes_zip) }} · 前端目录 {{ plan.summary.dist_dir || '（不变）' }}</p>
        <p style="margin:0 0 8px" class="mut">需要重启：{{ plan.restart_required ? '是（动了 server/ 或 package.json）' : '否（纯前端，下一次请求生效）' }}
          <span v-if="plan.summary.dep_changed" class="err">· ⚠️ 依赖有变化</span></p>
        <p v-for="(w, i) in plan.warnings" :key="i" class="err" style="margin:4px 0;font-size:12.5px">⚠️ {{ w }}</p>
        <p class="mut" style="font-size:12px;margin:8px 0 0">预检不写盘；「应用」才会落盘（自动备份被覆盖的文件到 data/upgrades/backup_*，可下载回滚）。</p>
      </div>

      <div v-if="applyOut" style="border:1px solid var(--bd);border-radius:8px;padding:12px;margin-bottom:14px">
        <p style="margin:0 0 6px"><b>{{ applyOut.restart === 'scheduled' ? '已应用，正在接替重启' : '已应用' }}</b>：v{{ applyOut.version.from }} → v{{ applyOut.version.to }}
          · 写入 {{ applyOut.files_written.total }}（覆盖 {{ applyOut.files_written.overwrite.length }} / 新增 {{ applyOut.files_written.add.length }} / 跳过 {{ applyOut.files_written.skipped.length }}）</p>
        <p class="mut" style="margin:0">{{ applyOut.restart_note }}</p>
        <p v-if="applyOut.backup_dir" class="mut" style="margin:6px 0 0">
          备份 <a :href="backupUrl(applyOut.backup_dir.split(/[\\/]/).pop())">下载回滚材料</a>（{{ applyOut.backup_dir }}）
        </p>
      </div>

      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th>时间</th><th>操作人</th><th>版本</th><th>文件</th><th>重启</th><th>结果</th><th>备份</th></tr></thead>
          <tbody>
            <tr v-for="L in upLogs" :key="L.id">
              <td style="white-space:nowrap" class="mut">{{ L.created_at }}</td>
              <td>{{ L.actor || '—' }}</td>
              <td>v{{ L.to_version || '?' }}</td>
              <td class="mut">+{{ L.files_added ?? 0 }} ~{{ L.files_overwritten ?? 0 }}</td>
              <td class="mut">{{ L.restarted ? '是' : (L.restart_suppressed ? '抑制' : '否') }}</td>
              <td><span class="tag" :class="L.ok ? 'ok' : 'danger'">{{ L.ok ? '成功' : '失败' }}</span></td>
              <td><a v-if="L.backup_dir" :href="backupUrl(L.backup_dir)">下载</a><span v-else class="mut">—</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!upLogs.length" class="empty">还没有升级记录</div>
      <p class="mut" style="font-size:12px;margin-top:10px">诚实边界：不删旧文件、不更新 node_modules（依赖变化会被预检拦下要求人工确认）、升级包只认白名单路径（server/**.js、web/dist/&lt;时间戳&gt;/**、package.json）。</p>
    </div>

    <div v-else-if="tab === 'ssl'" class="card" style="max-width:680px">
      <div v-if="!sslS" class="empty">加载中…</div>
      <template v-else>
        <p style="margin:0 0 12px" v-if="!sslS.configured" class="mut">尚未配置证书：生成或上传一对 cert/key 后，重启服务即可在<b>同一端口</b>同时提供 HTTP 与 HTTPS（浏览器会提示不受信任，导入证书后可消除）。</p>
        <div v-else style="border:1px solid var(--bd);border-radius:8px;padding:12px;margin-bottom:14px;font-size:13px">
          <p style="margin:0 0 6px"><b>当前证书</b>：{{ sslS.subject || '—' }}</p>
          <p class="mut" style="margin:0 0 6px">有效期 {{ sslS.valid_from?.slice(0, 10) }} → {{ sslS.valid_to?.slice(0, 10) }}（剩 {{ sslS.days_left }} 天）
            <span v-if="sslS.days_left <= sslS.remind_days" class="err">⚠️ 30 天内到期，建议换新</span></p>
          <p class="mut" style="margin:0 0 6px">SAN：{{ sslS.san || '—' }} · 密钥匹配：{{ sslS.key_matches === null ? '（缺私钥）' : (sslS.key_matches ? '是' : '否') }}</p>
          <p v-if="sslS.error" class="err" style="margin:0">{{ sslS.error }}</p>
          <p v-if="sslS.pending_restart" class="err" style="margin:0">⚠️ 证书已替换但服务还没重启，对外仍是旧证书</p>
        </div>

        <label class="mut">通用名称 CN（必填，域名/主机名，如 mask.example.com）</label>
        <input v-model="sslForm.cn" style="width:100%;margin:4px 0 10px" placeholder="mask.example.com" />
        <label class="mut">组织 O（可选）</label>
        <input v-model="sslForm.org" style="width:100%;margin:4px 0 10px" placeholder="in1912" />
        <label class="mut">附加 SAN（可选，逗号/空格分隔，域名或 IP 混填；CN、localhost、127.0.0.1 自动包含）</label>
        <input v-model="sslForm.san" style="width:100%;margin:4px 0 10px" placeholder="192.168.1.10, mask.lan" />
        <label class="mut">有效天数（1 ~ {{ sslS.max_days }}，默认 820；Chrome/苹果对自签名证书的信任上限是 825 天）</label>
        <input v-model.number="sslForm.days" type="number" min="1" :max="sslS.max_days" style="width:140px;margin:4px 0 12px" />
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" :disabled="sslBusy" @click="genCert">{{ sslBusy ? '生成中…' : '生成并替换' }}</button>
          <a v-if="sslS.cert_file?.exists" class="btn" :href="sslFileUrl('cert')">下载证书 cert.pem</a>
          <a v-if="sslS.key_file?.exists" class="btn" :href="sslFileUrl('key')">下载私钥 key.pem（勿分发）</a>
          <button v-if="sslS.configured" class="btn" @click="sslRestart">重启服务生效</button>
        </div>

        <div style="border-top:1px solid var(--bd);margin:16px 0 12px"></div>
        <label class="mut">上传替换（外部工具生成的证书 + 私钥，需成对且公钥匹配）</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0 8px">
          <input type="file" accept=".pem,.crt,.key" style="max-width:240px" @change="pickPem('cert', $event)" />
          <input type="file" accept=".pem,.crt,.key" style="max-width:240px" @change="pickPem('key', $event)" />
          <button class="btn sm" :disabled="sslBusy" @click="uploadPair">上传替换</button>
        </div>
        <p v-if="sslMsg" :class="sslMsg.includes('失败') || sslMsg.includes('⚠') ? 'err' : ''" style="margin-top:8px">{{ sslMsg }}</p>
        <p class="mut" style="font-size:12px;margin-top:10px">旧证书替换时自动备份到 data/ssl/backup-&lt;时间戳&gt;/。证书与私钥永不进升级包（data/ 在白名单外）。</p>
      </template>
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
