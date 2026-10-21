<script setup>
// 脱敏引擎（v1.00）：从「系统设置 → 引擎」拆成一级目录，管理员专属。
// 内容与原来一致：外部引擎依赖安装 / 工作模式 / 引擎卡片 / 探测 / 试跑 / 边车地址。
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import RulesPanel from './Rules.vue';

// v1.03：第二个页签「内置引擎参数配置」= 原一级菜单「规则配置」整块迁入
const TABS = [
  { id: 'engine', label: '引擎与依赖' },
  { id: 'rules', label: '内置引擎参数配置' }
];
const tab = ref(localStorage.getItem('mask_eng_tab') === 'rules' ? 'rules' : 'engine');
function switchTab(id) {
  tab.value = id;
  localStorage.setItem('mask_eng_tab', id);
}

const eng = ref({ config: { mode: 'primary', primary: 'builtin', enabled: {}, commands: {}, sidecar_url: '' }, engines: [] });
const engVisible = ref([]); // hidden 引擎（自检用）不上 UI
const engMsg = ref('');
const engMsgErr = ref(false);
const engProbing = ref('');
const engTesting = ref('');
const engTest = ref({ id: '', text: '联系人张三，手机 13812345678，邮箱 test@example.com' });
const engTestOut = ref(null);
const KIND_ZH = { builtin: '内置', stdio: '命令行', sidecar: 'Python 边车', tool: '数据工具' };
const CATEGORY_ZH = { text: '文本识别', database: '数据库脱敏', platform: '大数据平台', stats: '统计发布', testdata: '测试数据' };
// 能直接用的（参与文本识别）永远排前面；不能用的数据/统计工具放后面
const engText = computed(() => engVisible.value.filter((e) => e.applicable !== false));
const engTools = computed(() => engVisible.value.filter((e) => e.applicable === false));
const primaryName = computed(() => {
  if (eng.value.config.mode === 'parallel') return '并行使用（并集）';
  const p = engVisible.value.find((e) => e.id === eng.value.config.primary);
  return p ? p.name : (eng.value.config.primary || '内置规则引擎');
});

function say(msg, isErr = false) { engMsg.value = msg; engMsgErr.value = isErr; }

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
async function putConfig(patch) {
  const c = eng.value.config;
  await api('/engines/config', {
    method: 'PUT',
    body: { mode: c.mode, primary: c.primary, enabled: c.enabled, commands: c.commands, sidecar_url: c.sidecar_url, ...patch }
  });
  await loadEngines();
}
// 并行模式下的勾选（内置引擎始终参与，不显示勾选框）
async function engToggle(e) {
  const enabled = { ...eng.value.config.enabled, [e.id]: !eng.value.config.enabled[e.id] };
  await putConfig({ enabled });
}
// 设为主引擎：内置引擎也走这一条（v1.00 用户要求，所有文本引擎都能一键设为主引擎）
async function engSetPrimary(e) {
  try {
    await putConfig({ mode: 'primary', primary: e.id });
    say(`主引擎已切换为「${e.name}」`);
  } catch (err) { say(err.message, true); }
}
async function engSwitchMode(mode) {
  try {
    await putConfig({ mode, primary: mode === 'parallel' ? 'builtin' : eng.value.config.primary });
    say(mode === 'parallel' ? '已切换为并行使用：勾选的引擎一起识别' : `已切换为主引擎模式：当前「${primaryName.value}」`);
  } catch (err) { say(err.message, true); }
}
async function engSaveCmd(e) {
  try {
    await putConfig({ commands: { ...eng.value.config.commands, [e.id]: e.command } });
    say(`${e.name} 命令已保存`);
  } catch (err) { say(err.message, true); }
}
async function engSaveSidecar() {
  try {
    await putConfig({ sidecar_url: eng.value.config.sidecar_url });
    say('边车地址已保存');
  } catch (err) { say(err.message, true); }
}
async function engProbe(e) {
  engProbing.value = e.id; engMsg.value = '';
  const r = await api('/engines/probe', { method: 'POST', body: { id: e.id } });
  await loadEngines();
  say(r.ok ? `「${e.name}」探测可用 ✓` : `「${e.name}」不可用：${r.error || ''}`, !r.ok);
  engProbing.value = '';
}
async function engDoTest() {
  if (!engTest.value.id) { engTestOut.value = { ok: false, error: '请先选择引擎' }; return; }
  engTesting.value = engTest.value.id;
  engTestOut.value = await api('/engines/test', { method: 'POST', body: engTest.value });
  engTesting.value = '';
}

// 外部引擎依赖安装：网页里触发 scripts/engines-setup.mjs，轮询日志
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
        say(s.ok ? '外部引擎依赖安装完成，点对应引擎的「探测」验证' : `安装失败：${s.error || '看下方日志'}`, !s.ok);
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
  } catch (e) { say(e.message, true); }
}

const forbidden = ref('');
onMounted(async () => {
  try {
    await loadEngines();
    try { await loadSetupStatus(); } catch { /* 状态接口失败不影响引擎列表 */ }
  } catch (e) { forbidden.value = e.message; }
});
onUnmounted(stopSetupPolling);
</script>

<template>
  <div style="max-width:1020px">
    <div class="page-title">脱敏引擎</div>
    <div v-if="forbidden" class="card empty">{{ forbidden }}</div>
    <template v-else>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        <button v-for="t in TABS" :key="t.id" class="btn sm" :class="{ primary: tab === t.id }" @click="switchTab(t.id)">{{ t.label }}</button>
      </div>

      <template v-if="tab === 'engine'">
      <p class="mut" style="margin:-4px 0 14px;font-size:13px">
        当前：<b>{{ eng.config.mode === 'parallel' ? '并行使用' : '主引擎' }}</b> · {{ primaryName }}
        <span v-if="eng.config.mode === 'parallel'" class="mut">（勾选的引擎结果合并去重）</span>
      </p>

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
        <button class="btn sm" :class="{ primary: eng.config.mode === 'primary' }" @click="engSwitchMode('primary')">主引擎（单选）</button>
        <button class="btn sm" :class="{ primary: eng.config.mode === 'parallel' }" @click="engSwitchMode('parallel')">并行使用（并集）</button>
        <span class="mut" style="font-size:12px">{{ eng.config.mode === 'primary' ? '只有主引擎负责识别（内置引擎让位）；点「设为主引擎」切换' : '勾选的引擎一起识别，结果合并去重；内置引擎始终参与' }}</span>
      </div>
      <p v-if="engMsg" :class="engMsgErr ? 'err' : 'mut'" style="margin:4px 0 10px;font-size:13px;white-space:pre-wrap">{{ engMsg }}</p>

      <p class="mut" style="font-size:12.5px;margin:10px 0 8px">
        <b>可直接用于文本脱敏</b>（参与聊天与文档识别，依赖已随项目装好，点「探测」即验证）：
      </p>
      <div v-for="e in engText" :key="e.id" style="border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input v-if="eng.config.mode === 'parallel' && e.kind !== 'builtin'" type="checkbox" :checked="engIsOn(e)" @change="engToggle(e)" />
          <b :style="eng.config.mode === 'primary' && eng.config.primary === e.id ? 'color:var(--acc)' : ''">{{ e.name }}</b>
          <span class="tag">{{ KIND_ZH[e.kind] || e.kind }}</span>
          <span class="mut" style="font-size:12px">{{ e.vendor }}</span>
          <span v-if="eng.config.mode === 'primary' && eng.config.primary === e.id" class="tag ok">当前主引擎</span>
          <span style="flex:1"></span>
          <span v-if="e.last_probe" class="mut" style="font-size:12px">{{ e.last_probe.ok ? '探测可用 ✓ ' + (e.last_probe.at || '').slice(0, 16).replace('T', ' ') : '探测失败 ✗' }}</span>
          <button v-if="e.kind !== 'builtin'" class="btn sm" :disabled="engProbing === e.id" @click="engProbe(e)">{{ engProbing === e.id ? '探测中…' : '探测' }}</button>
          <button v-if="eng.config.mode !== 'primary' || eng.config.primary !== e.id" class="btn sm" @click="engSetPrimary(e)">设为主引擎</button>
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
      <p class="mut" style="font-size:12px;margin-top:10px">红线：所有引擎都在本机运行，原文不出网；引擎失败会如实报错、不会假装脱敏成功。项目引用的开源引擎都会出现在「系统设置 → 致谢」页。</p>
      </template>
      <RulesPanel v-else />
    </template>
  </div>
</template>
