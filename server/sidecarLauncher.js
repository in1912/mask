// 本地引擎边车自动拉起（v0.3.2）
//
// 面具启动时如果 http://127.0.0.1:9812 上没有边车，就自己拉一个 python/sidecar.py，
// 这样用户点「探测」时不需要另开一个终端。规则：
//   * 只在边车地址是本机回环时拉起（远程边车由用户自己管）；
//   * MASK_NO_SIDECAR=1 时完全不碰（自检脚本用，避免和它们自己起的边车抢端口）；
//   * 拉不起来不拦主服务：控制台与 Logs/sidecar.log 如实写原因，探测页照常报错；
//   * 原文不落盘——日志只记启动/健康检查结果。
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'Logs');
const LOG_FILE = path.join(LOG_DIR, 'sidecar.log');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pythonCommand() {
  return process.env.MASK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function sidecarTarget(url) {
  try {
    const u = new URL(url);
    if (!LOCAL_HOSTS.has(u.hostname)) return null;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 0) return null;
    if (port === Number(process.env.PORT || 9909)) return null; // 自己的端口，绝不拉起
    return { port, base: `http://127.0.0.1:${port}` };
  } catch {
    return null;
  }
}

async function healthy(base, timeoutMs = 900) {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) return { ok: false, why: '响应不是边车格式（可能填了别的服务地址）' };
    return { ok: true, json: j };
  } catch (e) {
    return { ok: false, why: e.name === 'TimeoutError' ? '连接超时' : (e.cause?.code || e.message) };
  }
}

function logLine(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 日志写不了也不影响主服务 */ }
}

async function ensureSidecar(getSidecarUrl) {
  if (process.env.MASK_NO_SIDECAR === '1') return { skipped: 'MASK_NO_SIDECAR=1' };
  const url = getSidecarUrl();
  const target = sidecarTarget(url);
  if (!target) {
    console.log(`[sidecar] 边车地址 ${url} 不是本机回环地址，跳过自动拉起（请自行保证它在运行）`);
    return { skipped: 'remote' };
  }

  const before = await healthy(target.base);
  if (before.ok) {
    console.log(`[sidecar] 已有边车在 ${target.base}，直接使用`);
    return { reused: true };
  }

  const py = pythonCommand();
  const pyCheck = spawnSync(py, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (pyCheck.status !== 0) {
    const why = `找不到 Python（命令 ${py}${pyCheck.error ? '：' + pyCheck.error.message : ''}）`;
    console.warn(`[sidecar] 无法自动拉起：${why}。外部引擎不可用，内置规则引擎不受影响。`);
    logLine(`启动失败：${why}`);
    return { error: why };
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(py, ['-u', path.join(ROOT, 'python', 'sidecar.py'), '--port', String(target.port)], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env },
  });
  child.unref();
  fs.closeSync(fd);
  if (child.pid) logLine(`已拉起 sidecar pid=${child.pid} port=${target.port}`);

  // 最多等 20 秒；边车纯标准库起服务，正常 1 秒内就绪
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const h = await healthy(target.base);
    if (h.ok) {
      console.log(`[sidecar] 已自动拉起边车 ${target.base}（日志 Logs/sidecar.log）`);
      logLine(`就绪：${target.base}`);
      return { started: true };
    }
  }
  const why = `边车进程已启动（pid ${child.pid || '?'}）但 20 秒内没响应 ${target.base}/health，详情看 Logs/sidecar.log`;
  console.warn(`[sidecar] ${why}`);
  logLine(`就绪检查失败：${why}`);
  return { error: why };
}

module.exports = { ensureSidecar, sidecarTarget };
