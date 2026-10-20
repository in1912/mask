#!/usr/bin/env node
// 面具 mask — 在线升级自检：预检只读 / 坏包逐条拒收 / 应用两阶段 / 备份回滚材料 / 保留策略 / 纯前端包 / 413
// 隔离（硬需求）：MASK_UPGRADE_ROOT / MASK_WEB_ROOT 指向临时仓库副本，MASK_NO_RESTART=1 只落盘不重启，
// MASK_UPGRADE_MAX_MB=1 用来测 413。整个自检绝不碰开发机真实 server/ 与 web/dist/。
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { buildZip, extractZip } = require(path.join(ROOT, 'server', 'services', 'zipService.js'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const PORT = 9924;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_VER = require(path.join(ROOT, 'package.json')).version; // 0.3.0
const DIST0 = '20260101000000'; // 临时仓库的初始前端目录（后续包用 +1/+2/…，保证比现役新）

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 临时仓库副本（server/ + 一个旧 dist + package.json）----
const workDir = mkdtempSync(path.join(tmpdir(), 'mask-upg-'));
const dataDir = path.join(workDir, 'data');
const repo = path.join(workDir, 'repo');
mkdirSync(dataDir, { recursive: true });
cpSync(path.join(ROOT, 'server'), path.join(repo, 'server'), { recursive: true });
mkdirSync(path.join(repo, 'web', 'dist', DIST0, 'assets'), { recursive: true });
writeFileSync(path.join(repo, 'web', 'dist', DIST0, 'index.html'),
  '<!doctype html><html><title>OLD</title><body>OLD-DIST-MARKER</body></html>');
writeFileSync(path.join(repo, 'web', 'dist', DIST0, 'assets', 'app.js'), 'console.log("old")');
writeFileSync(path.join(repo, 'web', 'dist', '.latest'), DIST0);
cpSync(path.join(ROOT, 'package.json'), path.join(repo, 'package.json'));

// ---- 造包工具：与 scripts/build-upgrade-pack.mjs 同口径 ----
// overrides: { 'server/index.js': '…' } —— 替换同名文件内容（否则包与临时副本同源会被判 skip 而非 overwrite）
function buildPack({ version, dist, serverDir = path.join(ROOT, 'server'), extraEntries = [], pkgDeps = null, noManifest = false, omitIndex = false, overrides = {} }) {
  const entries = [];
  const add = (name, data) => entries.push({ name, data });
  (function walk(relDir, absDir) {
    for (const n of readdirSync(absDir).sort()) {
      const q = path.join(absDir, n);
      if (statSync(q).isDirectory()) { walk(path.join(relDir, n), q); continue; }
      if (!n.endsWith('.js')) continue;
      const rel = path.posix.join(relDir, n).split(path.sep).join('/');
      if (overrides[rel]) return;
      add(rel, readFileSync(q));
    }
  })('server', serverDir);
  for (const [n, d] of Object.entries(overrides)) add(n, typeof d === 'string' ? Buffer.from(d) : d);
  mkdirSync(path.join(workDir, 'diststage', dist, 'assets'), { recursive: true });
  writeFileSync(path.join(workDir, 'diststage', dist, 'index.html'),
    `<!doctype html><title>mask ${version}</title><body>NEW-DIST-${dist}</body>`);
  writeFileSync(path.join(workDir, 'diststage', dist, 'assets', `app-${dist}.js`), `console.log("${dist}")`);
  if (!omitIndex) add(`web/dist/${dist}/index.html`, readFileSync(path.join(workDir, 'diststage', dist, 'index.html')));
  add(`web/dist/${dist}/assets/app-${dist}.js`, readFileSync(path.join(workDir, 'diststage', dist, 'assets', `app-${dist}.js`)));
  add('web/dist/.latest', Buffer.from(dist));
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.version = version;
  if (pkgDeps) pkg.dependencies = pkgDeps;
  add('package.json', Buffer.from(JSON.stringify(pkg, null, 2)));
  for (const e of extraEntries || []) add(e.name, typeof e.data === 'string' ? Buffer.from(e.data) : e.data);
  if (!noManifest) {
    add('manifest.json', Buffer.from(JSON.stringify({
      app: 'mask', kind: 'upgrade-pack', version, from_version: REPO_VER,
      built_at: new Date().toISOString(), dist,
      files: entries.map((e) => ({ path: e.name, size: e.data.length, sha256: sha256(e.data) })),
    }, null, 2)));
  }
  return buildZip(entries);
}

// ---- 起服务（升级根指到临时副本；MAX 1MB 测 413；不重启）----
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env, MASK_NO_SIDECAR: '1', MASK_DATA_DIR: dataDir, PORT: String(PORT), MASK_GEO: 'off',
    MASK_UPGRADE_ROOT: repo, MASK_WEB_ROOT: path.join(repo, 'web'),
    MASK_NO_RESTART: '1', MASK_UPGRADE_MAX_MB: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (c) => (serverLog += c));
child.stderr.on('data', (c) => (serverLog += c));
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250);
  try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* 未就绪 */ }
}
if (!up) { console.error('服务未能在 10s 内启动：\n' + serverLog); child.kill(); process.exit(1); }

async function req(method, p, { token, body, raw } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'application/zip' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined)
  });
  if (p.includes('/download')) return { status: r.status, json: {}, buf: Buffer.from(await r.arrayBuffer()) };
  return { status: r.status, json: await r.json().catch(() => ({})), buf: null };
}

// ---- 登录 + 普通用户 ----
const lo = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'admin123' } });
const tk = lo.json.token;
await req('POST', '/api/users', { token: tk, body: { username: 'u1', password: 'u123456', role: 'user', display_name: '普通' } });
const lu = await req('POST', '/api/auth/login', { body: { username: 'u1', password: 'u123456' } });
const tu = lu.json.token;

console.log('\n== A. 权限与状态快照 ==');
{
  const a = await req('GET', '/api/upgrade/status');
  ok('匿名 401', a.status === 401);
  const u = await req('GET', '/api/upgrade/status', { token: tu });
  ok('普通用户 403', u.status === 403);
  const s = await req('GET', '/api/upgrade/status', { token: tk });
  ok('admin 200', s.status === 200);
  ok('upgrade_root 指向临时副本（自检隔离生效）', s.json.upgrade_root === repo, JSON.stringify(s.json.upgrade_root));
  ok('latest_dist = 初始目录', s.json.latest_dist === DIST0);
  ok('restart_suppressed=true（NO_RESTART）', s.json.restart_suppressed === true);
  ok('restart_pending=false', s.json.restart_pending === false);
  ok('max_upload_mb=1（可调环境）', s.json.max_upload_mb === 1);
}

console.log('\n== B. 坏包逐条拒收（全部 400 且零写入） ==');
const diskBefore = sha256(readFileSync(path.join(repo, 'server', 'index.js')));
const serverRootFiles = () => readdirSync(path.join(repo, 'server')).length;
const filesBefore = serverRootFiles();
async function badPack(name, zip, wantCode) {
  const r = await req('POST', '/api/upgrade/plan', { token: tk, raw: zip });
  ok(`${name} → ${wantCode}`, r.status === 400 && r.json.code === wantCode, `实际 ${r.status}/${r.json.code} ${r.json.error || ''}`);
}
{
  const ver = '9.9.9';
  const goodBase = () => buildPack({ version: ver, dist: '20260202000000' });
  await badPack('不是 zip', Buffer.from('这不是一个zip文件，真的不是'), 'BAD_ZIP');
  {
    // buildZip 拒收目录条目，这里手工造一个「只有目录条目」的 zip：解开后 0 个文件 → EMPTY_PACK
    const nb = Buffer.from('a/', 'utf8');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(nb.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(nb.length, 28);
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10);
    eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(30 + nb.length, 16); // 中央目录紧跟 local 段之后
    await badPack('空包（只有目录条目）', Buffer.concat([lh, nb, cd, nb, eo]), 'EMPTY_PACK');
  }
  {
    const zip = buildPack({ version: ver, dist: '20260202000000', extraEntries: [{ name: 'data/mask.sqlite', data: 'x' }] });
    await badPack('data/ 目录点名拒绝', zip, 'FORBIDDEN_PATH');
  }
  await badPack('路径穿越 ..', (() => {
    const e = [{ name: 'server/evil.js', data: Buffer.from('module.exports=1') }, { name: 'a/../../evil.js', data: Buffer.from('x') }];
    return buildZip(e);
  })(), 'PATH_TRAVERSAL');
  await badPack('非白名单路径', buildZip([{ name: 'web/src/App.vue', data: Buffer.from('<template/>') }]), 'NOT_ALLOWED');
  await badPack('app 名不对（不是面具的包）', (() => { // 复刻 good 包但 manifest.app 改错
    const inner = extractZip(buildPack({ version: ver, dist: '20260202000000', noManifest: true }));
    inner.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ app: 'alleyu', kind: 'upgrade-pack', version: ver, files: [] })) });
    return buildZip(inner);
  })(), 'BAD_MANIFEST');
  await badPack('manifest 缺失', buildPack({ version: ver, dist: '20260202000000', noManifest: true }), 'BAD_MANIFEST');
  await badPack('dist 时间戳不比现役新', buildPack({ version: ver, dist: DIST0 }), 'STALE_DIST');
  await badPack('dist 缺 index.html', buildPack({ version: ver, dist: '20260202000001', omitIndex: true }), 'INCOMPLETE_DIST');
  await badPack('sha256 与清单不符', (() => {
    const inner = extractZip(buildPack({ version: ver, dist: '20260202000002', noManifest: true }));
    const files = inner.map((e) => ({ path: e.name, size: e.data.length, sha256: e.name.endsWith('.js') ? '0'.repeat(64) : sha256(e.data) }));
    inner.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ app: 'mask', kind: 'upgrade-pack', version: ver, files })) });
    return buildZip(inner);
  })(), 'BAD_MANIFEST');
  await badPack('包里有清单没列的条目', (() => {
    const inner = extractZip(buildPack({ version: ver, dist: '20260202000003', noManifest: true }));
    const files = inner.filter((e) => e.name !== 'web/dist/.latest').map((e) => ({ path: e.name, sha256: sha256(e.data) }));
    inner.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ app: 'mask', kind: 'upgrade-pack', version: ver, files })) });
    return buildZip(inner);
  })(), 'BAD_MANIFEST');
  await badPack('server js 语法错误', buildPack({
    version: ver, dist: '20260202000004',
    extraEntries: [{ name: 'server/broken.js', data: 'function {{{' }],
  }), 'SYNTAX');
  // 预检全程零写入
  ok('坏包轰炸后磁盘零变更（server/index.js 未变）', sha256(readFileSync(path.join(repo, 'server', 'index.js'))) === diskBefore);
  ok('坏包轰炸后没有多余文件', serverRootFiles() === filesBefore);
}

console.log('\n== C. 预检 → 应用（server+dist+pkg 整包） ==');
let planToken = '';
let planJson = null;
let backup1 = '';
{
  // override 一个 server 文件：临时副本与真实 server 同源，不改内容就全是 skip，测不到覆盖与备份
  const zip = buildPack({
    version: REPO_VER + '-a1', dist: '20260303000001',
    overrides: { 'server/index.js': readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8') + '\n// CHECK-A1\n' },
  });
  const p = await req('POST', '/api/upgrade/plan', { token: tk, raw: zip });
  ok('预检 200', p.status === 200, JSON.stringify(p.json).slice(0, 200));
  planJson = p.json.plan;
  planToken = p.json.token;
  ok('返回一次性 token', typeof planToken === 'string' && planToken.length >= 16);
  ok('restart_required=true（有 server/ + package.json）', planJson.restart_required === true);
  ok('版本对比 incoming > current', planJson.version.incoming === REPO_VER + '-a1' && planJson.version.current === REPO_VER);
  ok('manifest 在计划里记为 skip', planJson.files.some((f) => f.path === 'manifest.json' && f.action === 'skip'));
  ok('预检不写盘（latest_dist 仍是旧目录）', (await req('GET', '/api/upgrade/status', { token: tk })).json.latest_dist === DIST0);

  const ap = await req('POST', '/api/upgrade/apply', { token: tk, body: { token: planToken } });
  ok('应用 200', ap.status === 200, JSON.stringify(ap.json).slice(0, 200));
  ok('restart=suppressed（NO_RESTART 下只落盘）', ap.json.restart === 'suppressed');
  ok('磁盘 package.json 已换版本', (await req('GET', '/api/upgrade/status', { token: tk })).json.package_json_version === REPO_VER + '-a1');
  ok('运行版本仍是旧值（进程没重启的诚实信号）', (await req('GET', '/api/system-info')).json.version === REPO_VER);
  ok('预检 skip 数 = 应用 skip 数 + 1（manifest 只校验不写）',
    planJson.summary.skip === ap.json.files_written.skipped.length + 1,
    `plan skip=${planJson.summary.skip} apply skip=${ap.json.files_written.skipped.length}`);
  ok('add/overwrite 与预检一致', planJson.summary.add === ap.json.files_written.add.length
    && planJson.summary.overwrite === ap.json.files_written.overwrite.length);
  backup1 = ap.json.backup_dir ? path.basename(ap.json.backup_dir) : '';
  ok('生成备份目录', /^backup_\d{14}$/.test(backup1));
  ok('备份里有旧 server/index.js 原文', existsSync(path.join(dataDir, 'upgrades', backup1, 'server', 'index.js')));
  ok('备份 RESTORE.txt 存在', existsSync(path.join(dataDir, 'upgrades', backup1, 'RESTORE.txt')));
  // 静态前端立即切换到新 dist
  const page = await fetch(BASE + '/');
  const text = await page.text();
  ok('静态页已切到新 dist（标记命中）', page.ok && text.includes(`NEW-DIST-20260303000001`));
  // token 一次性
  const again = await req('POST', '/api/upgrade/apply', { token: tk, body: { token: planToken } });
  ok('token 一次性（二次应用 400 BAD_TOKEN）', again.status === 400 && again.json.code === 'BAD_TOKEN');
}

console.log('\n== D. 保留策略 + 备份唯一性 ==');
{
  for (const [v, d] of [[REPO_VER + '-a2', '20260303000002'], [REPO_VER + '-a3', '20260303000003'], [REPO_VER + '-a4', '20260303000004']]) {
    const p = await req('POST', '/api/upgrade/plan', { token: tk, raw: buildPack({ version: v, dist: d }) });
    const ap = await req('POST', '/api/upgrade/apply', { token: tk, body: { token: p.json.token } });
    ok(`应用 ${v}`, ap.status === 200 && ap.json.applied === true);
  }
  const st = await req('GET', '/api/upgrade/status', { token: tk });
  ok('dist 只保留最近 2 份', st.json.dist_dirs.length === 2 && st.json.dist_dirs.join(',') === '20260303000003,20260303000004',
    JSON.stringify(st.json.dist_dirs));
  const backs = readdirSync(path.join(dataDir, 'upgrades')).filter((n) => /^backup_\d{14}$/.test(n)).sort();
  ok('4 次整包升级 4 份备份且名字唯一（同秒碰撞会借下一秒）', backs.length === 4 && new Set(backs).size === 4, backs.join(','));
  ok('备份数未超保留上限 5', backs.length <= 5);
}

console.log('\n== E. 依赖变化：先拒后放 ==');
{
  // C 段的备份还要在 H 段下载验证：后面还会产生 2 份备份（a5、纯前端），先把上限提到 20 免得 a1 被挤掉
  const { DatabaseSync } = require('node:sqlite');
  const db2 = new DatabaseSync(path.join(dataDir, 'mask.sqlite'));
  db2.prepare(`INSERT INTO settings (key, value) VALUES ('upgrade_keep_backups', '"20"')`)
    .run();
  db2.close();
}
{
  const deps = { express: '^4.21.2', multer: '^2.2.0', 'fake-dep': '1.0.0' };
  const p = await req('POST', '/api/upgrade/plan', { token: tk, raw: buildPack({ version: REPO_VER + '-a5', dist: '20260303000005', pkgDeps: deps }) });
  ok('预检 200 但 dep_changed=true 且有警告', p.status === 200 && p.json.plan.summary.dep_changed === true
    && p.json.plan.warnings.some((w) => w.includes('依赖')));
  const no = await req('POST', '/api/upgrade/apply', { token: tk, body: { token: p.json.token } });
  ok('不带确认 → 409 DEP_CHANGED', no.status === 409 && no.json.code === 'DEP_CHANGED');
  const yes = await req('POST', '/api/upgrade/apply', { token: tk, body: { token: p.json.token, allow_dep_change: true } });
  ok('带 allow_dep_change=true → 同一 token 应用成功（被拒时未消费，不用重传包）', yes.status === 200 && yes.json.applied === true);
}

console.log('\n== F. 纯前端包：restart_required=false ==');
{
  const zip = (() => {
    const dist = '20260303000006';
    // package.json 直接用磁盘原文（字节一致 → skip）：纯前端包不该因为 pkg 版本差异被迫重启
    const pkgBuf = readFileSync(path.join(repo, 'package.json'));
    const pkgVer = JSON.parse(pkgBuf.toString('utf8')).version;
    const entries = [
      { name: `web/dist/${dist}/index.html`, data: Buffer.from(`<!doctype html><title>fe</title><body>NEW-DIST-${dist}</body>`) },
      { name: `web/dist/${dist}/assets/app.js`, data: Buffer.from('console.log(1)') },
      { name: 'web/dist/.latest', data: Buffer.from(dist) },
      { name: 'package.json', data: pkgBuf },
    ];
    const files = entries.map((e) => ({ path: e.name, sha256: sha256(e.data) }));
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ app: 'mask', kind: 'upgrade-pack', version: pkgVer, files })) });
    return buildZip(entries);
  })();
  const p = await req('POST', '/api/upgrade/plan', { token: tk, raw: zip });
  ok('纯前端包预检通过', p.status === 200 && p.json.plan.restart_required === false);
  ok('预检给出「纯前端」警告', p.json.plan.warnings.some((w) => w.includes('纯前端')));
  const ap = await req('POST', '/api/upgrade/apply', { token: tk, body: { token: p.json.token } });
  ok('应用后 restart=not_needed', ap.status === 200 && ap.json.restart === 'not_needed');
  const page = await fetch(BASE + '/');
  ok('新前端即刻生效（无需重启）', (await page.text()).includes('NEW-DIST-20260303000006'));
}

console.log('\n== G. 413 超限 ==');
{
  const big = buildPack({
    version: REPO_VER + '-a7', dist: '20260303000007',
    extraEntries: [{ name: 'server/big.js', data: '/*' + crypto.randomBytes(1100 * 1024).toString('latin1') + '*/' }],
  });
  ok('造出的包确实 >1MB', big.length > 1024 * 1024, big.length + 'B');
  const r = await req('POST', '/api/upgrade/plan', { token: tk, raw: big });
  ok('超限 → 413 TOO_LARGE', r.status === 413 && r.json.code === 'TOO_LARGE', `实际 ${r.status}/${r.json.code}`);
}

console.log('\n== H. 备份下载 + 升级日志 ==');
{
  const dl = await req('GET', `/api/upgrade/backup/${backup1}/download`, { token: tk });
  ok('备份下载 200 zip', dl.status === 200 && dl.buf && dl.buf.slice(0, 2).toString() === 'PK');
  const inner = extractZip(dl.buf);
  const oldIdx = inner.find((e) => e.name === 'server/index.js');
  ok('备份里是升级前的旧代码', oldIdx && sha256(oldIdx.data) === diskBefore);
  const bad = await req('GET', '/api/upgrade/backup/..%2F..%2Fetc/download', { token: tk });
  ok('备份名白名单（穿越 404）', bad.status === 404);
  const logs = await req('GET', '/api/upgrade/logs?limit=50', { token: tk });
  const rows = logs.json.logs || [];
  ok('日志条数 = 应用次数（6）', rows.length === 6, `实际 ${rows.length}`);
  const last = rows[0];
  ok('最新日志倒序（纯前端包复用磁盘 pkg，版本仍是 -a5）', last.to_version === REPO_VER + '-a5', last.to_version);
  ok('日志解析出 actor/ok/restart_suppressed', last.actor === 'aiadmin' && last.ok === true && last.restart_suppressed === true);
}

console.log('\n== I. 开发机真实仓库未被动过 ==');
{
  // 自检全程只该写临时副本；这里对真实仓库做一次防御性核对
  ok('真实 server/ 与启动时一致', sha256(readFileSync(path.join(ROOT, 'server', 'index.js'))) === diskBefore);
}

// ---- 收尾 ----
child.kill();
try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，留给系统清理 */ }
console.log(`\ncheck-upgrade：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
