#!/usr/bin/env node
// 面具 mask — 外部引擎依赖安装按钮自检（v0.4.2）
// 覆盖：权限（匿名 401 / 普通用户 403）/ scope 白名单 / 单任务互斥（409）/
//       进度与日志采集 / 成功与失败退出码 / 结束后可再次触发 / 日志落盘 / 真实脚本参数校验
// 用 MASK_ENGINES_SETUP_SCRIPT 把安装器换成临时 mock——自检绝不联网下载 GB 级依赖。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9931;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-setup-'));
const logDir = mkdtempSync(path.join(tmpdir(), 'mask-setup-log-'));
const mock = path.join(dataDir, 'mock-setup.mjs');
const failFlag = path.join(dataDir, 'fail.flag');
// mock 是 ESM：用 import 而不是 require
writeFileSync(mock, `
import { existsSync } from 'node:fs';
const only = process.argv.find((a) => a.startsWith('--only=')) || '--only=all';
console.log('[engines-setup] 开始 ' + only);
console.log('[engines-setup] 下载示例依赖…');
setTimeout(() => {
  if (process.env.MOCK_SETUP_FAIL_FILE && existsSync(process.env.MOCK_SETUP_FAIL_FILE)) {
    console.error('[engines-setup] 失败：模拟下载错误');
    process.exit(1);
  }
  console.log('[engines-setup] 全部就绪。');
}, 900);
`.trimStart(), 'utf8');

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    MASK_NO_SIDECAR: '1',
    MASK_DATA_DIR: dataDir,
    MASK_ENGINES_SETUP_SCRIPT: mock,
    MASK_ENGINE_SETUP_LOG_DIR: logDir,
    MOCK_SETUP_FAIL_FILE: failFlag,
    PORT: String(PORT),
    MASK_GEO: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

async function waitDone(tk, ms = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    const r = await req('GET', '/api/engines/setup/status', { token: tk });
    last = r.json;
    if (last && last.running === false) return last;
    await sleep(150);
  }
  return last;
}

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250);
  try { up = (await fetch(BASE + '/api/health')).ok; } catch { /* 未起 */ }
}
if (!up) { console.error('服务未能在 10s 内启动'); child.kill(); process.exit(1); }

try {
  const lo = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'admin123' } });
  const tk = lo.json.token;
  ok('S0 管理员登录', !!tk);
  await req('POST', '/api/users', { token: tk, body: { username: 'u_setup', password: 'u123456', role: 'user', display_name: '安装测试' } });
  const l2 = await req('POST', '/api/auth/login', { body: { username: 'u_setup', password: 'u123456' } });
  const tk2 = l2.json.token;

  console.log('S. 依赖安装接口');
  ok('S1 匿名查状态 401', (await req('GET', '/api/engines/setup/status')).status === 401);
  ok('S2 普通用户查状态 403', (await req('GET', '/api/engines/setup/status', { token: tk2 })).status === 403);
  ok('S3 普通用户触发 403', (await req('POST', '/api/engines/setup', { token: tk2, body: { scope: 'cli' } })).status === 403);

  const st0 = await req('GET', '/api/engines/setup/status', { token: tk });
  ok('S4 初始状态 200 且未运行', st0.status === 200 && st0.json.running === false, JSON.stringify(st0.json));
  ok('S5 状态里带平台信息', typeof st0.json.platform === 'string' && typeof st0.json.cli_supported === 'boolean');

  const bad = await req('POST', '/api/engines/setup', { token: tk, body: { scope: 'rm -rf /' } });
  ok('S6 非法 scope 400', bad.status === 400, `status=${bad.status} ${bad.json.error || ''}`);

  const r1 = await req('POST', '/api/engines/setup', { token: tk, body: { scope: 'cli' } });
  ok('S7 触发安装 200 且 running', r1.status === 200 && r1.json.running === true && r1.json.scope === 'cli', JSON.stringify(r1.json));
  const r2 = await req('POST', '/api/engines/setup', { token: tk, body: { scope: 'python' } });
  ok('S8 并发第二个任务 409', r2.status === 409, `status=${r2.status}`);

  const done = await waitDone(tk);
  ok('S9 安装成功结束', done.running === false && done.ok === true && done.exit_code === 0, JSON.stringify(done).slice(0, 300));
  ok('S10 日志行被采集', Array.isArray(done.lines) && done.lines.some((l) => l.includes('全部就绪')), (done.lines || []).join(' | ').slice(0, 200));
  ok('S11 日志文件已落盘', !!done.log_file && existsSync(done.log_file) && readFileSync(done.log_file, 'utf8').includes('全部就绪'), done.log_file);
  ok('S12 结束时带 finished_at', !!done.finished_at);

  const r3 = await req('POST', '/api/engines/setup', { token: tk, body: { scope: 'cli' } });
  ok('S13 上一单结束后可再次触发', r3.status === 200 && r3.json.running === true);
  await waitDone(tk);

  writeFileSync(failFlag, '1', 'utf8');
  await req('POST', '/api/engines/setup', { token: tk, body: { scope: 'cli' } });
  const failed = await waitDone(tk);
  rmSync(failFlag, { force: true });
  ok('S14 失败时 ok=false 且带退出码', failed.running === false && failed.ok === false && failed.exit_code === 1, JSON.stringify(failed).slice(0, 300));
  ok('S15 失败原因与日志可读', !!failed.error && (failed.lines || []).some((l) => l.includes('模拟下载错误')), failed.error);

  console.log('T. 真实安装脚本参数校验');
  const badScope = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'engines-setup.mjs'), '--only=bogus'], { encoding: 'utf8' });
  ok('T1 --only 非法值退出码 2', badScope.status === 2, `status=${badScope.status} ${badScope.stderr || ''}`);
  ok('T2 非法值不产生任何写入（未开始下载）', !/下载/.test((badScope.stdout || '') + (badScope.stderr || '')));

  console.log('U. 解包目录搬移（v0.4.3 生产 EXDEV 事故回归）');
  const installerPath = path.join(ROOT, 'server', 'services', 'enginesInstaller.js');
  const { _moveInnerDir, _vendorTargetsFor } = require(installerPath);
  const targetsAtVendor = _vendorTargetsFor(path.join(ROOT, 'vendor'));
  ok('U1 目标目录都在运行时目录下（不能拼到项目根）',
    Object.values(targetsAtVendor).every((d) => path.dirname(d) === path.join(ROOT, 'vendor')),
    JSON.stringify(targetsAtVendor));

  const mkTmp = () => {
    const t = mkdtempSync(path.join(tmpdir(), 'mask-move-'));
    mkdirSync(path.join(t, 'inner', 'bin'), { recursive: true });
    writeFileSync(path.join(t, 'inner', 'bin', 'java'), 'x', 'utf8');
    return t;
  };
  const t1 = mkTmp();
  const d1 = path.join(mkdtempSync(path.join(tmpdir(), 'mask-dest-')), 'jdk');
  try {
    _moveInnerDir(t1, d1);
    ok('U2 解出的单一目录被搬到目标路径', existsSync(path.join(d1, 'bin', 'java')) && !existsSync(t1));
  } finally { rmSync(t1, { recursive: true, force: true }); rmSync(path.dirname(d1), { recursive: true, force: true }); }

  // 强制走复制分支：模拟 Docker 里 vendor 被挂载、跨设备 rename 报 EXDEV
  const t2 = mkTmp();
  const d2 = path.join(mkdtempSync(path.join(tmpdir(), 'mask-dest2-')), 'go');
  const prev = process.env.MASK_TEST_FORCE_EXDEV;
  process.env.MASK_TEST_FORCE_EXDEV = '1';
  try {
    _moveInnerDir(t2, d2);
    ok('U3 跨设备时退回复制且源目录已清掉', existsSync(path.join(d2, 'bin', 'java')) && !existsSync(t2));
  } finally {
    if (prev === undefined) delete process.env.MASK_TEST_FORCE_EXDEV; else process.env.MASK_TEST_FORCE_EXDEV = prev;
    rmSync(t2, { recursive: true, force: true }); rmSync(path.dirname(d2), { recursive: true, force: true });
  }

  console.log('V. 内置构建源码（旧镜像 / vendor 被挂载时自给自足）');
  const { _ensureSources, _sourcesReady } = require(path.join(ROOT, 'server', 'services', 'enginesInstaller.js'));
  const embedded = require(path.join(ROOT, 'server', 'services', 'engineSources.js'));
  const { extractZip } = require(path.join(ROOT, 'server', 'services', 'zipService.js'));
  const srcEntries = extractZip(Buffer.from(embedded.zip_b64, 'base64'));
  ok('V1 内置源码是非空 zip 且条目数对得上', srcEntries.length === embedded.entries && srcEntries.length > 10,
    `${srcEntries.length} vs ${embedded.entries}`);

  // 源码改了却忘记重跑 scripts/build-engine-sources.mjs → 这里必须红
  const drift = srcEntries.filter((e) => {
    const disk = path.join(ROOT, 'vendor', ...e.name.split('/'));
    return existsSync(disk) && !readFileSync(disk).equals(e.data);
  });
  ok('V2 内置源码与 vendor/ 里的文件一致（改了源码要重跑生成脚本）',
    drift.length === 0, drift.slice(0, 3).map((e) => e.name).join('、'));

  const vdir = mkdtempSync(path.join(tmpdir(), 'mask-src-'));
  try {
    ok('V3 空目录里识别为「源码缺失」', _sourcesReady(vdir) === false);
    _ensureSources(vdir);
    ok('V4 内置源码能铺开且三处探针齐全', _sourcesReady(vdir) === true
      && existsSync(path.join(vdir, 'godlp-cli', 'main.go'))
      && existsSync(path.join(vdir, 'engines-src', 'godlp', 'go.mod'))
      && existsSync(path.join(vdir, 'sensitive-word-workspace', 'src', 'main', 'java', 'local', 'mask', 'SensitiveWordCli.java')));
  } finally { rmSync(vdir, { recursive: true, force: true }); }

  console.log('W. 运行时目录降级（v0.4.5 生产 noexec 挂载 EACCES 事故回归）');
  const { _canExecIn } = require(installerPath);
  const execDir = mkdtempSync(path.join(tmpdir(), 'mask-exec-'));
  try {
    const can = _canExecIn(execDir);
    // Windows 没有执行位/noexec，恒 true；Linux 上真写脚本跑一次
    ok('W1 普通目录判定为可执行', can === true, `canExecIn=${can}`);
    ok('W2 探测脚本用完即删', readdirSync(execDir).length === 0, readdirSync(execDir).join(','));
  } finally { rmSync(execDir, { recursive: true, force: true }); }

  const exe = process.platform === 'win32' ? '.exe' : '';
  const restOf = (script, env) => {
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', cwd: ROOT,
      env: { ...process.env, MASK_ENGINES_HOME: '', MASK_ENGINES_MARKER: '', ...env },
    });
    const line = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
    try { return JSON.parse(line); } catch { return { parse_error: line, stderr: (r.stderr || '').slice(-400) }; }
  };

  // 模拟 vendor 不能执行：安装器应把 JDK/Go/Maven 目标挪到降级目录，并真的建出来
  const fb = path.join(mkdtempSync(path.join(tmpdir(), 'mask-fb-')), 'engines');
  try {
    const r = restOf(`
      const m = require(${JSON.stringify(installerPath)});
      const fs = require('node:fs');
      const h = m._resolveEnginesHome();
      console.log(JSON.stringify({ h, targets: m._vendorTargetsFor(h), created: fs.existsSync(h) }));
    `, { MASK_TEST_VENDOR_NOEXEC: '1', MASK_TEST_ENGINES_FALLBACK: fb });
    ok('W3 vendor 不能执行时降级到备用目录',
      r.h === fb && r.created === true, JSON.stringify(r));
    ok('W4 降级后三个工具链目标跟着走',
      r.targets && r.targets.jdk === path.join(fb, 'jdk') && r.targets.go === path.join(fb, 'go')
      && r.targets.maven === path.join(fb, 'maven'), JSON.stringify(r.targets));
  } finally { rmSync(path.dirname(fb), { recursive: true, force: true }); }

  // 标点文件：安装器写下来之后，引擎默认命令要真的指过去（运行中的服务不需要重启改配置）
  const mk = mkdtempSync(path.join(tmpdir(), 'mask-marker-'));
  try {
    const home2 = path.join(mk, 'runtime');
    // 真项目里 vendor/ 可能已经有 jar/java（镜像构建产物），要断言「降级目录优先」，
    // 降级目录这边也得有文件，否则解析会合理地去挑 vendor 里那份
    mkdirSync(path.join(home2, 'godlp'), { recursive: true });
    mkdirSync(path.join(home2, 'jdk', 'bin'), { recursive: true });
    mkdirSync(path.join(home2, 'sensitive-word'), { recursive: true });
    writeFileSync(path.join(home2, 'godlp', 'godlp-cli' + exe), 'x', 'utf8');
    writeFileSync(path.join(home2, 'jdk', 'bin', 'java' + exe), 'x', 'utf8');
    writeFileSync(path.join(home2, 'sensitive-word', 'sensitive-word-cli.jar'), 'x', 'utf8');
    const marker = path.join(mk, 'home.json');
    writeFileSync(marker, JSON.stringify({ home: home2 }), 'utf8');
    const r = restOf(`
      const p = require(${JSON.stringify(path.join(ROOT, 'server', 'engines', 'paths.js'))});
      const e = require(${JSON.stringify(path.join(ROOT, 'server', 'engines', 'index.js'))});
      const g = e.ENGINES.find((x) => x.id === 'godlp');
      const s = e.ENGINES.find((x) => x.id === 'sensitive_word');
      console.log(JSON.stringify({ home: p.home(), godlp: p.paths().godlp, cmd: g.defCommand, sw: s.defCommand }));
    `, { MASK_ENGINES_MARKER: marker });
    ok('W5 标点文件里的运行时目录被读出来', r.home === home2, JSON.stringify(r));
    ok('W6 godlp 默认命令指向降级目录里的二进制',
      r.cmd === `"${path.join(home2, 'godlp', 'godlp-cli' + exe)}"`, String(r.cmd));
    ok('W7 sensitive-word 默认命令跟着换 java 与 jar 路径',
      String(r.sw).includes(path.join(home2, 'jdk')) && String(r.sw).includes(path.join(home2, 'sensitive-word')),
      String(r.sw));

    // 标点文件写坏了（安装器被杀）→ 退回 vendor，不能让引擎凭空消失
    writeFileSync(marker, '{"home": ', 'utf8');
    const bad = restOf(`
      const p = require(${JSON.stringify(path.join(ROOT, 'server', 'engines', 'paths.js'))});
      console.log(JSON.stringify({ home: p.home() }));
    `, { MASK_ENGINES_MARKER: marker });
    ok('W8 标点文件损坏时退回 vendor', bad.home === path.join(ROOT, 'vendor'), JSON.stringify(bad));
  } finally { rmSync(mk, { recursive: true, force: true }); }
} finally {
  child.kill();
  await sleep(300);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
