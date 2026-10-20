'use strict';
// 外部引擎依赖安装器（v0.4.2）：把 server/services/enginesInstaller.js 做成网页可触发的一次性任务。
//
// 为什么要它：Docker 镜像默认 MASK_NO_SETUP=1，升级包又写不了 vendor/ 下的二进制；
// 管理员在「设置 → 引擎」点一下就能在线上拉依赖、编译 godlp / sensitive-word，不必重建镜像。
//
// 边界：
//  * 只有管理员能触发（路由层已闸），scope 只认 cli/python/all，绝不接受任意命令；
//  * 同一时刻只跑一个任务，第二个请求回 409（两个安装器并发会互相覆盖）；
//  * 输出写 Logs/engines-setup-<ts>.log（或 MASK_ENGINE_SETUP_LOG_DIR），内存只留最后 500 行；
//  * 安装器自己负责「已装则跳过」，这里不做任何联网或解压逻辑。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// 安装器本体在 server/services/：升级白名单只带 server/**.js，放 scripts/ 的话线上升级带不过去
const SCRIPT = process.env.MASK_ENGINES_SETUP_SCRIPT || path.join(ROOT, 'server', 'services', 'enginesInstaller.js');
const LOG_DIR = process.env.MASK_ENGINE_SETUP_LOG_DIR || path.join(ROOT, 'Logs');
const SCOPES = new Set(['cli', 'python', 'all']);
const MAX_LINES = 500;

let state = {
  running: false, scope: '', started_at: '', finished_at: '',
  ok: null, exit_code: null, error: '', log_file: '', lines: [],
};
let child = null;
let logStream = null;

function snapshot() {
  return {
    running: state.running, scope: state.scope,
    started_at: state.started_at, finished_at: state.finished_at,
    ok: state.ok, exit_code: state.exit_code, error: state.error,
    log_file: state.log_file, lines: state.lines.slice(-200),
    platform: process.platform, arch: process.arch,
    cli_supported: process.platform === 'win32' || process.platform === 'linux',
  };
}

function push(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    state.lines.push(line);
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
    if (logStream) { try { logStream.write(line + '\n'); } catch { /* 磁盘满不炸任务 */ } }
  }
}

function start(scope) {
  if (!SCOPES.has(scope)) {
    const e = new Error('scope 只支持 cli / python / all');
    e.status = 400;
    throw e;
  }
  if (state.running) {
    const e = new Error(`已有安装任务在跑（${state.scope}），等它结束再点`);
    e.status = 409;
    throw e;
  }
  if (!fs.existsSync(SCRIPT)) {
    const e = new Error(`安装脚本不存在：${SCRIPT}`);
    e.status = 500;
    throw e;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  state = {
    running: true, scope, started_at: new Date().toISOString(), finished_at: '',
    ok: null, exit_code: null, error: '',
    log_file: path.join(LOG_DIR, `engines-setup-${ts}.log`), lines: [],
  };
  logStream = fs.createWriteStream(state.log_file, { flags: 'a' });
  push(`[engines-setup] 开始安装（scope=${scope}，平台 ${process.platform}/${process.arch}）`);

  child = spawn(process.execPath, [SCRIPT, `--only=${scope}`], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (err) => {
    push(`[engines-setup] 启动失败：${err.message}`);
    finish(null, err.message);
  });
  child.on('close', (code, signal) => {
    const why = code === 0 ? '' : (signal ? `进程被 ${signal} 终止` : `安装脚本退出码 ${code}`);
    finish(code, why);
  });
  return snapshot();
}

function finish(code, error) {
  if (!state.running) return; // error 与 close 可能都到，只认第一次
  state.running = false;
  state.exit_code = code;
  state.ok = code === 0;
  state.error = code === 0 ? '' : (error || '安装脚本失败');
  state.finished_at = new Date().toISOString();
  push(code === 0 ? '[engines-setup] 结束：成功' : `[engines-setup] 结束：失败（${error || '未知原因'}）`);
  if (logStream) { try { logStream.end(); } catch { /* ignore */ } logStream = null; }
  child = null;
}

// 供进程退出/自检清理用
function stop() {
  if (!child) return false;
  try { child.kill(); } catch { /* 已退出 */ }
  return true;
}

module.exports = { start, status: snapshot, stop };
