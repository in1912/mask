// 在线升级（承游巷 v1.11.0 方案，按面具收窄）：管理员在设置页上传一个 zip 升级包，
// 服务端预检 → 落盘 → 备份 → 自动重启。
//
// 三条设计前提（与游巷相同）：
//  1. 面具的包很小（server/ + web/dist/<ts> 都在百 KB 级），所以**整份打包**，不做逐文件差分——
//     多带几个文件不值得省，漏带一个文件才是事故。
//  2. latestDist() 每个静态请求现算（server/index.js），所以**只换前端的包压根不用重启**。
//     只有动了 server/** 或 package.json 才需要重启（重启 = 老的先退、新的抢端口，见 restartService）。
//  3. 仓库根在自检里会被指到临时副本，所以目录一律从 MASK_UPGRADE_ROOT / MASK_WEB_ROOT 现读，
//     绝不写死 __dirname —— 否则跑一次自检就会把开发机的真实 server/ 换掉。
//
// 与游巷的两处收窄：面具没有「生成中」的长任务（SSE 聊天断线由客户端如实报错），所以没有
// BUSY_GENERATION 检查；upgrade_logs 表结构简单（id/at/version/action/detail/ok），明细整体塞 detail JSON。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { extractZip } = require('./zipService');
const { db, DATA_DIR, getSetting } = require('../db');
const restartService = require('./restartService');

const ROOT = process.env.MASK_UPGRADE_ROOT || path.join(__dirname, '..', '..');
const WEB_ROOT = process.env.MASK_WEB_ROOT || path.join(ROOT, 'web');
const MAX_UPLOAD_MB = Number(process.env.MASK_UPGRADE_MAX_MB) || 64; // 与反代 client_max_body_size 同口径
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const TOKEN_TTL_MS = 10 * 60 * 1000;

const R = (p) => path.join(ROOT, p);

class UpgradeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------- 小工具 ----------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sleepSync(ms) {
  // 同步睡：阶段 B 的重试要在「同一个 tick」里做完（中间不能让别的请求看见半新半旧的目录）
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function distDirs() {
  const dir = path.join(WEB_ROOT, 'dist');
  if (!fs.existsSync(dir)) return [];
  // 排序口径必须和 index.js 的 latestDist() 完全一致（纯数字名 + 字典序最大值），不许按 mtime
  return fs.readdirSync(dir).filter((n) => /^\d{8,}$/.test(n) && fs.statSync(path.join(dir, n)).isDirectory()).sort();
}
const latestDistName = () => { const a = distDirs(); return a.length ? a[a.length - 1] : ''; };

function runningVersion() {
  // require 缓存里的那份 = **当前进程真正在跑的代码**的版本（和 /api/system-info 同源）
  try { return require('../../package.json').version || ''; } catch { return ''; }
}
function diskVersion() {
  // 磁盘上 package.json 的版本：和 runningVersion 不一致就说明「文件换了但进程没重启」——这正是重启后要盯的信号
  try { return JSON.parse(fs.readFileSync(R('package.json'), 'utf8')).version || ''; } catch { return ''; }
}
function diskFileVersion(p) { // 从包内 package.json 文本取版本（不落盘）
  try { return JSON.parse(p.toString('utf8')).version || ''; } catch { return ''; }
}

// ---------- 路径安全（白名单 + 段级双重校验） ----------
// 段级：任何形式的「跳出仓库」和「Windows 上会出事的名字」直接拒
function validateEntryName(name) {
  if (/^data(\/|$)/i.test(name)) {
    return { code: 'FORBIDDEN_PATH', msg: `升级包绝不允许写 data/（库、密钥、SSL 证书都在里面）：${name}` };
  }
  if (name.length > 300) return { code: 'PATH_TRAVERSAL', msg: `包内条目路径过长（>300）：${name.slice(0, 60)}…` };
  if (name.includes('\\')) return { code: 'PATH_TRAVERSAL', msg: `包内条目用的是反斜杠分隔符（应为 /）：${name}` };
  if (/^[A-Za-z]:/.test(name)) return { code: 'PATH_TRAVERSAL', msg: `包内条目是盘符绝对路径：${name}` };
  if (name.startsWith('/')) return { code: 'PATH_TRAVERSAL', msg: `包内条目是绝对路径：${name}` };
  const segs = name.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    return { code: 'PATH_TRAVERSAL', msg: `包内条目含空段或 . / ..（试图跳出仓库）：${name}` };
  }
  if (/[\x00-\x1f\x7f]/.test(name)) return { code: 'PATH_TRAVERSAL', msg: `包内条目含控制字符：${JSON.stringify(name)}` };
  if (/[:|?*"<>]/.test(name)) return { code: 'PATH_TRAVERSAL', msg: `包内条目含 Windows 非法字符 :|?*"<>：${name}` };
  if (/[^\x00-\x7F]/.test(name)) {
    return { code: 'NON_ASCII', msg: `包内条目含非 ASCII 字符（打包器要用 UTF-8 名）：${name}` };
  }
  return null;
}
const DIST_RE = /^web\/dist\/(\d{8,})\/(.+)$/;

// 白名单：只认这四类能落盘，其余一律 NOT_ALLOWED
function classify(name) {
  if (name === 'manifest.json') return { action: 'skip', kind: 'manifest', note: '包内清单：只做校验，不落盘' };
  if (name === 'package.json') return { action: 'write', kind: 'pkg' };
  if (name === 'web/dist/.latest') return { action: 'write', kind: 'latest' };
  const m = DIST_RE.exec(name);
  if (m) return { action: 'write', kind: 'dist', dist: m[1] };
  if (/^server\/.*\.js$/.test(name)) return { action: 'write', kind: 'server' };
  return {
    action: 'reject',
    code: 'NOT_ALLOWED',
    msg: `包内条目不在升级白名单里（只允许 server/**.js、web/dist/<时间戳>/**、web/dist/.latest、package.json）：${name}`,
  };
}

// require 扫描前先剥注释：注释里写的模块名曾被当成真引用（v0.4.2 实测，zipService 头注释
// 里一句「绝不引入同目录 db 模块」就触发了假警告）。只保留代码字符，字符串原样留下。
// 注意：本文件也会被打进升级包，被旧版（未剥注释的）扫描器扫描——所以这里的注释也不要
// 出现完整的 require 调用字面量，否则旧版升级到本版时仍会报同一条假警告。
function stripComments(code) {
  let out = '', i = 0, quote = '';
  const n = code.length;
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (d || ''); i += 2; continue; }
      if (c === quote) quote = '';
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2; out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

// ---------- 预检 ----------
let busy = false;      // 单飞：同一时刻只允许一个预检/应用在跑
let pendingPlan = null; // {token, buf, plan, at} —— 全局只留一份（apply 不二次上传，也杜绝「预检 A 包、应用 B 包」）

function parseManifest(buf) {
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch (e) {
    throw new UpgradeError(400, 'BAD_MANIFEST', '包内 manifest.json 不是合法 JSON：' + e.message);
  }
  if (!m || typeof m !== 'object') throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.json 不是对象');
  if (m.app !== 'mask') throw new UpgradeError(400, 'BAD_MANIFEST', `manifest.json 的 app 应为 mask，实际是 ${JSON.stringify(m.app)}——这不是面具的升级包`);
  if (m.kind !== 'upgrade-pack') throw new UpgradeError(400, 'BAD_MANIFEST', `manifest.json 的 kind 应为 upgrade-pack，实际是 ${JSON.stringify(m.kind)}`);
  if (!Array.isArray(m.files)) throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.json 缺 files 清单（逐文件 sha256）');
  if (!m.version) throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.json 缺 version');
  return m;
}

function planUpgrade(buf) {
  if (busy) throw new UpgradeError(409, 'BUSY', '已有一个升级预检/应用正在处理，请稍候');
  if (!Buffer.isBuffer(buf) || !buf.length) throw new UpgradeError(400, 'EMPTY_PACK', '没有收到升级包内容');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new UpgradeError(413, 'TOO_LARGE', `升级包 ${(buf.length / 1048576).toFixed(1)}MB 超过上限 ${MAX_UPLOAD_MB}MB`);
  }
  busy = true;
  try {
    return doPlan(buf);
  } finally {
    busy = false;
  }
}

function doPlan(buf) {
  let entries;
  try { entries = extractZip(buf); } catch (e) { throw new UpgradeError(400, 'BAD_ZIP', e.message); }
  if (!entries.length) throw new UpgradeError(400, 'EMPTY_PACK', '升级包里没有任何文件');

  // ---- 1) 逐条路径校验 + 分类（先把所有坏条目收齐再报，比只报第一条好用） ----
  const bad = [];
  const items = [];
  let pkgJson = null;
  for (const e of entries) {
    const v = validateEntryName(e.name);
    if (v) { bad.push({ path: e.name, code: v.code, msg: v.msg }); continue; }
    const c = classify(e.name);
    if (c.action === 'reject') { bad.push({ path: e.name, code: c.code, msg: c.msg }); continue; }
    if (c.kind === 'pkg') pkgJson = e.data;
    items.push({ ...c, name: e.name, data: e.data, size: e.data.length });
  }
  if (bad.length) {
    const head = bad.slice(0, 3).map((b) => b.msg).join('；');
    throw new UpgradeError(400, bad[0].code,
      `升级包里有 ${bad.length} 个非法条目：${head}${bad.length > 3 ? ` …等 ${bad.length} 条` : ''}`, { rejected: bad });
  }

  // ---- 2) dist 目录一致性 ----
  const distSet = new Set(items.filter((i) => i.kind === 'dist').map((i) => i.dist));
  if (distSet.size > 1) {
    throw new UpgradeError(400, 'BAD_MANIFEST', `包里出现了多个前端目录（${[...distSet].join('、')}）——一份包只能带一个 dist`);
  }
  const distName = distSet.size ? [...distSet][0] : '';
  const latestOnDisk = latestDistName();
  if (distName) {
    if (latestOnDisk && distName <= latestOnDisk) {
      // latestDist() 取字典序最大的目录，时间戳不比现役新的话新前端永远不会被选中 = 白升
      throw new UpgradeError(400, 'STALE_DIST',
        `包里的前端目录 ${distName} 不比现役的 ${latestOnDisk} 新，装上去也不会生效（前端目录名必须比现役大）`);
    }
    if (!items.some((i) => i.name === `web/dist/${distName}/index.html`)) {
      throw new UpgradeError(400, 'INCOMPLETE_DIST', `包里的前端目录 ${distName} 没有 index.html，是个残缺的 dist`);
    }
    const lat = items.find((i) => i.kind === 'latest');
    if (lat && lat.data.toString('utf8').trim() !== distName) {
      throw new UpgradeError(400, 'BAD_MANIFEST', `包内 web/dist/.latest 指向 ${lat.data.toString('utf8').trim()}，与前端目录 ${distName} 不一致`);
    }
    if (!lat) throw new UpgradeError(400, 'BAD_MANIFEST', `包里带了前端目录 ${distName} 却没有 web/dist/.latest 指针`);
  }
  if (items.some((i) => i.kind === 'latest') && !distName) {
    throw new UpgradeError(400, 'BAD_MANIFEST', '包里只有 web/dist/.latest 却没有对应的前端目录');
  }

  // ---- 3) manifest 校验（version 必须与包内 package.json 一致） ----
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  if (!manifestEntry) throw new UpgradeError(400, 'BAD_MANIFEST', '包里没有 manifest.json——无法确认这是面具的升级包');
  const manifest = parseManifest(manifestEntry.data);
  const packedVersion = pkgJson ? diskFileVersion(pkgJson) : '';
  if (!pkgJson) throw new UpgradeError(400, 'BAD_MANIFEST', '包里没有 package.json');
  if (!packedVersion) throw new UpgradeError(400, 'BAD_MANIFEST', '包内 package.json 没有可解析的 version');
  if (manifest.version !== packedVersion) {
    throw new UpgradeError(400, 'BAD_MANIFEST', `manifest 里的 version ${manifest.version} 与包内 package.json 的 ${packedVersion} 不一致`);
  }
  // 逐文件比对：清单与实际条目必须一一对上（比整包哈希更好报错，能指名是哪个文件坏了）
  const maniMap = new Map();
  for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string') throw new UpgradeError(400, 'BAD_MANIFEST', 'manifest.files 有条目缺 path');
    if (maniMap.has(f.path)) throw new UpgradeError(400, 'BAD_MANIFEST', `manifest.files 里 ${f.path} 重复`);
    maniMap.set(f.path, f);
  }
  const realMap = new Map(entries.map((e) => [e.name, e]));
  realMap.delete('manifest.json'); // 自己不算自己的清单项，否则永远对不上
  for (const [p, f] of maniMap) {
    const real = realMap.get(p);
    if (!real) throw new UpgradeError(400, 'BAD_MANIFEST', `manifest 里列了 ${p}，包里却没有这个文件（包被改过或打包中断）`);
    const h = sha256(real.data);
    if (f.sha256 && f.sha256 !== h) throw new UpgradeError(400, 'BAD_MANIFEST', `${p} 的内容与清单里的 sha256 不符（文件被改过或传坏了）`);
    if (f.size !== undefined && Number(f.size) !== real.data.length) {
      throw new UpgradeError(400, 'BAD_MANIFEST', `${p} 的大小与清单不符（清单 ${f.size} ≠ 实际 ${real.data.length}）`);
    }
  }
  for (const p of realMap.keys()) {
    if (!maniMap.has(p)) throw new UpgradeError(400, 'BAD_MANIFEST', `包里有 ${p}，但 manifest 清单里没列（打包器版本不对？）`);
  }

  // ---- 4) 服务端代码语法预检（编译但不执行）—— 这是「零写入」的第一道保险 ----
  const warnings = [];
  const serverItems = items.filter((i) => i.kind === 'server');
  if (!serverItems.length) warnings.push('这个包里没有 server/ 代码：属于纯前端升级，装完不用重启');
  for (const it of serverItems) {
    try {
      new vm.Script(it.data.toString('utf8'), { filename: it.name }); // 只编译，绝不执行
    } catch (e) {
      throw new UpgradeError(400, 'SYNTAX', `包内 ${it.name} 有语法错误，整个升级包被拒绝（磁盘未做任何改动）：${e.message}`);
    }
  }

  // ---- 5) require 闭包检查：包内引用 + 磁盘现存文件两边找，找不到只给警告 ----
  const inPack = new Set(items.map((i) => i.name));
  const missing = new Set();
  for (const it of serverItems) {
    const code = stripComments(it.data.toString('utf8'));
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // 第三方依赖不在这里判（依赖变化另有一条）
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(it.name), spec));
      const cands = [target, target + '.js', target + '/index.js'];
      const okInPack = cands.some((c) => inPack.has(c));
      const okOnDisk = cands.some((c) => fs.existsSync(R(c)));
      if (!okInPack && !okOnDisk) missing.add(`${it.name} → ${spec}`);
    }
  }
  if (missing.size) warnings.push(`有 ${missing.size} 个 require 目标在包里和磁盘上都找不到（服务端可能起不来）：${[...missing].slice(0, 5).join('、')}${missing.size > 5 ? ' …' : ''}`);

  // ---- 6) 依赖变化：预检给警告，apply 要管理员二次确认 ----
  let depChanged = false;
  let deps = null;
  try { deps = JSON.parse(pkgJson.toString('utf8')).dependencies || {}; } catch { /* 上面已判过 version，到这里说明能解析 */ }
  try {
    const diskDeps = JSON.parse(fs.readFileSync(R('package.json'), 'utf8')).dependencies || {};
    const keys = new Set([...Object.keys(deps || {}), ...Object.keys(diskDeps)]);
    const diff = [...keys].filter((k) => (deps || {})[k] !== diskDeps[k]);
    if (diff.length) {
      depChanged = true;
      warnings.push(`依赖清单有变化（${diff.join('、')}）：升级后必须到服务器上执行 npm install --omit=dev，否则服务端会起不来`);
      const missMod = diff.filter((k) => !fs.existsSync(R(path.join('node_modules', k))));
      if (missMod.length) warnings.push(`node_modules 里目前没有：${missMod.join('、')}（不装就会 require 失败）`);
    }
  } catch (e) {
    warnings.push('读不到磁盘上的 package.json，无法比对依赖：' + e.message);
  }

  // ---- 7) 分类 add / overwrite / skip，汇总 ----
  const files = items.map((it) => {
    const dest = R(it.name);
    const exists = fs.existsSync(dest);
    let same = false;
    if (exists) {
      try { same = sha256(fs.readFileSync(dest)) === sha256(it.data); } catch { same = false; }
    }
    let action = 'add';
    if (exists) action = same ? 'skip' : 'overwrite';
    if (it.kind === 'manifest') action = 'skip';
    return {
      path: it.name, kind: it.kind, size: it.size, action,
      note: it.kind === 'manifest' ? it.note : (action === 'skip' ? '磁盘上已经是这个内容，无需写入' : ''),
    };
  });
  const count = (a) => files.filter((f) => f.action === a).length;
  // 只有「真的要写」server/package.json 才需要重启：内容与磁盘一致的（skip）不该逼着重启一次
  const restartRequired = files.some((f) => (f.kind === 'server' || f.kind === 'pkg') && f.action !== 'skip');

  // ---- 8) 过期/遗留文件只报不删（本方案不删文件：留着不被 require 就无害） ----
  const staleOnDisk = [];
  for (const it of serverItems) {
    const dir = path.dirname(R(it.name));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const rel = path.posix.join(path.posix.dirname(it.name), f);
      if (!inPack.has(rel)) staleOnDisk.push(rel);
    }
  }
  if (staleOnDisk.length) {
    warnings.push(`磁盘上还有 ${[...new Set(staleOnDisk)].length} 个不在包里的旧 server 文件（本升级不会删它们；不再被 require 就无害）：${[...new Set(staleOnDisk)].slice(0, 5).join('、')}`);
  }

  const current = runningVersion();
  const downgrade = !!(current && packedVersion && packedVersion < current);
  if (downgrade) warnings.push(`这是降级（现役 ${current} → 包内 ${packedVersion}）——只有在明确回滚时才继续`);

  const plan = {
    manifest: {
      version: packedVersion, from_version: manifest.from_version || '', built_at: manifest.built_at || '',
      dist: manifest.dist || distName, files: manifest.files.length,
    },
    version: { current, current_running: current, package_json: diskVersion(), incoming: packedVersion, downgrade },
    summary: {
      files_total: files.length,
      add: count('add'), overwrite: count('overwrite'), skip: count('skip'),
      bytes_zip: buf.length,
      bytes_uncomp: items.reduce((s, i) => s + i.size, 0),
      dist_dir: distName, dist_current: latestOnDisk,
      dep_changed: depChanged,
    },
    files, warnings, rejected: [],
    restart_required: restartRequired,
  };
  const token = crypto.randomBytes(16).toString('hex');
  pendingPlan = { token, buf, plan, at: Date.now() };
  return { token, plan };
}

// ---------- 应用 ----------
function keepBackups() { return Math.max(1, Number(getSetting('upgrade_keep_backups')) || 5); }
function keepDist() { return Math.max(1, Number(getSetting('upgrade_keep_dist')) || 2); }

// 备份目录名：backup_<14位时间戳>。**同一秒里连做两次升级必须各占一个目录**——
// 备份是回滚材料，两份挤进同一个目录等于悄悄丢掉一次回滚。
// 撞了就往后借一秒：名字保持同一种形状，下载白名单那条正则一个字都不用放宽。
function nextBackupDir() {
  const base = path.join(DATA_DIR, 'upgrades');
  let t = Date.now();
  for (let i = 0; i < 3600; i++) {
    const p = path.join(base, `backup_${stamp(new Date(t))}`);
    if (!fs.existsSync(p)) return p;
    t += 1000;
  }
  return path.join(base, `backup_${stamp(new Date(t))}`);
}

function pruneBackups(keep) {
  const base = path.join(DATA_DIR, 'upgrades');
  if (!fs.existsSync(base)) return [];
  const all = fs.readdirSync(base).filter((n) => /^backup_\d{14}$/.test(n)).sort();
  const gone = all.slice(0, Math.max(0, all.length - keep));
  for (const g of gone) fs.rmSync(path.join(base, g), { recursive: true, force: true });
  return gone;
}
// dist 清理：**在响应之后**由路由调用（正在被 sendFile 的目录删不干净，而且也没必要卡住响应）
function pruneDist() {
  const keep = keepDist();
  const all = distDirs();
  const gone = all.slice(0, Math.max(0, all.length - keep));
  for (const g of gone) {
    try { fs.rmSync(path.join(WEB_ROOT, 'dist', g), { recursive: true, force: true }); }
    catch (e) { console.warn(`[upgrade] 清理旧前端目录 ${g} 失败（下次升级会再试）:`, e.message); }
  }
  return gone;
}

function applyUpgrade({ token, actor = '', ip = '', allowDepChange = false }) {
  if (busy) throw new UpgradeError(409, 'BUSY', '已有一个升级预检/应用正在处理，请稍候');
  if (!pendingPlan || !token || token !== pendingPlan.token) {
    throw new UpgradeError(400, 'BAD_TOKEN', '预检凭证无效或已过期（预检结果只保留 10 分钟），请重新选择升级包并预检');
  }
  if (Date.now() - pendingPlan.at > TOKEN_TTL_MS) {
    pendingPlan = null;
    throw new UpgradeError(400, 'BAD_TOKEN', '预检已超过 10 分钟，请重新选择升级包并预检');
  }

  const { buf, plan } = pendingPlan;
  // 「还没动手就能拒」的闸放在**消费 token 之前**：被拒时 token 保留，
  // 管理员处理完（装完依赖）直接点「应用」就行，不用重传一遍包。
  if (plan.summary.dep_changed && !allowDepChange) {
    throw new UpgradeError(409, 'DEP_CHANGED',
      '这个包改变了 npm 依赖，直接升级会让服务端起不来：请先到服务器上跑 npm install --omit=dev，'
      + '确认后再点「仍要继续」（请求里带 allow_dep_change=true）。', { dep_changed: true });
  }
  pendingPlan = null; // 一次性：从这里开始，无论成败都不能再用同一个 token

  busy = true;
  try {
    return doApply({ buf, plan, actor, ip });
  } finally {
    busy = false;
  }
}

function doApply({ buf, plan, actor, ip }) {
  const writes = []; // 按落盘顺序：server/** → package.json → dist/** → .latest（新前端最后写）
  const order = { server: 1, pkg: 2, dist: 3, latest: 4 };
  const entries = extractZip(buf);
  for (const e of entries) {
    const c = classify(e.name);
    if (c.action !== 'write') continue;
    writes.push({ name: e.name, kind: c.kind, data: e.data, ord: order[c.kind] || 9 });
  }
  writes.sort((a, b) => (a.ord - b.ord) || a.name.localeCompare(b.name));

  const backupDir = nextBackupDir();
  // 内容与磁盘**完全一致**的文件不写：预检把它们标成「跳过」，这里就必须真的跳过——
  // 否则预检说「跳过 29 个、无需写入」，回包却说「已写入 65 个」，管理员没法信这两句话。
  // 顺带把阶段 B 要 rename 的文件数降到最小：那个「非全或无」的窄窗口跟着一起变小。
  const same = [];
  const todo = [];
  for (const w of writes) {
    const dest = R(w.name);
    if (fs.existsSync(dest)) {
      let eq = false;
      try { eq = sha256(fs.readFileSync(dest)) === sha256(w.data); } catch { eq = false; }
      if (eq) { same.push(w.name); continue; }
    }
    todo.push(w);
  }
  const overwritten = todo.filter((w) => fs.existsSync(R(w.name)));
  const added = todo.filter((w) => !fs.existsSync(R(w.name)));

  // 阶段 A：全部先写成 <目标>.upgrade-tmp-<pid>（这一步不碰任何现存文件，炸了就删 tmp，磁盘零变更）
  const tmps = [];
  try {
    for (const w of todo) {
      const dest = R(w.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.upgrade-tmp-${process.pid}`;
      fs.writeFileSync(tmp, w.data);
      tmps.push({ tmp, dest, name: w.name });
    }
  } catch (e) {
    for (const t of tmps) { try { fs.unlinkSync(t.tmp); } catch { /* 尽力清理 */ } }
    const msg = `写入临时文件失败（磁盘未做任何改动）：${e.message}`;
    logRun({ actor, ip, from: plan.version.current, to: plan.manifest.version, added: 0, overwritten: 0, bytes: buf.length, backupDir: '', dist: plan.summary.dist_dir, restarted: 0, suppressed: 0, ok: 0, sha: sha256(buf), note: msg });
    throw new UpgradeError(500, 'WRITE_FAILED', msg);
  }

  // 备份（在阶段 B 之前，覆盖的每一个文件都要有原文可回滚）
  if (overwritten.length) {
    for (const w of overwritten) {
      const dst = path.join(backupDir, w.name);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(R(w.name), dst);
    }
    fs.writeFileSync(path.join(backupDir, 'RESTORE.txt'),
      `升级前备份（${new Date().toISOString()}）\n`
      + `从 ${plan.version.current} 升到 ${plan.manifest.version}\n\n`
      + `回滚方法：把本目录下的文件按相同相对路径拷回仓库根目录，然后重启服务。\n`
      + `本目录只包含「被覆盖」的 ${overwritten.length} 个文件；新加的文件不会被撤销（留着不影响运行）。\n`);
    pruneBackups(keepBackups());
  }

  // 阶段 B：逐个 rename 到位（Windows 上 Node 的 rename 走 MOVEFILE_REPLACE_EXISTING，可以直接覆盖）
  // ⚠️ 这里是本方案**唯一**的非全或无窄窗口：中途被 Defender/索引器锁住会出现「半新半旧」。
  //    所以每文件重试 3×200ms，还失败就停下、不重启、把清单交给管理员（配合备份手动恢复）。
  const written = [];
  const failed = [];
  for (const t of tmps) {
    if (failed.length) { try { fs.unlinkSync(t.tmp); } catch { /* 清掉没轮到写的 */ } continue; }
    let ok = false;
    let lastErr = null;
    for (let i = 0; i < 3 && !ok; i++) {
      try { fs.renameSync(t.tmp, t.dest); ok = true; }
      catch (e) { lastErr = e; if (i < 2) sleepSync(200); }
    }
    if (ok) written.push(t.name);
    else failed.push({ path: t.name, error: lastErr ? lastErr.message : '未知错误' });
  }

  if (failed.length) {
    const note = `部分文件写不进去（可能被杀毒/索引程序锁住）：已生效 ${written.length} 个，未生效 ${failed.length} 个。`
      + `服务**没有重启**，旧代码还在跑。请把 ${backupDir} 里的文件拷回仓库再重启，然后重试升级。`;
    logRun({ actor, ip, from: plan.version.current, to: plan.manifest.version, added: added.length, overwritten: overwritten.length, bytes: buf.length, backupDir, dist: plan.summary.dist_dir, restarted: 0, suppressed: 0, ok: 0, sha: sha256(buf), note });
    throw new UpgradeError(500, 'PARTIAL_WRITE', note, { files_written: written, files_failed: failed, backup_dir: backupDir });
  }

  const addedNames = added.map((w) => w.name);
  const overNames = overwritten.map((w) => w.name);
  const note = `已写入 ${written.length} 个文件（覆盖 ${overNames.length}、新增 ${addedNames.length}、跳过 ${same.length} 个内容与磁盘一致的）`;
  const logId = logRun({ actor, ip, from: plan.version.current, to: plan.manifest.version, added: addedNames.length, overwritten: overNames.length, bytes: buf.length, backupDir: overwritten.length ? backupDir : '', dist: plan.summary.dist_dir, restarted: plan.restart_required && !restartService.isSuppressed() ? 1 : 0, suppressed: restartService.isSuppressed() ? 1 : 0, ok: 1, sha: sha256(buf), note });

  const restart = !plan.restart_required ? 'not_needed' : (restartService.isSuppressed() ? 'suppressed' : 'scheduled');
  const restartNote = {
    not_needed: '这个包只换了前端（新版前端目录下一次请求就生效），服务端没动，不用重启',
    suppressed: '文件已落盘，但 MASK_NO_RESTART=1：**进程没有重启**，手动重启后新代码才生效（自检/调试模式）',
    scheduled: `已在响应之后拉起接替进程（${plan.manifest.version}），1~3 秒后新版本上线，页面会短暂打不开`,
  }[restart];

  return {
    applied: true,
    ok: true,
    version: { from: plan.version.current, to: plan.manifest.version, package_json: diskVersion() },
    files_written: { add: addedNames, overwrite: overNames, skipped: same, total: written.length },
    backup_dir: overwritten.length ? backupDir : '',
    dist_dir: plan.summary.dist_dir,
    restart_required: plan.restart_required,
    restart,
    restart_note: restartNote,
    log_id: logId,
    // 路由在 res 'finish' 之后调：清旧 dist 是唯一一件不该卡在响应前做的事
    afterRespond: () => {
      const gone = pruneDist();
      if (restart === 'scheduled') restartService.scheduleRestart({ fromVersion: plan.version.current, toVersion: plan.manifest.version, backupDir: overwritten.length ? backupDir : '' });
      return gone;
    },
  };
}

// ---------- 日志（面具的 upgrade_logs 表是窄表：明细整体塞 detail JSON 列） ----------
function logRun({ actor, ip, from, to, added, overwritten, bytes, backupDir, dist, restarted, suppressed, ok, sha, note }) {
  try {
    const detail = JSON.stringify({
      actor, ip, files_added: added, files_overwritten: overwritten, bytes,
      backup_dir: backupDir || '', dist_dir: dist || '',
      restarted: !!restarted, restart_suppressed: !!suppressed, sha256: sha, note: note || '',
    });
    const info = db.prepare(`INSERT INTO upgrade_logs (version, action, detail, ok) VALUES (?,?,?,?)`)
      .run(to || '', 'upgrade', detail, ok ? 1 : 0);
    // Logs/upgrade.log：一行一次，方便服务器上 Get-Content 看历史。**绝不写 token/Key/请求体**
    try {
      const dir = path.join(ROOT, 'Logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'upgrade.log'),
        `${new Date().toISOString()} | ${actor}@${ip} | v${from}→v${to} | +${added} ~${overwritten} | ${(bytes / 1024).toFixed(0)}KB | ${backupDir || '-'} | restart=${restarted}${suppressed ? '(抑制)' : ''} | ${ok ? 'OK' : 'FAIL'} | ${note}\n`);
    } catch { /* 日志写不了不影响升级 */ }
    return info.lastInsertRowid;
  } catch (e) {
    console.warn('[upgrade] 写 upgrade_logs 失败:', e.message);
    return null;
  }
}

function listLogs(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return db.prepare('SELECT * FROM upgrade_logs ORDER BY id DESC LIMIT ?').all(n).map((r) => {
    let d = {};
    try { d = JSON.parse(r.detail || '{}') || {}; } catch { d = {}; }
    return {
      id: r.id, created_at: r.at, actor: d.actor || '', ip: d.ip || '',
      from_version: '', to_version: r.version || '',
      files_added: d.files_added, files_overwritten: d.files_overwritten, bytes: d.bytes,
      backup_dir: d.backup_dir ? path.basename(d.backup_dir) : '',
      dist_dir: d.dist_dir || '', restarted: !!d.restarted, restart_suppressed: !!d.restart_suppressed,
      ok: !!r.ok, note: d.note || '',
    };
  });
}
function backupZipPath(name) {
  // 只认 backup_<14位时间戳>，杜绝 ../ 穿越去读别的目录
  if (!/^backup_\d{14}$/.test(String(name || ''))) return null;
  const p = path.join(DATA_DIR, 'upgrades', name);
  return fs.existsSync(p) ? p : null;
}

function statusSnapshot() {
  return {
    current_version: runningVersion(),
    package_json_version: diskVersion(),
    node: process.version,
    platform: process.platform,
    upgrade_root: ROOT,
    web_root: WEB_ROOT,
    latest_dist: latestDistName(),
    dist_dirs: distDirs(),
    restart_suppressed: restartService.isSuppressed(),
    restart_pending: !!(restartService.readPending() || {}).restart_pending,
    max_upload_mb: MAX_UPLOAD_MB,
    // backups/dist 是**生效值**（留空则回落默认 5/2）；*_set 说明用户是否显式设过，前端据此决定输入框留不留空
    keep: {
      backups: keepBackups(), dist: keepDist(),
      backups_set: !!String(getSetting('upgrade_keep_backups') || ''), dist_set: !!String(getSetting('upgrade_keep_dist') || ''),
    },
    logs: listLogs(5),
  };
}

module.exports = {
  planUpgrade, applyUpgrade, listLogs, statusSnapshot, backupZipPath, pruneDist,
  MAX_UPLOAD_MB, UpgradeError, ROOT, WEB_ROOT,
};
