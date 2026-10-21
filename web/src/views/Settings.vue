<script setup>
import { ref, onMounted } from 'vue';
import { api, token } from '../api.js';

const tab = ref('logs');
const TABS = [
  { id: 'logs', label: '登录日志' },
  { id: 'blacklist', label: 'IP 黑名单' },
  { id: 'ai', label: 'AI 配置' },
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

// 致谢（探测成功的外部引擎）
const CATEGORY_ZH = { text: '文本识别', database: '数据库脱敏', platform: '大数据平台', stats: '统计发布', testdata: '测试数据' };
const ackItems = ref([]);
async function loadAck() { ackItems.value = (await api('/engines/ack')).items; }

const loadByTab = { logs: loadLogs, blacklist: loadBlacklist, ai: loadAi, ack: loadAck, upgrade: loadUp, ssl: loadSsl, system: loadSys };
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
            <span v-else class="tag">未探测（装好后在「脱敏引擎」页点探测）</span>
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
