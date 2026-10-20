'use strict';
// stdio 适配器：外部 CLI 引擎（godlp / sensitive-word 包装）。
// 约定：文本全文走 stdin；stdout 出 JSON（{"entities":[…]} 或裸数组）；诊断日志走 stderr。
// 输出宽容解析——只认 term 必填的实体，坐标对不上由上层 locateEntities 按 term 重定位。
// 命令经 shell 执行（Windows 下 'java -jar x.jar' 这类带参数命令必须走 shell），
// 命令值来自管理员在设置页填写的配置，等价于本机手动执行——本模块不做任何联网。
//
// 两个用户体验约束（2026-10-20 用户报障）：
// ① 命令不存在时不能把 cmd.exe 的 GBK 原始错误（“'godlp' 不是内部或外部命令…”乱码）甩给用户——
//    先按 PATH/PATHEXT 自己找一遍，找不到就给中文人话 + 安装提示；
// ② Windows 下子进程输出可能是 GBK：先 chcp 65001 让程序按 UTF-8 输出，仍有乱码再按 GBK 兜底解码。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_STDOUT = 10 * 1024 * 1024; // 10MB 上限，防引擎失控刷爆内存

// cmd.exe 内建/包装命令，不走 PATH 查找
const SHELL_BUILTINS = new Set(['set', 'cd', 'chdir', 'echo', 'call', 'if', 'for', 'start', 'type',
  'copy', 'del', 'erase', 'mkdir', 'md', 'rmdir', 'rd', 'pushd', 'popd', 'ver', 'vol', 'cls',
  'title', 'color', 'time', 'date', 'dir', 'move', 'ren', 'rename', 'shift', 'exit']);

const MISSING_HINTS = {
  java: 'godlp / sensitive-word 都是 Java 程序，需要先装 JDK/JRE 8+，并保证命令行里 `java -version` 能跑。',
  godlp: 'godlp 需要自行编译或安装 CLI（也可在「固定关键词」里处理罕见人名，不依赖它）。',
  python: '这是 Python 命令：先装 Python 3.8+，并把 python 加进 PATH。',
  python3: '这是 Python 命令：先装 Python 3.8+，并把 python3 加进 PATH。',
  node: '这是 Node.js 命令：先装 Node 18+，并把 node 加进 PATH。',
};

function firstToken(command) {
  const s = String(command || '').trim();
  if (!s) return '';
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  return s.split(/\s+/)[0];
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// 按 PATH + PATHEXT 判断命令是否存在；带路径分隔符的直接查文件
function findExecutable(exe) {
  if (!exe) return false;
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(exe);
  const withExts = (p) => {
    if (isFile(p)) return true;
    if (!isWin || hasExt) return false;
    return exts.some((x) => isFile(p + x.toLowerCase()));
  };
  if (/[\\/]/.test(exe)) return withExts(exe);
  const dirs = String(process.env.PATH || '').split(isWin ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return dirs.some((d) => withExts(path.join(d, exe)));
}

function missingCommandError(exe) {
  let hint = MISSING_HINTS[exe.toLowerCase()] || '';
  // 项目自带 vendor/ 路径缺失 ≠ 用户没装 Java：说清楚是「这份安装没装配这个引擎」
  const VENDOR = path.resolve(__dirname, '..', '..', 'vendor') + path.sep;
  if (/[\\/]/.test(exe) && path.resolve(exe).startsWith(VENDOR)) {
    hint = process.platform === 'win32'
      ? '这是项目自带的引擎路径，但本安装里还没装配它（Windows 首次启动会自动编译；也可删掉 vendor/.engines-ready.json 后重启重装）。'
      : '这是项目自带的引擎路径，但当前安装里没有它：Docker 请用 v0.4.1 及以上的镜像（镜像内已构建 godlp 与 sensitive-word）；macOS 目前只自动装配 Python 引擎。内置规则引擎与 Python 引擎不受影响。';
  }
  return new Error(
    `找不到可执行程序「${exe}」——这台机器的 PATH 里没有它。${hint ? hint + ' ' : ''}` +
    '装好后重试，或把命令改成可执行文件的完整路径（如 "C:\\Program Files\\Java\\bin\\java.exe" -jar x.jar）。'
  );
}

// GBK 兜底：UTF-8 解出替换符再按 GBK 解一次（官方 Node 带完整 ICU，有 gbk 解码器）
function decodeBuf(buf) {
  const u = buf.toString('utf8');
  if (!u.includes('\uFFFD')) return u;
  try { return new TextDecoder('gbk').decode(buf); } catch { return u; }
}

function parseEntities(stdout) {
  const s = String(stdout || '').trim();
  if (!s) throw new Error('引擎 stdout 为空');
  const i = s.search(/[[{]/);
  if (i < 0) throw new Error('stdout 里找不到 JSON（约定 stdout 只输出实体 JSON，日志走 stderr）');
  let data;
  try { data = JSON.parse(s.slice(i)); } catch { throw new Error('stdout JSON 解析失败'); }
  const arr = Array.isArray(data) ? data : data.entities;
  if (!Array.isArray(arr)) throw new Error('JSON 里没有实体数组（应为 {"entities":[…]} 或裸数组）');
  return arr.filter((it) => it && typeof it.term === 'string' && it.term);
}

function runStdioEngine(command, text, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!command || typeof command !== 'string' || !command.trim()) {
      return reject(new Error('未配置命令'));
    }
    // 先自己找一遍：找不到就直接回人话，绝不让 shell 吐 GBK 乱码
    const exe = firstToken(command);
    const isWin = process.platform === 'win32';
    if (exe && !SHELL_BUILTINS.has(exe.toLowerCase()) && !findExecutable(exe)) {
      return reject(missingCommandError(exe));
    }
    let child;
    try {
      // Windows：先切控制台到 UTF-8，子程序（java/CLI）的输出才是 UTF-8
      const line = isWin ? `chcp 65001>nul & ${command}` : command;
      child = spawn(line, { shell: true, windowsHide: true });
    } catch (e) {
      return reject(new Error(`命令启动失败：${e.message}`));
    }
    let out = Buffer.alloc(0), err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* 已退出 */ }
      reject(new Error(`引擎 ${timeoutMs}ms 超时`));
    }, timeoutMs || 10000);

    child.stdout.on('data', (d) => {
      if (out.length < MAX_STDOUT) out = Buffer.concat([out, d]);
      else { done = true; try { child.kill(); } catch {} reject(new Error('引擎 stdout 超 10MB')); clearTimeout(timer); }
    });
    child.stderr.on('data', (d) => { if (err.length < 8000) err += decodeBuf(d); });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      reject(new Error(`命令无法执行（${e.message}）——检查命令拼写与 PATH`));
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code !== 0) {
        const why = err ? err.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 300) : '';
        return reject(new Error(`引擎退出码 ${code}${why ? '：' + why : ''}`));
      }
      try { resolve({ entities: parseEntities(decodeBuf(out)) }); } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => { /* 引擎提前退出，close 里会给真因 */ });
    child.stdin.write(text);
    child.stdin.end();
  });
}

module.exports = { runStdioEngine, parseEntities, findExecutable, firstToken };
