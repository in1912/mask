'use strict';
// 外部脱敏引擎装配器（v0.4.8）：首次启动安装，之后只做存在性检查 + 真跑一次验证。
//
// 为什么放在 server/ 下而不是 scripts/：在线升级白名单只允许 server/**.js、web/dist、package.json，
// 装在 scripts/ 的安装器进不了升级包——生产上点了按钮也只会跑旧脚本。放在 server/ 里升级就能带过去。
// scripts/engines-setup.mjs 保留为薄包装（npm run setup:engines 与旧文档继续可用）。
//
// 设计约束：
//  * 所有依赖落在项目内（python/vendor、python/models、vendor/），不污染系统 Python / PATH；
//  * 幂等：每次启动只做快速检查，缺什么装什么；装好后离线也能启动；
//  * 失败不拦主服务：外部引擎不可用时，面具的内置规则引擎照常工作，探测页会如实报错。
//
// 用法：node server/services/enginesInstaller.js [--only=all|cli|python] [--force]
//   --only=all     安装全部（默认；与旧行为一致，首次启动走它）
//   --only=cli     只装命令行引擎（JDK + Go + Maven + godlp + sensitive-word，约 500MB~1GB）
//   --only=python  只装 Python 引擎（pip 依赖 + 模型，数 GB）
//   --force        重新安装/重建全部组件（模型不重下，除非文件缺失）
//
// 平台：Windows x64 与 Linux x64/arm64 会自动下载并构建两个命令行引擎；
//       macOS 目前只装 Python 引擎（JDK/Go/Maven 的 mac 路径未实机验证，不冒充支持）。
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} = fs;

const { extractZip } = require('./zipService');
const EMBEDDED_SRC = require('./engineSources');
const { MARKER: ENGINES_HOME_MARKER } = require('../engines/paths');

const ROOT = path.resolve(__dirname, '..', '..');
const P = (...x) => path.join(ROOT, ...x);
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const ARCH = process.arch; // x64 / arm64
const PY = process.env.MASK_PYTHON || (IS_WIN ? 'python' : 'python3');
const EXE = IS_WIN ? '.exe' : '';
// Linux/Windows：命令行引擎可自动构建；macOS 只装 Python（见文件头）
const CLI_SUPPORTED = IS_WIN || IS_LINUX;

const VENDOR = P('vendor');
// 数据目录（Docker 里是挂出来的卷）：vendor 不能执行时，可执行引擎优先放这里，容器重建不丢。
const DATA_DIR = path.resolve(process.env.MASK_DATA_DIR || P('data'));
// 自检用：把降级目标钉死到临时目录，避免动项目里的真目录
const TEST_FALLBACK = process.env.MASK_TEST_ENGINES_FALLBACK
  ? path.resolve(process.env.MASK_TEST_ENGINES_FALLBACK)
  : null;
let ENGINES_HOME = VENDOR;          // main() 里探测后决定
let VENDOR_TARGETS = {};            // jdk / go / maven，跟着 ENGINES_HOME

let ONLY = 'all';
let FORCE = false;

const log = (m) => console.log(`[engines-setup] ${m}`);
const die = (m) => { throw new Error(m); };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) {
    const extra = r.error.code === 'EACCES'
      ? '（文件在、但不能执行：挂载点带 noexec 或丢失执行位。设 MASK_ENGINES_HOME 指向普通磁盘目录可绕开）'
      : '';
    die(`${cmd} 启动失败${extra}：${r.error.message}`);
  }
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

function runOut(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 同步下载（用系统 Python 的 urllib，Node 侧无需额外依赖），按顺序试镜像。
// 一定要带 User-Agent：Adoptium API 对无 UA 的请求会直接 403（生产 v0.4.2 实测）。
const DL_PY = 'import sys,urllib.request,shutil;'
  + 'req=urllib.request.Request(sys.argv[1],headers={"User-Agent":"Mozilla/5.0 (compatible; mask-engines-setup/1.0)"});'
  + 'r=urllib.request.urlopen(req,timeout=120);f=open(sys.argv[2],"wb");shutil.copyfileobj(r,f);f.close();r.close()';

function downloadWithFallback(urls, dest) {
  rmSync(dest, { force: true });
  for (const u of urls) {
    try {
      log(`下载 ${u}`);
      run(PY, ['-c', DL_PY, u, dest]);
      if (existsSync(dest) && statSync(dest).size > 1024) return;
      die('下载结果为空');
    } catch (e) {
      console.warn(`[engines-setup] 这个地址不行（${u}）：${e.message}`);
      rmSync(dest, { force: true });
    }
  }
  die(`全部下载地址都失败：\n  ${urls.join('\n  ')}`);
}

// 解压：.zip 用 unzip/Expand-Archive，.tar.gz/.tgz 用 tar
// 共享卷上的文件可能是 0000：读都读不了，解压/构建都会以「权限不够」的形式失败
function ensureReadable(p) {
  if (IS_WIN) return;
  try {
    const st = fs.lstatSync(p);
    if (st.isFile() && (st.mode & 0o444) !== 0o444) fs.chmodSync(p, (st.mode & 0o7777) | 0o644);
  } catch { /* 不存在或改不动，交给后面的报错 */ }
}

function extractArchive(archive, dest) {
  ensureReadable(archive);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (/\.zip$/i.test(archive)) {
    if (IS_WIN) {
      run('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
    } else {
      run('unzip', ['-o', archive, '-d', dest]);
    }
  } else {
    run('tar', ['-xzf', archive, '-C', dest]);
  }
}

// 目标目录可能是 Docker 挂载点（./vendor/jdk:/app/vendor/jdk），挂载点本身删不掉（EBUSY），
// 那就清空里面的内容——效果一样，且不会把宿主机卷弄坏。
function emptyDirOrRemove(dest) {
  if (!existsSync(dest)) return;
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch (e) {
    log(`目标 ${dest} 删不掉（多半是挂载点，${e.code || e.message}），改为清空内容`);
    for (const n of readdirSync(dest)) rmSync(path.join(dest, n), { recursive: true, force: true });
  }
}

// rename 只在同一文件系统内有效：/app/vendor 常被挂成宿主机卷，而解压临时目录可能在镜像层，
// 跨设备 rename 直接 EXDEV（生产 v0.4.2 实测）。这里退回整目录复制，复制完再删源。
// MASK_TEST_FORCE_EXDEV=1 让自检能稳定走到复制分支（真实跨设备环境不好造）。
function moveTree(src, dest) {
  if (process.env.MASK_TEST_FORCE_EXDEV === '1') {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  try {
    renameSync(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    log(`跨设备 rename 不行（${src} → ${dest}），改用复制`);
    fs.cpSync(src, dest, { recursive: true });
  }
}

// destAbs 必须是完整绝对路径（<home>/jdk、<home>/go、<home>/maven）——
// v0.3.2~v0.4.2 曾把只给名字的目标拼到项目根（解到 /app/jdk），生产第一次真装才炸。
function vendorTargets(home) {
  return {
    jdk: path.join(home, 'jdk'),
    go: path.join(home, 'go'),
    maven: path.join(home, 'maven'),
  };
}

// ---------- 0. 运行时目录探测（v0.4.5） ----------
// 生产实测：宿主机把目录挂到 /app/vendor，挂载点带 noexec，mvn 直接 EACCES——
// 文件在、可读、可写，就是不能执行。vendor 里的 java/go/godlp 也全都会栽在这里。
// 探测方式：在目标目录写一个最小 shell 脚本（0755）并真跑一次；写不了或跑不起来都算不能用。
// Windows 没有执行位/noexec 这回事，直接认为可用。
const NOEXEC_TEST = (process.env.MASK_TEST_NOEXEC_DIRS || '')
  .split(',').map((s) => s.trim()).filter(Boolean).map((d) => path.resolve(d));
function canExecIn(dir) {
  // 自检用：把指定目录当成 noexec（本机造不出 noexec 挂载，Windows 更是没有执行位概念）
  if (NOEXEC_TEST.some((d) => path.resolve(dir) === d)) return false;
  if (IS_WIN) return true;
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.exec-probe-${process.pid}.sh`);
    writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = spawnSync(probe, [], { timeout: 5000, stdio: 'ignore' });
    rmSync(probe, { force: true });
    return !r.error && r.status === 0;
  } catch (e) {
    log(`执行权限探测出错（${dir}）：${e.message}`);
    return false;
  }
}

// 容器里把引擎装在「镜像层」（根文件系统）时，容器一重建就没了。能查就查一下并如实说出来。
function onImageLayer(dir) {
  if (!IS_LINUX) return false;
  try {
    const points = fs.readFileSync('/proc/self/mounts', 'utf8').split('\n')
      .map((l) => l.split(/\s+/)[1]).filter(Boolean)
      .map((m) => m.replace(/\\040/g, ' '))
      .filter((m) => dir === m || dir.startsWith(m.endsWith('/') ? m : `${m}/`));
    if (!points.length) return false;
    points.sort((a, b) => b.length - a.length);
    return points[0] === '/';        // 最近的挂载点就是根 → 在镜像层
  } catch { return false; }
}

function resolveEnginesHome() {
  // 显式配置最高优先：说放哪就放哪，但必须真能执行——不能执行就地失败，不再硬着头皮装一半
  if (process.env.MASK_ENGINES_HOME) {
    const h = path.resolve(process.env.MASK_ENGINES_HOME);
    log(`引擎运行时目录：${h}（MASK_ENGINES_HOME 指定）`);
    try { mkdirSync(h, { recursive: true }); } catch (e) {
      die(`MASK_ENGINES_HOME=${h} 建不出来（${e.code || e.message}）——`
        + `容器里的数据目录是 ${DATA_DIR}，改用 ${path.join(DATA_DIR, 'engines')}（数据卷，重建不丢），`
        + '或者把 compose 里那个变量删掉，让安装器自己挑');
    }
    if (!canExecIn(h)) {
      die(`MASK_ENGINES_HOME=${h} 里的程序不能执行（noexec 挂载，或文件系统不存执行位）——`
        + `改用 ${path.join(DATA_DIR, 'engines')} 这类普通磁盘目录后重试`);
    }
    warnIfEphemeral(h);
    return h;
  }
  // MASK_TEST_VENDOR_NOEXEC=1 让自检能稳定走到降级分支（本机造不出 noexec 挂载）
  if (process.env.MASK_TEST_VENDOR_NOEXEC !== '1' && canExecIn(VENDOR)) return VENDOR;
  log('vendor/ 里的程序不能执行（常见原因：宿主机卷以 noexec 挂进来，或文件系统不存执行位）');
  log('可执行的部分（JDK/Go/Maven/godlp）改放到下面第一个能用的目录；jar 与源码留在 vendor/ 不影响使用。');
  log('vendor 里旧的同名目录不会再被使用，也不会自动删除（确认没用可手工删）。');
  // 优先数据目录：Docker 里它就是挂出来的卷，容器重建不丢；再退项目内 .engines（镜像层），最后系统临时目录
  const cands = [
    ...(TEST_FALLBACK ? [TEST_FALLBACK] : []),
    path.join(DATA_DIR, 'engines'),
    P('.engines'),
    path.join(os.tmpdir(), 'mask-engines'),
  ];
  for (const cand of cands) {
    try {
      mkdirSync(cand, { recursive: true });
      if (!canExecIn(cand)) { log(`${cand} 里的程序也不能执行，换下一个位置`); continue; }
      log(`引擎运行时目录：${cand}`);
      warnIfEphemeral(cand);
      return cand;
    } catch (e) {
      log(`${cand} 不可用：${e.message}`);
    }
  }
  die('找不到既能写又能执行程序的目录——请设 MASK_ENGINES_HOME 指向普通磁盘目录后重试');
}

function warnIfEphemeral(h) {
  if (onImageLayer(h)) {
    log(`注意：${h} 在容器镜像层（不是挂载卷），容器重建后要重装一次；`
      + '想留住它就把数据目录挂成卷并用 MASK_ENGINES_HOME 指到卷里（如 /app/data/engines）。');
  }
}

function moveInnerDir(tmp, destAbs) {
  const items = readdirSync(tmp).filter((n) => statSync(path.join(tmp, n)).isDirectory());
  if (items.length !== 1) die(`${tmp} 里不是单一目录：${items.join(',')}`);
  emptyDirOrRemove(destAbs);
  moveTree(path.join(tmp, items[0]), destAbs);
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- 1. Python 依赖 ----------
const PY_MODULES = ['presidio_analyzer', 'spacy', 'gliner', 'torch', 'argus_redact', 'scrubadub', 'opf', 'tiktoken', 'sentencepiece'];
function pythonReady() {
  const code = `import importlib.util as u,sys; sys.path.insert(0, r'${P('python', 'vendor')}'); ` +
    `mods=${JSON.stringify(PY_MODULES)}; missing=[m for m in mods if u.find_spec(m) is None]; ` +
    `print(','.join(missing))`;
  const r = runOut(PY, ['-c', code]);
  if (r.status !== 0) return { ok: false, why: r.out.trim().slice(-400) };
  const missing = r.out.trim();
  return { ok: !missing, missing };
}

// Debian/Ubuntu 的 pip 受 PEP 668 管制，装到项目内目录不是「污染系统」，放行；
// 老 pip 不认识这个环境变量会直接忽略。
const PIP_ENV = { ...process.env, PIP_BREAK_SYSTEM_PACKAGES: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };

function pipInstall(args) {
  try {
    run(PY, ['-m', 'pip', 'install', ...args], { env: PIP_ENV });
  } catch (e) {
    log(`默认 PyPI 失败，改用清华镜像重试：${e.message}`);
    run(PY, ['-m', 'pip', 'install', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', ...args], { env: PIP_ENV });
  }
}

function ensurePython() {
  const st = pythonReady();
  if (st.ok && !FORCE) { log('Python 引擎依赖：已就绪'); return; }
  if (!st.ok) log(`Python 引擎依赖：缺 ${st.missing || st.why}`);
  pipInstall(['--target', P('python', 'vendor'), '--upgrade', '--no-warn-script-location',
    'presidio-analyzer', 'presidio-anonymizer', 'spacy', 'gliner', 'argus-redact', 'scrubadub',
    'sentencepiece', 'protobuf']);
  pipInstall(['--target', P('python', 'vendor'), '--upgrade', '--no-deps',
    P('vendor', 'engines-src', 'privacy-filter')]);
  pipInstall(['--target', P('python', 'vendor'), '--upgrade', 'tiktoken']);
}

// ---------- 2. 模型 ----------
function ensureModels() {
  const gliner = P('python', 'models', 'gliner_multi_pii-v1', 'pytorch_model.bin');
  const opf = P('python', 'models', 'opf', 'config.json');
  if (existsSync(gliner) && existsSync(opf)) { log('模型：GLiNER + OpenAI Privacy Filter 已就绪'); return; }
  run(PY, [P('python', 'fetch_models.py')], { env: { ...process.env, MASK_MODELS_DIR: P('python', 'models') } });
}

// ---------- 3. JDK ----------
// 优先用系统已有 JDK（Linux 常见）；没有才下载 Adoptium 21。
// 默认命令指向 vendor/jdk/bin/java，所以系统 JDK 也要在 vendor/jdk 建一个软链。
function findSystemJdk() {
  if (IS_WIN) return null; // Windows 建软链要管理员权限，直接下载
  const javac = runOut('sh', ['-c', 'command -v javac']);
  if (javac.status !== 0 || !javac.out.trim()) return null;
  const javacPath = javac.out.trim().split(/\r?\n/).pop();
  const home = path.resolve(path.dirname(javacPath), '..');
  const java = path.join(home, 'bin', 'java');
  return existsSync(java) ? { home, java } : null;
}

let BUILD_JAVA_HOME = P('vendor', 'jdk'); // Maven 构建用

// 降级到 .engines 时，vendor 里往往已经有一份「解压好了、只是不能执行」的工具链
// （上一次安装其实已经把包下载并解开了）。复制过去比重新下一遍（JDK ~180MB / Go ~70MB）快得多。
function adoptVendorCopy(rel, destAbs) {
  const src = path.join(VENDOR, rel);
  if (!existsSync(src) || !readdirSync(src).length) return false;
  log(`复用 vendor/${rel} 里已解压的那份，复制到 ${destAbs}…`);
  try {
    emptyDirOrRemove(destAbs);
    fs.cpSync(src, destAbs, { recursive: true });
    return true;
  } catch (e) {
    log(`复制失败（${e.code || e.message}），改为重新下载`);
    return false;
  }
}

// v0.4.6：只「复制」不够。生产实测 .engines 的探测脚本能跑（目录确实可执行），
// 但从 vendor 复制过去的 mvn 还是 EACCES——源卷（宿主机的 exfat/vfat/共享盘）本来就不存
// 执行位，解出来的 mvn/java/go 是 0644，cpSync 原样复制，复制到哪都执行不了。
// 这里按工具链布局把 argv[0] 与编译器工具补回 0755，装完再真跑一次版本命令验证。
const EXEC_RULES = {
  jdk: [/^bin\//, /^lib\/jspawnhelper$/],
  go: [/^bin\//, /^pkg\/tool\//], // go build 要调用 pkg/tool/*/compile、link，全是可执行文件
  maven: [/^bin\//],
};

// v0.4.8：只知道「补执行位」还不够。飞牛（fnOS）这类共享卷上的文件 mode 可能是 0000——
// 连读都不行（`chmod a+rwX` 对 0000 文件也只加 rw、不加 x，得 `chmod a+rx`）。所以先把整棵树
// 抬到「至少 目录 0755 / 文件 0644」，再按布局补执行位；只加不减，正常机器上一个字节都不动。
const MIN_FILE = 0o644;
const MIN_DIR = 0o755;

// 纯计算，单独拿出来给自检（Windows 上没法真造出 0000 的文件）
function modeFix(st) {
  const want = st.isDirectory() ? MIN_DIR : MIN_FILE;
  return (st.mode & want) === want ? 0 : ((st.mode & 0o7777) | want);
}

function ensureTreeModes(dir) {
  if (IS_WIN) return 0;
  let n = 0;
  const walk = (rel) => {
    let names;
    try { names = readdirSync(path.join(dir, rel)); } catch { return; }
    for (const name of names) {
      const relp = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, relp);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      const m = modeFix(st);
      if (m) { try { fs.chmodSync(abs, m); n++; } catch { /* 改不动就交给后面的验证报错 */ } }
      if (st.isDirectory()) walk(relp);
    }
  };
  if (existsSync(dir)) walk('');
  return n;
}

function chmodExecTree(dir, kind) {
  if (IS_WIN) return 0;
  const fixed = ensureTreeModes(dir);
  if (fixed) log(`补回读权限/目录权限（${fixed} 个条目，常见于共享卷上 mode=0000 的文件）`);
  const rules = EXEC_RULES[kind] || [];
  let n = 0;
  const walk = (rel) => {
    let names;
    try { names = readdirSync(path.join(dir, rel)); } catch { return; }
    for (const name of names) {
      const relp = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, relp);
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(relp); continue; }
      if (!rules.some((re) => re.test(relp))) continue;
      try { fs.chmodSync(abs, (st.mode & 0o7777) | 0o755); n++; } catch { /* 权限不够就交给后面的验证报错 */ }
    }
  };
  if (existsSync(dir)) walk('');
  return n;
}

// 装没装好不看文件在不在，看它跑不跑
function canRun(cmd, args, opts = {}) {
  try { return runOut(cmd, args, opts).status === 0; } catch { return false; }
}
const verifyJdk = (java) => canRun(java, ['-version']);
const verifyGo = (go) => canRun(go, ['version']);
const verifyMvn = (mvn) => canRun(mvn, ['-v'], {
  shell: IS_WIN, env: { ...process.env, JAVA_HOME: BUILD_JAVA_HOME },
});
// godlp-cli 约定 stdin → stdout JSON，空输入回 {"entities":[]}，正好拿来验证能执行
const verifyGodlp = (exe) => canRun(exe, [], { input: '', timeout: 15000 });

// 解压临时目录放在运行时目录下：和最终目标同一文件系统，能 rename 而不必跨设备复制
const tmpFor = (kind) => path.join(ENGINES_HOME, `.tmp-${kind}`);

// Linux arm64 的 Adoptium/华为镜像分别换架构段
function urlsForJdk(urls) {
  if (IS_WIN || ARCH !== 'arm64') return urls;
  return urls.map((u) => u.replace('/x64/', '/aarch64/').replace('linux-x64', 'linux-aarch64'));
}

function ensureJdk() {
  const javaBin = path.join(VENDOR_TARGETS.jdk, 'bin', `java${EXE}`);
  if (existsSync(javaBin) && !FORCE) {
    const fixed = chmodExecTree(VENDOR_TARGETS.jdk, 'jdk');
    if (fixed) log(`JDK：补回执行位（${fixed} 个文件）`);
    if (verifyJdk(javaBin)) { log('JDK：已就绪'); BUILD_JAVA_HOME = VENDOR_TARGETS.jdk; return; }
    log('JDK：现有副本跑不起来（多半是执行位丢了），重装');
  }
  const sys = findSystemJdk();
  if (sys && !FORCE) {
    mkdirSync(path.join(VENDOR_TARGETS.jdk, 'bin'), { recursive: true });
    const link = path.join(VENDOR_TARGETS.jdk, 'bin', 'java');
    rmSync(link, { force: true });
    symlinkSync(sys.java, link);
    if (verifyJdk(link)) {
      BUILD_JAVA_HOME = sys.home;
      log(`JDK：使用系统安装（${sys.home}），已链接到 ${link}`);
      return;
    }
    log('JDK：系统 JDK 链接后仍不能执行，改为自带一份');
    rmSync(link, { force: true });
  }
  const zip = P('vendor', 'dl', IS_WIN ? 'jdk21.zip' : 'jdk21.tar.gz');
  // 没缓存时先试复制（走得快）；有缓存就直接解压——tar 会恢复归档里的 0755，不受源卷影响
  if (!existsSync(zip) && ENGINES_HOME !== VENDOR && !FORCE && adoptVendorCopy('jdk', VENDOR_TARGETS.jdk)) {
    chmodExecTree(VENDOR_TARGETS.jdk, 'jdk');
    if (verifyJdk(javaBin)) {
      BUILD_JAVA_HOME = VENDOR_TARGETS.jdk;
      log(`JDK：已从 vendor 复制并补齐执行位（${VENDOR_TARGETS.jdk}）`);
      return;
    }
    log('JDK：复制过来的副本仍不能执行，改为用压缩包重装');
  }
  if (!existsSync(zip)) {
    const urls = IS_WIN
      ? ['https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
        'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse']
      : ['https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse',
        'https://mirrors.huaweicloud.com/openjdk/21.0.2/openjdk-21.0.2_linux-x64_bin.tar.gz',
        'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/linux/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz'];
    downloadWithFallback(urlsForJdk(urls), zip);
  }
  extractArchive(zip, tmpFor('jdk'));
  moveInnerDir(tmpFor('jdk'), VENDOR_TARGETS.jdk);
  chmodExecTree(VENDOR_TARGETS.jdk, 'jdk');
  BUILD_JAVA_HOME = VENDOR_TARGETS.jdk;
  if (!verifyJdk(javaBin)) {
    die(`JDK 解压到 ${VENDOR_TARGETS.jdk} 了，但 java -version 仍跑不起来——`
      + `这个目录所在的文件系统可能不允许执行程序，请把 MASK_ENGINES_HOME 指到普通磁盘目录后重试`);
  }
  log(`JDK：已解压到 ${VENDOR_TARGETS.jdk}`);
}

// ---------- 4. Go ----------
function ensureGo() {
  const goBin = path.join(VENDOR_TARGETS.go, 'bin', `go${EXE}`);
  if (existsSync(goBin) && !FORCE) {
    const fixed = chmodExecTree(VENDOR_TARGETS.go, 'go');
    if (fixed) log(`Go：补回执行位（${fixed} 个文件）`);
    if (verifyGo(goBin)) { log('Go：已就绪'); return; }
    log('Go：现有副本跑不起来（多半是执行位丢了），重装');
  }
  const zip = P('vendor', 'dl', IS_WIN ? 'go.zip' : 'go.tar.gz');
  if (!existsSync(zip) && ENGINES_HOME !== VENDOR && !FORCE && adoptVendorCopy('go', VENDOR_TARGETS.go)) {
    chmodExecTree(VENDOR_TARGETS.go, 'go');
    if (verifyGo(goBin)) { log(`Go：已从 vendor 复制并补齐执行位（${VENDOR_TARGETS.go}）`); return; }
    log('Go：复制过来的副本仍不能执行，改为用压缩包重装');
  }
  if (!existsSync(zip)) {
    const goArch = ARCH === 'arm64' ? 'arm64' : 'amd64';
    const urls = IS_WIN
      ? ['https://golang.google.cn/dl/go1.23.4.windows-amd64.zip',
        'https://mirrors.aliyun.com/golang/go1.23.4.windows-amd64.zip']
      : [`https://golang.google.cn/dl/go1.23.4.linux-${goArch}.tar.gz`,
        `https://mirrors.aliyun.com/golang/go1.23.4.linux-${goArch}.tar.gz`];
    downloadWithFallback(urls, zip);
  }
  extractArchive(zip, tmpFor('go'));
  moveInnerDir(tmpFor('go'), VENDOR_TARGETS.go);
  chmodExecTree(VENDOR_TARGETS.go, 'go');
  if (!verifyGo(goBin)) {
    die(`Go 解压到 ${VENDOR_TARGETS.go} 了，但 go version 仍跑不起来——`
      + `这个目录所在的文件系统可能不允许执行程序，请把 MASK_ENGINES_HOME 指到普通磁盘目录后重试`);
  }
  log(`Go：已解压到 ${VENDOR_TARGETS.go}`);
}

// ---------- 5. Maven ----------
function ensureMaven() {
  const mvn = path.join(VENDOR_TARGETS.maven, 'bin', IS_WIN ? 'mvn.cmd' : 'mvn');
  if (existsSync(mvn) && !FORCE) {
    const fixed = chmodExecTree(VENDOR_TARGETS.maven, 'maven');
    if (fixed) log(`Maven：补回执行位（${fixed} 个文件）`);
    if (verifyMvn(mvn)) { log('Maven：已就绪'); return; }
    log('Maven：现有副本跑不起来（多半是执行位丢了），重装');
  }
  const zip = P('vendor', 'dl', IS_WIN ? 'maven.zip' : 'maven.tar.gz');
  if (!existsSync(zip) && ENGINES_HOME !== VENDOR && !FORCE && adoptVendorCopy('maven', VENDOR_TARGETS.maven)) {
    chmodExecTree(VENDOR_TARGETS.maven, 'maven');
    if (verifyMvn(mvn)) { log(`Maven：已从 vendor 复制并补齐执行位（${VENDOR_TARGETS.maven}）`); return; }
    log('Maven：复制过来的副本仍不能执行，改为用压缩包重装');
  }
  if (!existsSync(zip)) {
    const ext = IS_WIN ? 'zip' : 'tar.gz';
    // 阿里云 apache 镜像 2026-10 已不再提供 3.9.9（实测 404）；华为云与 Maven Central 都还全
    const urls = [`https://mirrors.huaweicloud.com/apache/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.${ext}`,
      `https://repo1.maven.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.${ext}`];
    downloadWithFallback(urls, zip);
  }
  extractArchive(zip, tmpFor('maven'));
  moveInnerDir(tmpFor('maven'), VENDOR_TARGETS.maven);
  chmodExecTree(VENDOR_TARGETS.maven, 'maven');
  if (!verifyMvn(mvn)) {
    die(`Maven 解压到 ${VENDOR_TARGETS.maven} 了，但 mvn -v 仍跑不起来——`
      + `这个目录所在的文件系统可能不允许执行程序，请把 MASK_ENGINES_HOME 指到普通磁盘目录后重试`);
  }
  log(`Maven：已解压到 ${VENDOR_TARGETS.maven}`);
}

// ---------- 5.5 构建源码（镜像里没有时用内置副本铺开） ----------
// 旧镜像没带这两个引擎的源码；把整个 vendor/ 挂成宿主机卷也会盖掉镜像里的源码。
// 在线升级白名单带不了 vendor/，所以源码以 base64 zip 内置在 server/services/engineSources.js，
// 这里只在缺失时铺文件（本地开发有源码就一个字节都不动）。
const SOURCE_PROBES = [
  ['godlp-cli', 'go.mod'],
  ['engines-src', 'godlp', 'go.mod'],
  ['sensitive-word-workspace', 'pom.xml'],
];

function sourcesReady(baseDir = P('vendor')) {
  return SOURCE_PROBES.every((rel) => existsSync(path.join(baseDir, ...rel)));
}

function ensureSources(baseDir = P('vendor')) {
  // 源码文件在共享卷上可能 mode=0000：存在但读不了，go build 会报莫名其妙的错
  for (const rel of [['godlp-cli'], ['engines-src', 'godlp'], ['sensitive-word-workspace']]) {
    ensureTreeModes(path.join(baseDir, ...rel));
  }
  if (sourcesReady(baseDir)) { log('构建源码：已就绪'); return; }
  log('镜像里缺构建源码（旧镜像或 vendor/ 被宿主机卷盖住），铺开内置源码副本…');
  const buf = Buffer.from(EMBEDDED_SRC.zip_b64, 'base64');
  const entries = extractZip(buf);
  let wrote = 0;
  for (const e of entries) {
    if (!/^(godlp-cli|engines-src\/godlp|sensitive-word-workspace)\//.test(e.name) || e.name.split('/').includes('..')) {
      die(`内置源码副本里有异常路径：${e.name}`);
    }
    const dst = path.join(baseDir, ...e.name.split('/'));
    if (existsSync(dst)) continue; // 已有的文件不动（可能是用户改过的源码）
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, e.data);
    wrote++;
  }
  log(`构建源码：铺开 ${wrote} 个文件到 ${baseDir}`);
}

// ---------- 6. sensitive-word CLI ----------
// 源码缺失时 ensureSources() 已经铺过；还缺说明 vendor/ 不可写，报错要说清。
const VENDOR_MOUNT_HINT = '——内置源码副本也没能铺开，检查 vendor/ 是否可写（或把整个 vendor/ 挂成了只读卷）。'
  + '实在不行就重建镜像（v0.4.1+ 镜像已内置两个命令行引擎），见 docker-compose.yml。';

function ensureSensitiveWord() {
  const jarHome = path.join(ENGINES_HOME, 'sensitive-word', 'sensitive-word-cli.jar');
  const jarVendor = path.join(VENDOR, 'sensitive-word', 'sensitive-word-cli.jar');
  // jar 是 java 读的，只要有读权限；共享卷上可能是 0000
  ensureTreeModes(path.join(ENGINES_HOME, 'sensitive-word'));
  ensureTreeModes(path.join(VENDOR, 'sensitive-word'));
  // jar 只被 java 读，不需要执行位：vendor 里已有的（镜像构建产物）照样能用
  if ((existsSync(jarHome) || existsSync(jarVendor)) && !FORCE) { log('sensitive-word：已就绪'); return; }
  const srcWs = path.join(VENDOR, 'sensitive-word-workspace');
  if (!existsSync(path.join(srcWs, 'pom.xml'))) {
    die(`找不到 vendor/sensitive-word-workspace/pom.xml${VENDOR_MOUNT_HINT}`);
  }
  // vendor 不能执行时连带把构建目录也放出去：mvn 会在工作区里写 target/，
  // 而 pom 的 shade 输出固定写到工作区上一级的 sensitive-word/。
  let ws = srcWs;
  if (ENGINES_HOME !== VENDOR) {
    ws = path.join(ENGINES_HOME, 'build', 'sensitive-word-workspace');
    rmSync(ws, { recursive: true, force: true });
    fs.cpSync(srcWs, ws, { recursive: true, filter: (s) => path.basename(s) !== 'target' });
    ensureTreeModes(ws); // 从共享卷复制过来，可能带着 0000
    log(`构建目录改到 ${ws}（vendor 里的程序不能执行）`);
  }
  mkdirSync(path.dirname(jarHome), { recursive: true });
  const mvn = path.join(VENDOR_TARGETS.maven, 'bin', IS_WIN ? 'mvn.cmd' : 'mvn');
  const args = ['-B', '-q', `-Dmaven.repo.local=${P('vendor', 'maven-repo')}`, 'package'];
  const opts = { cwd: ws, shell: IS_WIN,
    env: { ...process.env, JAVA_HOME: BUILD_JAVA_HOME } };
  try {
    run(mvn, args, opts);
  } catch (e) {
    // 国内服务器直连 Maven Central 经常慢或断；阿里云镜像做兜底（与 Dockerfile 同源）
    log(`默认 Maven 仓库失败，改用阿里云镜像重试：${e.message}`);
    const settings = P('vendor', 'maven-aliyun-settings.xml');
    writeFileSync(settings, [
      '<settings><mirrors><mirror>',
      '<id>aliyun</id><mirrorOf>central</mirrorOf>',
      '<url>https://maven.aliyun.com/repository/central</url>',
      '</mirror></mirrors></settings>',
    ].join(''));
    run(mvn, [...args, '-s', settings], opts);
  }
  // shade 的输出位置跟着工作区走；统一落到 runtime 目录，engine/paths.js 会先找那里
  const built = path.join(path.dirname(ws), 'sensitive-word', 'sensitive-word-cli.jar');
  if (existsSync(built) && built !== jarHome) { fs.copyFileSync(built, jarHome); }
  if (!existsSync(jarHome)) {
    if (existsSync(jarVendor)) fs.copyFileSync(jarVendor, jarHome);
    else die('sensitive-word 构建完成但没找到 jar');
  }
  log('sensitive-word：jar 已生成');
}

// ---------- 7. godlp CLI ----------
function ensureGodlp() {
  // 二进制必须能执行：定位在 ENGINES_HOME 下（vendor 不能执行时就是 .engines/godlp）
  const exe = path.join(ENGINES_HOME, 'godlp', `godlp-cli${EXE}`);
  if (existsSync(exe) && !FORCE) {
    try { fs.chmodSync(exe, 0o755); } catch { /* Windows 无所谓 */ }
    if (verifyGodlp(exe)) { log('godlp：已就绪'); return; }
    log('godlp：现有二进制跑不起来（多半是执行位丢了），重新编译');
  }
  if (!existsSync(P('vendor', 'godlp-cli', 'go.mod'))) {
    die(`找不到 vendor/godlp-cli/go.mod${VENDOR_MOUNT_HINT}`);
  }
  mkdirSync(path.dirname(exe), { recursive: true });
  // 容器里没有 gcc：必须静态编译（CGO_ENABLED=0），否则 build 会卡在 gcc 缺失
  const env = { ...process.env, GOPROXY: 'https://goproxy.cn,direct', GOSUMDB: 'off', GO111MODULE: 'on', CGO_ENABLED: '0' };
  const go = path.join(VENDOR_TARGETS.go, 'bin', `go${EXE}`);
  run(go, ['mod', 'tidy'], { cwd: P('vendor', 'godlp-cli'), env });
  run(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', exe, '.'], { cwd: P('vendor', 'godlp-cli'), env });
  try { fs.chmodSync(exe, 0o755); } catch { /* Windows 无所谓 */ }
  log(`godlp：可执行文件已生成（${exe}）`);
}

function main() {
  log(`平台 ${process.platform}/${ARCH}，安装范围 ${ONLY}`);
  if (!CLI_SUPPORTED) {
    log('注意：macOS 目前只自动装配 Python 引擎；godlp/sensitive-word 请手动装 JDK+Go+Maven 后在设置页改命令。');
  }

  if (CLI_SUPPORTED) {
    ENGINES_HOME = resolveEnginesHome();
    VENDOR_TARGETS = vendorTargets(ENGINES_HOME);
    // 让 server/engines/paths.js 知道该去哪个目录找可执行文件（没降级就不留标点文件）
    if (ENGINES_HOME === VENDOR) {
      rmSync(ENGINES_HOME_MARKER, { force: true });
      rmSync(P('.engines-home.json'), { force: true });
    } else {
      const body = JSON.stringify({
        home: ENGINES_HOME, reason: 'vendor-not-executable', updated_at: new Date().toISOString(),
      }, null, 2);
      try {
        writeFileSync(ENGINES_HOME_MARKER, body);
      } catch (e) {
        // vendor 只读时标点文件写不进去，放到项目根（paths.js 两个位置都会看）
        log(`标点文件写不进 ${ENGINES_HOME_MARKER}（${e.code || e.message}），改写到项目根`);
        writeFileSync(P('.engines-home.json'), body);
      }
    }
  } else {
    ENGINES_HOME = VENDOR;
    VENDOR_TARGETS = vendorTargets(VENDOR);
  }

  mkdirSync(P('vendor', 'dl'), { recursive: true });
  mkdirSync(P('python', 'vendor'), { recursive: true });
  mkdirSync(P('python', 'models'), { recursive: true });

  if (ONLY !== 'cli') {
    log('── Python 引擎依赖与模型');
    ensurePython();
    ensureModels();
  }
  if (ONLY !== 'python') {
    log('── 命令行引擎（godlp / sensitive-word）');
    if (CLI_SUPPORTED) {
      ensureSources();
      ensureJdk();
      ensureGo();
      ensureMaven();
      ensureSensitiveWord();
      ensureGodlp();
    }
  }

  const ready = {
    ready_at: new Date().toISOString(), platform: process.platform, arch: ARCH, scope: ONLY,
    engines_home: ENGINES_HOME,
    python: P('python', 'vendor'), models: P('python', 'models'),
  };
  writeFileSync(P('vendor', '.engines-ready.json'), JSON.stringify(ready, null, 2));
  // 降级时运行时目录自己也留一份：容器重建后 vendor 卷还在、.engines 没了，一眼能看出来
  if (ENGINES_HOME !== VENDOR) writeFileSync(path.join(ENGINES_HOME, '.engines-ready.json'), JSON.stringify(ready, null, 2));
  log('全部就绪。');
}

// 命令行入口：返回进程退出码（2=参数错，1=安装失败，0=成功）
function runCli(argv = process.argv.slice(2)) {
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  ONLY = onlyArg ? onlyArg.slice('--only='.length) : 'all';
  FORCE = argv.includes('--force');
  if (!['all', 'cli', 'python'].includes(ONLY)) {
    console.error(`[engines-setup] --only 只支持 all / cli / python，收到：${ONLY}`);
    return 2;
  }
  try {
    main();
    return 0;
  } catch (e) {
    console.error(`\n[engines-setup] 失败：${e.message}`);
    console.error('[engines-setup] 面具主服务仍可启动，外部引擎会如实报「未安装/不可用」。');
    return 1;
  }
}

if (require.main === module) process.exit(runCli(process.argv.slice(2)));

// 以下 `_*` 只给自检用（目标目录、EXDEV 复制分支、noexec 降级、内置源码铺开）
module.exports = {
  runCli, main, _moveInnerDir: moveInnerDir,
  _vendorTargetsFor: vendorTargets,
  _enginesHome: () => ENGINES_HOME,
  _resolveEnginesHome: resolveEnginesHome,
  _canExecIn: canExecIn,
  _chmodExecTree: chmodExecTree, _ensureTreeModes: ensureTreeModes, _modeFix: modeFix, _canRun: canRun, _tmpFor: tmpFor,
  _onImageLayer: onImageLayer, _dataDir: () => DATA_DIR,
  _ensureSources: ensureSources, _sourcesReady: sourcesReady,
};
