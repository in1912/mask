#!/usr/bin/env node
// 面具 mask — 升级自我接替链路验证（唯一覆盖「升级→进程自我接替→新版真在跑」的脚本）
// check-upgrade 带 MASK_NO_RESTART=1 只验到文件落盘；本脚本造一个「旧版部署目录」真跑一遍：
//   旧部署(0.2.9-old) → 上传真升级包 → apply → 老进程退出 → detached 子进程抢回端口 → v0.3.0 上线。
// 用法：node scripts/verify-upgrade-restart.mjs [升级包.zip]
//   缺省找项目根最新的 面具-*-upgrade.zip（先 npm run build:web && npm run pack:upgrade）
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9933;
const BASE = `http://127.0.0.1:${PORT}`;
const OLD_VER = '0.2.9-old';

// 找升级包：CLI 参数 > 项目根最新 面具-*-upgrade.zip
function findPack() {
  if (process.argv[2]) return process.argv[2];
  const cands = readdirSync(ROOT).filter((f) => /^面具-.*-upgrade\.zip$/.test(f)).map((f) => ({ f, m: statSync(path.join(ROOT, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!cands.length) throw new Error('没找到升级包：先 npm run build:web && npm run pack:upgrade，或把 zip 路径作为参数传入');
  return path.join(ROOT, cands[0].f);
}
const PACK = path.resolve(findPack());

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${JSON.stringify(detail).slice(0, 300)}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const copyServer = (dest) => {
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(ROOT, 'server'), path.join(dest, 'server'), { recursive: true, filter: (s) => !s.includes(`${path.sep}node_modules`) });
};

const deployDir = mkdtempSync(path.join(tmpdir(), 'mask-deploy-'));
const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-data-'));

// 临时部署目录里没有 node_modules：借仓库的（NODE_PATH 对 CJS require 依然生效，接替子进程会继承）
const NODE_PATH = path.join(ROOT, 'node_modules');
let srvLog = '';
let oldExited = false;
let srv;

try {
  // ---- 造旧版部署目录 ----
  copyServer(deployDir);
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const NEW_VER = pkg.version;
  writeFileSync(path.join(deployDir, 'package.json'), JSON.stringify({ ...pkg, version: OLD_VER }, null, 2) + '\n');
  mkdirSync(path.join(deployDir, 'web', 'dist', '20260101000000'), { recursive: true });
  writeFileSync(path.join(deployDir, 'web', 'dist', '20260101000000', 'index.html'), '<!doctype html><title>old</title>');
  console.log(`旧部署：${deployDir}（v${OLD_VER}）\n升级包：${PACK}（v${NEW_VER}）`);

  const startOld = () => new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['--no-warnings', path.join(deployDir, 'server', 'index.js')], {
      cwd: deployDir,
      env: { ...process.env, MASK_DATA_DIR: dataDir, MASK_UPGRADE_ROOT: deployDir, MASK_WEB_ROOT: path.join(deployDir, 'web', 'dist'), PORT: String(PORT), MASK_GEO: 'off', NODE_PATH },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    srv.stderr.on('data', (d) => { srvLog += d; });
    srv.stdout.on('data', (d) => { srvLog += d; });
    srv.on('exit', () => { oldExited = true; });
    const t0 = Date.now();
    (async function poll() {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) return resolve(); } catch { /* 还没起 */ }
      if (Date.now() - t0 > 20000) return reject(new Error('旧版没起来：' + srvLog.slice(-800)));
      setTimeout(poll, 300);
    })();
  });
  await startOld();

  const lo = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'aiadmin', password: 'admin123' }) })).json();
  const tk = lo.token;
  const sys0 = await (await fetch(BASE + '/api/system-info')).json();
  ok('A1 旧版在跑', sys0.version === OLD_VER, sys0);

  // ---- 预检 + 应用（真重启，不带 MASK_NO_RESTART）----
  const zipBuf = readFileSync(PACK);
  const pl = await (await fetch(BASE + '/api/upgrade/plan', { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: zipBuf })).json();
  ok('A2 预检通过且需要重启', !!pl.token && pl.plan.restart_required === true, { plan: pl.plan && pl.plan.files && pl.plan.files.filter((f) => f.action !== 'skip').length, err: pl.error });
  const ap = await (await fetch(BASE + '/api/upgrade/apply', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ token: pl.token }) })).json();
  ok('A3 apply 发起接替', ap.applied === true && ap.restart === 'scheduled', { restart: ap.restart, note: ap.restart_note });
  // pid 在 finish 后由旧进程打出（响应里拿不到）：从捕获的 stdout 里解析，用于收尾杀进程
  var childPid = 0;
  for (let i = 0; i < 40 && !childPid; i++) { childPid = Number(/已拉起接替进程 pid (\d+)/.exec(srvLog)?.[1] || 0); if (!childPid) await sleep(250); }

  // ---- 等新版上线（只许裸 fetch /api/system-info：EXEMPT 免登录，重启窗口里 401 会误判）----
  let sys1 = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try {
      const r = await fetch(BASE + '/api/system-info');
      if (r.ok) { const j = await r.json(); if (j.version === NEW_VER) { sys1 = j; break; } }
    } catch { /* 接替窗口里连不上是预期 */ }
    await sleep(400);
  }
  ok('B1 新版本真在跑（system-info=包版本）', !!sys1, sys1);
  ok('B2 老进程已退出', oldExited, { pid: srv.pid });
  ok('B3 接替耗时 < 10s', Date.now() - t0 < 10000, Date.now() - t0);

  // ---- 落盘证据 ----
  const latest = readFileSync(path.join(deployDir, 'web', 'dist', '.latest'), 'utf8').trim();
  ok('C1 新 dist 目录已落盘且 .latest 指向它', /^\d{12}$/.test(latest) && existsSync(path.join(deployDir, 'web', 'dist', latest, 'index.html')), latest);
  const backups = readdirSync(path.join(dataDir, 'upgrades')).filter((f) => /^backup_\d{14}$/.test(f));
  ok('C2 备份目录存在（可回滚）', backups.length >= 1, backups);
  const state = JSON.parse(readFileSync(path.join(dataDir, 'upgrades', 'state.json'), 'utf8'));
  ok('C3 state.json 交接握手完成（restart_pending=false）', state.restart_pending === false && !!state.handoff_at, state);
  const childLog = readFileSync(path.join(deployDir, 'Logs', 'restart-child.log'), 'utf8');
  ok('C4 接替日志有新旧两代进程记录', /发起重启交接/.test(childLog) && /已启动/.test(childLog), childLog.slice(-400));
  const logs = await (await fetch(BASE + '/api/upgrade/logs?limit=3', { headers: { Authorization: 'Bearer ' + tk } })).json();
  const last = logs.logs && logs.logs[0];
  ok('C5 升级日志落库（restarted 布尔）', last && last.to_version === NEW_VER && last.restarted === true, last);

  // ---- 收尾：按 pid 收掉接替进程（绝不用 /IM node.exe 误伤别的）----
  if (childPid) {
    spawn('powershell', ['-NoProfile', 'Stop-Process', '-Id', String(childPid), '-ErrorAction', 'SilentlyContinue'], { stdio: 'ignore' });
    console.log(`已收接替进程 pid ${childPid}`);
  }
} catch (e) {
  fail++;
  console.log('FATAL', e.message);
  if (srvLog) console.log('--- server log ---\n' + srvLog.slice(-1200));
  try { const out = spawn('powershell', ['-NoProfile', "Get-NetTCPConnection -LocalPort " + PORT + " -State Listen | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -ErrorAction SilentlyContinue }"], { stdio: 'ignore' }); out.on('error', () => {}); } catch { /* 尽力 */ }
} finally {
  await sleep(600);
}

console.log(`\nverify-upgrade-restart：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
