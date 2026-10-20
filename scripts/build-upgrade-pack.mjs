// 打「在线升级包」（v1.11.0）：给设置页 → 升级页签上传用的 zip。
//
//   node scripts/build-upgrade-pack.mjs [--out <目录或文件>] [--allow-dep-change] [--force]
//
// 口径（和 server/services/upgradeService.js 的白名单严格对齐，任何一条对不上都会被服务端拒收）：
//   整份 server/**/*.js + 一个全新时间戳的 web/dist/<ts>/** + web/dist/.latest + package.json + manifest.json
//   版本号唯一来源 = package.json.version（不提供 --version：多一个来源就多一个能对不上的地方）
//   选 dist 的排序必须和 server/index.js 的 latestDist() 一模一样（纯数字名 + 字典序最大值），不许按 mtime
//
// 它自带四道傻瓜闸：①dist 目录必须比现役新（否则装上去 latestDist() 不会选中，白升）
//   ②web/dist/.latest 必须指向选中的目录 ③web/src 有任何文件比 dist 产物新 → 前端改了没 build
//   ④依赖清单相对 HEAD 变了 → 必须显式 --allow-dep-change（服务端还会再拦一次 409 DEP_CHANGED）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { buildZip, extractZip } = require(path.join(ROOT, 'server', 'services', 'zipService.js'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const optOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const FORCE = has('--force');
const ALLOW_DEP = has('--allow-dep-change');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const warn = (m) => console.log('  ⚠️  ' + m);
const die = (m) => { console.error('\n❌ ' + m + '\n'); process.exit(1); };

// ---------- 1) 版本 ----------
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+/.test(version)) die(`package.json 里的 version 不像版本号（${JSON.stringify(pkg.version)}）`);

// ---------- 2) 选 dist（口径与 latestDist() 完全一致） ----------
const distRoot = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(distRoot)) die('没有 web/dist 目录：先 cd web && npm run build');
const distDirs = fs.readdirSync(distRoot)
  .filter((n) => /^\d{8,}$/.test(n) && fs.statSync(path.join(distRoot, n)).isDirectory())
  .sort();
if (!distDirs.length) die('web/dist 下没有 <时间戳> 形式的前端产物：先 cd web && npm run build');
const distName = optOf('--dist') || distDirs[distDirs.length - 1];
if (!distDirs.includes(distName)) die(`指定的 dist 目录 ${distName} 不存在（可选：${distDirs.join('、')}）`);
const distDirAbs = path.join(distRoot, distName);
console.log(`面具升级包构建：版本 v${version}，前端目录 ${distName}（dist 下共 ${distDirs.length} 份，取字典序最大的那份）`);
if (distDirs.length > 1) {
  warn(`web/dist 下有 ${distDirs.length} 份前端产物（${distDirs.join('、')}）——包里只带 ${distName}；`
    + '仓库惯例是只留最新一份，建议删掉旧的。');
}

// ---------- 3) 傻瓜闸 ----------
if (!fs.existsSync(path.join(distDirAbs, 'index.html'))) die(`${distName} 里没有 index.html，是个残缺的 dist`);
const latestFile = path.join(distRoot, '.latest');
const latestOnDisk = fs.existsSync(latestFile) ? fs.readFileSync(latestFile, 'utf8').trim() : '';
if (latestOnDisk !== distName) {
  die(`web/dist/.latest 指向 ${latestOnDisk || '(空)'}，但这次要打的是 ${distName}`
    + `——先把前端重新 build 一次（cd web && npm run build），或确认自己在打哪一份`);
}

// 前端改了没 build：web/src 里任何文件比 dist 产物新，就说明这份 dist 落后于源码
const srcRoots = [
  path.join(ROOT, 'web', 'src'),
  path.join(ROOT, 'web', 'index.html'),
  path.join(ROOT, 'web', 'vite.config.js'),
  path.join(ROOT, 'web', 'package.json'),
];
function newestMtime(p, acc = { t: 0, f: '' }) {
  if (!fs.existsSync(p)) return acc;
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) newestMtime(path.join(p, n), acc); return acc; }
  if (st.mtimeMs > acc.t) { acc.t = st.mtimeMs; acc.f = path.relative(ROOT, p); }
  return acc;
}
function oldestMtime(p) {
  let t = Infinity;
  for (const n of fs.readdirSync(p)) {
    const q = path.join(p, n);
    const st = fs.statSync(q);
    if (st.isDirectory()) t = Math.min(t, oldestMtime(q));
    else t = Math.min(t, st.mtimeMs);
  }
  return t;
}
// 只认 vite 真正构建出的文件（index.html + assets/**）：public/ 直拷目录（如 material-icons）
// 保留源文件时间戳，拿它当「构建时间」会误报源码比产物新
function oldestBuiltMtime(distDir) {
  let t = Infinity;
  const ih = path.join(distDir, 'index.html');
  if (fs.existsSync(ih)) t = Math.min(t, fs.statSync(ih).mtimeMs);
  const assets = path.join(distDir, 'assets');
  if (fs.existsSync(assets)) t = Math.min(t, oldestMtime(assets));
  return t;
}
const newestSrc = srcRoots.map((p) => newestMtime(p)).reduce((a, b) => (b.t > a.t ? b : a), { t: 0, f: '' });
const newestSrcFile = newestSrc.f;
const oldestDist = oldestBuiltMtime(distDirAbs);
if (newestSrc.t > oldestDist) {
  const msg = `前端源码比 dist 产物新（${newestSrcFile} ${new Date(newestSrc.t).toLocaleString()}`
    + ` > dist 构建时间 ${new Date(oldestDist).toLocaleString()}）——这份 dist 不含你最新的改动，先 cd web && npm run build`;
  if (FORCE) warn(msg + '（--force 已放行）'); else die(msg);
}

// 依赖基线：相对上一个提交（= 上一次发出去的样子）比对，变了必须是有意识动作
let fromVersion = '';
let depChanged = false;
try {
  const head = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: ROOT, encoding: 'utf8' }));
  fromVersion = String(head.version || '');
  const a = pkg.dependencies || {}; const b = head.dependencies || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [...keys].filter((k) => a[k] !== b[k]).map((k) => `${k} ${b[k] || '(无)'} → ${a[k] || '(删)'}`);
  depChanged = diff.length > 0;
  if (depChanged) {
    const msg = `依赖清单相对 HEAD(v${fromVersion}) 变了：${diff.join('、')}——`
      + '升级后服务器上必须 npm install --omit=dev，否则服务端起不来';
    if (ALLOW_DEP) warn(msg + '（--allow-dep-change 已知晓）'); else die(msg + '\n   确认要这样发，就加 --allow-dep-change 再跑一次');
  }
} catch (e) {
  warn('读不到 git HEAD 的 package.json（没有 git 或还没有提交），跳过「依赖基线」这条自查：' + String(e.message).split('\n')[0]);
}

// ---------- 4) 收集条目 ----------
const entries = [];
function addFile(rel, abs) { entries.push({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(abs) }); }
function addTree(relDir, absDir, filter) {
  for (const n of fs.readdirSync(absDir).sort()) {
    const q = path.join(absDir, n);
    const st = fs.statSync(q);
    if (st.isDirectory()) { addTree(path.join(relDir, n), q, filter); continue; }
    const rel = path.join(relDir, n);
    if (filter && !filter(rel)) continue;
    addFile(rel, q);
  }
}

// server/：白名单只收 .js，所以只打 .js；server/ 下若有别的文件，明确列出来（打进去会被服务端整包拒收）
const serverFiles = [];
(function walk(relDir, absDir) {
  for (const n of fs.readdirSync(absDir).sort()) {
    const q = path.join(absDir, n);
    const st = fs.statSync(q);
    if (st.isDirectory()) { walk(path.join(relDir, n), q); continue; }
    serverFiles.push(path.join(relDir, n));
  }
})(path.join(ROOT, 'server').replace(ROOT + path.sep, ''), path.join(ROOT, 'server'));
const notJs = serverFiles.filter((f) => !f.endsWith('.js'));
if (notJs.length) {
  warn(`server/ 下有 ${notJs.length} 个非 .js 文件没打进包（升级白名单只允许 server/**.js）：${notJs.join('、')}`);
}
for (const rel of serverFiles) {
  if (!rel.endsWith('.js')) continue;
  addFile(rel, path.join(ROOT, rel));
}
addTree(path.join('web', 'dist', distName), distDirAbs);
entries.push({ name: 'web/dist/.latest', data: Buffer.from(distName) });
addFile('package.json', pkgPath);

// ---------- 5) 构建期自查（服务端会再查一遍，但打包时炸掉比上传后被拒友好） ----------
for (const e of entries) {
  if (/^data(\/|$)/i.test(e.name)) die(`包里出现了 data/ 下的文件：${e.name}（库、密钥、地图缓存绝不能进包）`);
  if (/(^|\/)node_modules(\/|$)/.test(e.name)) die(`包里出现了 node_modules：${e.name}`);
  if (/[^\x00-\x7F]/.test(e.name)) die(`条目名含非 ASCII 字符，服务端升级白名单会拒：${e.name}`);
  if (e.name.includes('\\') || e.name.split('/').some((s) => s === '' || s === '.' || s === '..')) die(`条目名不合法：${e.name}`);
}
for (const e of entries) {
  if (!/^server\/.*\.js$/.test(e.name)) continue;
  try { new vm.Script(e.data.toString('utf8'), { filename: e.name }); } catch (err) {
    die(`包内 ${e.name} 有语法错误（服务端会拒收整个包）：${err.message}`);
  }
}
if (!entries.some((e) => e.name === `web/dist/${distName}/index.html`)) die('收集到的条目里没有 index.html');
if (!entries.some((e) => e.name === 'server/index.js')) die('收集到的条目里没有 server/index.js');

// ---------- 6) manifest + 打包 + 往返自校验 ----------
const manifest = {
  app: 'mask',
  kind: 'upgrade-pack',
  version,
  from_version: fromVersion,
  built_at: new Date().toISOString(),
  dist: distName,
  files: entries.map((e) => ({ path: e.name, size: e.data.length, sha256: sha256(e.data) })),
};
entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

const zipBuf = buildZip(entries);
let back;
try { back = extractZip(zipBuf); } catch (e) { die('生成的 zip 自己解不开（zipService 有 bug，别发这个包）：' + e.message); }
if (back.length !== entries.length) die(`往返自校验失败：打包 ${entries.length} 条，解开 ${back.length} 条`);
for (const e of entries) {
  const b = back.find((x) => x.name === e.name);
  if (!b) die(`往返自校验失败：解开的包里没有 ${e.name}`);
  if (sha256(b.data) !== sha256(e.data)) die(`往返自校验失败：${e.name} 内容变了（codec 有 bug）`);
}

// ---------- 7) 落盘（*.tmp → rename，避免半截文件被当成成品上传） ----------
const outArg = optOf('--out');
let outPath;
if (outArg && /[.]zip$/i.test(outArg)) outPath = path.resolve(outArg);
else outPath = path.join(outArg ? path.resolve(outArg) : ROOT, `面具-${version}-upgrade.zip`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
if (fs.existsSync(outPath) && !FORCE) die(`产物已存在：${outPath}（覆盖请加 --force）`);
const tmpPath = `${outPath}.tmp`;
fs.writeFileSync(tmpPath, zipBuf);
fs.renameSync(tmpPath, outPath);

// ---------- 8) 收尾报告 ----------
const uncomp = entries.reduce((s, e) => s + e.data.length, 0);
const serverCount = entries.filter((e) => /^server\/.*\.js$/.test(e.name)).length;
const distCount = entries.filter((e) => e.name.startsWith(`web/dist/${distName}/`)).length;
console.log('');
console.log(`  ✅ ${outPath}`);
console.log(`     条目 ${entries.length} 条（server ${serverCount} + dist ${distCount} + package.json + .latest + manifest）`);
console.log(`     压缩后 ${(zipBuf.length / 1024).toFixed(1)} KB ← 解开 ${(uncomp / 1024).toFixed(1)} KB`);
console.log(`     dist=${distName}   from v${fromVersion || '?'} → v${version}   依赖变化：${depChanged ? '有（记得服务器上 npm install --omit=dev）' : '无'}`);
console.log('     需要重启：是（包里有 server/ + package.json）——上传后在设置 → 升级里预检 → 应用，服务会自己接替重启');
console.log('');
