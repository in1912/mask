// 升级/换证书后的自我接替（承游巷 v1.11.0 方案）—— Windows 上裸 `node server/index.js` 直跑、
// 没有守护进程时的兜底重启。
//
// 为什么是这个模型：Windows 没有 SO_REUSEPORT，两个进程不能同时 bind 同一个端口，
// 所以做不到「先起新的、再退老的」无缝交接。只能：父进程 spawn 一个 detached 的自己 → 父进程退出 →
// 子进程在 listen 上重试，等端口被释放后接管（见 index.js 的 boot()）。
//
// ⚠️ 三个 stdio 必须**全部**重定向到文件。这是 detached 能活下来的前提：
//    只要有一个（尤其是 stdin）还挂在父进程的控制台上，父的控制台一关，子进程就被一起带走。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('../db');

const ROOT = path.join(__dirname, '..', '..');
const CHILD_FLAG = 'MASK_RESTART_CHILD';     // 子进程靠它知道自己是在接班
const EXIT_DELAY_MS = 900;                   // 给 socket 把响应冲出去的时间（res 已 finish 后才会调本函数）
const NO_RESTART = process.env.MASK_NO_RESTART === '1'; // 自检/调试：只落盘不重启

let scheduled = false;

const LOG_FILE = () => path.join(ROOT, 'Logs', 'restart-child.log');
function statePath() {
  const dir = path.join(DATA_DIR, 'upgrades');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'state.json');
}

function isSuppressed() { return NO_RESTART; }
function isChild() { return process.env[CHILD_FLAG] === '1'; }

// 上次升级/换证书有没有成功接班：发起重启前写 restart_pending=true，新进程 listen 成功后置 false。
// 所以「没接班」是**可查的**，而不是静默失联 —— 启动时会打印出来，并带上备份目录。
function readPending() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return null; }
}
function writeState(patch) {
  try {
    const cur = readPending() || {};
    fs.writeFileSync(statePath(), JSON.stringify({ ...cur, ...patch }, null, 2));
  } catch (e) {
    console.warn('[restart] 写 state.json 失败（不影响升级）:', e.message);
  }
}
function clearPending(extra = {}) {
  if (!fs.existsSync(statePath())) return;
  writeState({ restart_pending: false, handoff_at: new Date().toISOString(), ...extra });
}
function writeFatal(err) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE()), { recursive: true });
    const pend = readPending();
    fs.appendFileSync(LOG_FILE(),
      `[${new Date().toISOString()}] ❌ 接管启动失败：${err && err.code ? err.code + ' ' : ''}${err && err.message}\n`
      + `    手工恢复：把 ${(pend && pend.backup_dir) || 'data/upgrades/backup_*'} 里的文件拷回仓库，然后重新运行 启动.cmd\n`);
  } catch { /* 日志都写不了，只能靠退出码 */ }
}

// 发起接替。**只在 res 的 'finish' 之后调**：先让响应落地，再让进程退出。
// reason 用于区分「升级」与「HTTPS 证书」两条发起路径（日志与启动告警都会说出来）。
function scheduleRestart({ fromVersion = '', toVersion = '', backupDir = '', reason = '' } = {}) {
  if (NO_RESTART) {
    return { restart: 'suppressed', note: 'MASK_NO_RESTART=1：文件已落盘，但进程没有重启（自检/调试模式）；手动重启后新代码才生效' };
  }
  if (scheduled) return { restart: 'scheduled', note: '已经发起过一次重启，本次不重复' };
  scheduled = true;

  writeState({ restart_pending: true, from_version: fromVersion, to_version: toVersion, backup_dir: backupDir, reason, at: new Date().toISOString() });

  const logPath = LOG_FILE();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} pid ${process.pid} 发起重启交接（${reason || `v${fromVersion} → v${toVersion}`}）=====\n`);

  let child;
  try {
    child = spawn(process.execPath, process.argv.slice(1), {
      cwd: ROOT,                                        // 不能信 process.cwd()：换个方式拉起时可能不同
      env: { ...process.env, [CHILD_FLAG]: '1' },       // 继承 PORT / MASK_DATA_DIR 等环境
      detached: true,                                   // 新进程组：父退出不带走它
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    fs.closeSync(fd);
    writeFatal(e);
    return { restart: 'failed', note: '拉起接替进程失败：' + e.message + '（文件已落盘，请手动重启）' };
  }
  child.unref();
  const pid = child.pid;
  fs.closeSync(fd);                                     // 关掉父这一份，子进程的 fd 不受影响
  console.log(`[restart] 已拉起接替进程 pid ${pid}，${EXIT_DELAY_MS}ms 后本进程退出（日志 Logs/restart-child.log）`);
  setTimeout(() => process.exit(0), EXIT_DELAY_MS);
  return { restart: 'scheduled', child_pid: pid, note: `已拉起接替进程（pid ${pid}），1~3 秒后新版本上线` };
}

module.exports = { scheduleRestart, isSuppressed, isChild, readPending, clearPending, writeFatal, CHILD_FLAG, LOG_FILE };
