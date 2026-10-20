// 本地引擎边车自动拉起 + 监管（v0.4.10）
//
// 面具启动时如果 http://127.0.0.1:9812 上没有边车，就自己拉一个 python/sidecar.py，
// 这样用户点「探测」时不需要另开一个终端。规则：
//   * 只在边车地址是本机回环时拉起（远程边车由用户自己管）；
//   * MASK_NO_SIDECAR=1 时完全不碰（自检脚本用，避免和它们自己起的边车抢端口）；
//   * 拉不起来不拦主服务：控制台与 Logs/sidecar.log 如实写原因，探测页照常报错；
//   * 原文不落盘——日志只记启动/健康检查结果。
//
// v0.4.10：生产报「边车连不上 UND_ERR_SOCKET」时，界面上只有一个干巴巴的错误，
// 没人知道边车是没起、起了又崩、还是根本没让起。现在这里记住进程状态与退出码，
// 探测失败时会自动尝试拉一次，并把 Logs/sidecar.log 的最后几行贴进错误里。
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'Logs');
const LOG_FILE = path.join(LOG_DIR, 'sidecar.log');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 容器/Windows 上 python3 / python 哪个在 PATH 里不固定：逐个试，记住能用的那个。
// 生产 v0.4.9 只 spawn 不检查，pyspawn ENOENT 时界面只剩一句 UND_ERR_SOCKET。
let cachedPython = null;
function pythonCommand() {
  if (cachedPython) return cachedPython;
  const cands = [process.env.MASK_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const c of [...new Set(cands)]) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r.status === 0) { cachedPython = c; return c; }
  }
  return null;
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

async function healthy(base, timeoutMs = 1200) {
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

// 边车自己的输出（traceback 之类）也在同一个文件里——报错时直接贴出来，省得用户还得进容器翻
function tailLines(n = 15) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split(/\r?\n/);
    return lines.slice(-n).join('\n');
  } catch { return ''; }
}

// 进程状态：给错误信息用，别让用户猜
const state = {
  base: null, pid: null, phase: 'idle',  // idle | starting | ready | failed | exited | skipped
  startedAt: 0, lastExit: null, attempts: 0, error: null, skipped: null,
};
let child = null;
let pending = null;      // 正在等待就绪的 promise，避免同时拉起两个

function spawnSidecar(target, py) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(LOG_FILE, 'a');
  let ch;
  try {
    ch = spawn(py, ['-u', path.join(ROOT, 'python', 'sidecar.py'), '--port', String(target.port)], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env },
    });
  } finally {
    fs.closeSync(fd);
  }
  child = ch;
  state.pid = ch.pid || null;
  state.base = target.base;
  state.phase = 'starting';
  state.startedAt = Date.now();
  state.attempts += 1;
  state.error = null;

  // 没有 error 监听的话，spawn 失败会变成未捕获异常，把整个主服务带下去
  ch.on('error', (e) => {
    state.phase = 'failed';
    state.error = `启动失败：${e.code || e.message}`;
    logLine(`[launcher] ${state.error}（命令 ${py}）`);
  });
  ch.on('exit', (code, signal) => {
    state.lastExit = { code, signal, at: new Date().toISOString() };
    if (state.phase !== 'ready') {
      state.phase = 'failed';
      state.error = `进程退出（code=${code}${signal ? ` signal=${signal}` : ''}）`;
    } else {
      state.phase = 'exited';
      state.error = `边车在运行中退出（code=${code}${signal ? ` signal=${signal}` : ''}）`;
    }
    child = null;
    state.pid = null;
    logLine(`[launcher] ${state.error}`);
  });
  ch.unref();
  return ch;
}

async function waitReady(target, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const h = await healthy(target.base, 900);
    if (h.ok) {
      state.phase = 'ready';
      state.error = null;
      logLine(`[launcher] 就绪：${target.base}`);
      return { ok: true };
    }
    // 进程已经没了就别傻等
    if (!child && state.phase === 'failed') return { ok: false };
    await sleep(400);
  }
  return { ok: false };
}

async function start(target, waitMs = 25000) {
  if (pending) return pending;
  pending = (async () => {
    const before = await healthy(target.base);
    if (before.ok) { state.phase = 'ready'; state.base = target.base; return { ok: true, reused: true }; }

    // 已经有一个自己拉起的进程还在启动中：别再 spawn 第二个抢同一个端口，接着等它
    if (child) {
      const r = await waitReady(target, waitMs);
      if (r.ok) return { ok: true };
      if (state.phase === 'starting') {
        state.phase = 'failed';
        state.error = `${waitMs}ms 内没响应 ${target.base}/health（进程还在但不健康）`;
        logLine(`[launcher] ${state.error}`);
      }
      return { ok: false, why: state.error || '边车没在预期时间内就绪' };
    }

    const script = path.join(ROOT, 'python', 'sidecar.py');
    if (!fs.existsSync(script)) {
      const why = `安装目录里没有 python/sidecar.py（${script}）——镜像/安装包不完整，重新部署后再试`;
      state.phase = 'failed'; state.error = why;
      logLine(`[launcher] ${why}`);
      return { ok: false, why };
    }

    const py = pythonCommand();
    if (!py) {
      const why = '找不到 Python（python3 / python 都不在 PATH 里）——装好 Python 3 后重启服务，或在 compose 里设 MASK_PYTHON 指向解释器';
      state.phase = 'failed'; state.error = why;
      logLine(`[launcher] ${why}`);
      return { ok: false, why };
    }

    const ch = spawnSidecar(target, py);
    logLine(`[launcher] 已拉起 sidecar pid=${ch.pid || '?'} port=${target.port}`);
    const r = await waitReady(target, waitMs);
    if (!r.ok && state.phase !== 'failed') {
      state.phase = 'failed';
      state.error = `${waitMs}ms 内没响应 ${target.base}/health（进程${child ? '还在' : '已退出'}）`;
      logLine(`[launcher] ${state.error}`);
    }
    return { ok: r.ok, why: state.error || undefined };
  })();
  try { return await pending; } finally { pending = null; }
}

async function ensureSidecar(getSidecarUrl) {
  if (process.env.MASK_NO_SIDECAR === '1') {
    state.phase = 'skipped'; state.skipped = 'MASK_NO_SIDECAR=1';
    return { skipped: 'MASK_NO_SIDECAR=1' };
  }
  const url = getSidecarUrl();
  const target = sidecarTarget(url);
  if (!target) {
    state.phase = 'skipped'; state.skipped = 'remote';
    console.log(`[sidecar] 边车地址 ${url} 不是本机回环地址，跳过自动拉起（请自行保证它在运行）`);
    return { skipped: 'remote' };
  }
  const before = await healthy(target.base);
  if (before.ok) {
    state.phase = 'ready'; state.base = target.base;
    console.log(`[sidecar] 已有边车在 ${target.base}，直接使用`);
    return { reused: true };
  }
  const r = await start(target);
  if (r.ok) {
    console.log(`[sidecar] 已自动拉起边车 ${target.base}（日志 Logs/sidecar.log）`);
  } else {
    console.warn(`[sidecar] 自动拉起失败：${state.error || '未知原因'}（日志 ${LOG_FILE}）`);
  }
  return r.ok ? { started: true } : { error: state.error || '未知原因' };
}

// 探测/脱敏连不上时调它：本机地址就再拉一次，返回是否恢复
async function recover(base, waitMs = 20000) {
  if (process.env.MASK_NO_SIDECAR === '1') return { ok: false, skipped: true };
  const target = sidecarTarget(base);
  if (!target) return { ok: false, remote: true };
  if (state.phase === 'ready' && state.base === target.base) {
    const h = await healthy(target.base);
    if (h.ok) return { ok: true };
  }
  const r = await start(target, waitMs);
  return { ok: r.ok };
}

// 内存现状：GLiNER/OPF 加载权重时 OOM 被强杀，在界面上和「连不上」长得一模一样，
// 把容器内存上限和可用量直接写进错误里，省得靠猜
function memInfo() {
  if (process.platform !== 'linux') return null;
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
  let raw = read('/sys/fs/cgroup/memory.max'); // cgroup v2
  if (!raw || raw === 'max') raw = read('/sys/fs/cgroup/memory/memory.limit_in_bytes'); // v1
  let limit = 0;
  if (raw && raw !== 'max') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 1e15) limit = n / 1073741824; // 无限制时是天文数字
  }
  const mi = read('/proc/meminfo');
  const total = /MemTotal:\s+(\d+) kB/.exec(mi);
  const avail = /MemAvailable:\s+(\d+) kB/.exec(mi);
  const gib = (m) => (m ? (Number(m[1]) / 1048576).toFixed(1) : '?');
  if (!limit && !total) return null;
  return { limit, total: gib(total), avail: gib(avail) };
}

// 拼一段人话诊断，直接塞进面向用户的错误里
function diagnose(base) {
  const lines = [`边车状态：${state.phase}`];
  if (state.phase === 'skipped' && state.skipped === 'MASK_NO_SIDECAR=1') {
    lines.push('环境变量 MASK_NO_SIDECAR=1 让自动拉起被跳过——去掉它再重启服务');
  }
  if (state.phase === 'skipped' && state.skipped === 'remote') {
    lines.push(`配置里的边车地址 ${base} 不是本机回环地址，本服务不会替你去拉起它`);
  }
  if (state.pid) lines.push(`进程 pid=${state.pid}（已启动 ${Math.round((Date.now() - state.startedAt) / 1000)}s）`);
  if (state.lastExit) {
    lines.push(`上次退出：code=${state.lastExit.code}${state.lastExit.signal ? ` signal=${state.lastExit.signal}` : ''}（${state.lastExit.at}）`);
    if (state.lastExit.signal === 'SIGKILL' || state.lastExit.code === 137) {
      lines.push('提示：进程是被强杀的（SIGKILL），最常见是容器内存不够——GLiNER 约 1.1GB、OPF 约 2.8GB 权重，'
        + '同时启用多个模型引擎要 4GB 以上；调大 compose 内存上限，或先只启用规则类引擎');
    }
  }
  if (state.error) lines.push(`原因：${state.error}`);
  const mem = memInfo();
  if (mem) {
    lines.push(`内存：容器上限 ${mem.limit ? mem.limit.toFixed(1) + ' GiB' : '未限制'}，`
      + `当前可用 ${mem.avail} GiB / 总 ${mem.total} GiB`);
    if (mem.limit && mem.limit < 3.5) {
      lines.push('提示：上限低于 3.5 GiB 时，GLiNER（约 1.1GB 权重）或 OPF（约 2.8GB）加载时容易被 OOM 强杀——'
        + '调大 compose 的 mem_limit，或暂时只用规则类引擎（godlp / sensitive-word / presidio / argus）');
    }
  }
  lines.push(`日志：${LOG_FILE}`);
  const tail = tailLines(12);
  if (tail) lines.push('日志最后几行：', tail);
  return '\n' + lines.join('\n');
}

function status() {
  return { ...state, mem: memInfo(), log: LOG_FILE, tail: tailLines(30) };
}

// 自检用：结束自己拉起的那一个（不动用户手动起的边车）
function stop() {
  if (!child) return false;
  try { child.kill(); } catch { /* 已经退出就算了 */ }
  child = null;
  state.pid = null;
  state.phase = 'idle';
  state.error = null;
  return true;
}

module.exports = { ensureSidecar, sidecarTarget, recover, diagnose, status, stop, healthy, LOG_FILE };
