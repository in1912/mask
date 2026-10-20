'use strict';
// 外部脱敏引擎装配器（v0.4.2）：首次启动安装，之后只做存在性检查。
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
const path = require('path');

const {
  existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} = fs;

const ROOT = path.resolve(__dirname, '..', '..');
const P = (...x) => path.join(ROOT, ...x);
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const ARCH = process.arch; // x64 / arm64
const PY = process.env.MASK_PYTHON || (IS_WIN ? 'python' : 'python3');
const EXE = IS_WIN ? '.exe' : '';
// Linux/Windows：命令行引擎可自动构建；macOS 只装 Python（见文件头）
const CLI_SUPPORTED = IS_WIN || IS_LINUX;

let ONLY = 'all';
let FORCE = false;

const log = (m) => console.log(`[engines-setup] ${m}`);
const die = (m) => { throw new Error(m); };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) die(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

function runOut(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 同步下载（用系统 Python 的 urllib，Node 侧无需额外依赖），按顺序试镜像
function downloadWithFallback(urls, dest) {
  rmSync(dest, { force: true });
  for (const u of urls) {
    try {
      log(`下载 ${u}`);
      run(PY, ['-c', 'import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])', u, dest]);
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
function extractArchive(archive, dest) {
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

function moveInnerDir(tmp, finalName) {
  const items = readdirSync(tmp).filter((n) => statSync(path.join(tmp, n)).isDirectory());
  if (items.length !== 1) die(`${tmp} 里不是单一目录：${items.join(',')}`);
  rmSync(P(finalName), { recursive: true, force: true });
  renameSync(path.join(tmp, items[0]), P(finalName));
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

// Linux arm64 的 Adoptium/华为镜像分别换架构段
function urlsForJdk(urls) {
  if (IS_WIN || ARCH !== 'arm64') return urls;
  return urls.map((u) => u.replace('/x64/', '/aarch64/').replace('linux-x64', 'linux-aarch64'));
}

function ensureJdk() {
  if (existsSync(P('vendor', 'jdk', 'bin', `java${EXE}`)) && !FORCE) {
    log('JDK：已就绪'); BUILD_JAVA_HOME = P('vendor', 'jdk'); return;
  }
  const sys = findSystemJdk();
  if (sys && !FORCE) {
    mkdirSync(P('vendor', 'jdk', 'bin'), { recursive: true });
    const link = P('vendor', 'jdk', 'bin', 'java');
    rmSync(link, { force: true });
    symlinkSync(sys.java, link);
    BUILD_JAVA_HOME = sys.home;
    log(`JDK：使用系统安装（${sys.home}），已链接到 vendor/jdk/bin/java`);
    return;
  }
  const zip = P('vendor', 'dl', IS_WIN ? 'jdk21.zip' : 'jdk21.tar.gz');
  if (!existsSync(zip)) {
    const urls = IS_WIN
      ? ['https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
        'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse']
      : ['https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse',
        'https://mirrors.huaweicloud.com/openjdk/21.0.2/openjdk-21.0.2_linux-x64_bin.tar.gz'];
    downloadWithFallback(urlsForJdk(urls), zip);
  }
  extractArchive(zip, P('vendor', 'tmp-jdk'));
  moveInnerDir(P('vendor', 'tmp-jdk'), 'jdk');
  BUILD_JAVA_HOME = P('vendor', 'jdk');
  log('JDK：已解压到 vendor/jdk');
}

// ---------- 4. Go ----------
function ensureGo() {
  if (existsSync(P('vendor', 'go', 'bin', `go${EXE}`)) && !FORCE) { log('Go：已就绪'); return; }
  const zip = P('vendor', 'dl', IS_WIN ? 'go.zip' : 'go.tar.gz');
  if (!existsSync(zip)) {
    const goArch = ARCH === 'arm64' ? 'arm64' : 'amd64';
    const urls = IS_WIN
      ? ['https://golang.google.cn/dl/go1.23.4.windows-amd64.zip',
        'https://mirrors.aliyun.com/golang/go1.23.4.windows-amd64.zip']
      : [`https://golang.google.cn/dl/go1.23.4.linux-${goArch}.tar.gz`,
        `https://mirrors.aliyun.com/golang/go1.23.4.linux-${goArch}.tar.gz`];
    downloadWithFallback(urls, zip);
  }
  extractArchive(zip, P('vendor', 'tmp-go'));
  moveInnerDir(P('vendor', 'tmp-go'), 'go');
  log('Go：已解压到 vendor/go');
}

// ---------- 5. Maven ----------
function ensureMaven() {
  if (existsSync(P('vendor', 'maven', 'bin', IS_WIN ? 'mvn.cmd' : 'mvn')) && !FORCE) { log('Maven：已就绪'); return; }
  const zip = P('vendor', 'dl', IS_WIN ? 'maven.zip' : 'maven.tar.gz');
  if (!existsSync(zip)) {
    const ext = IS_WIN ? 'zip' : 'tar.gz';
    // 阿里云 apache 镜像 2026-10 已不再提供 3.9.9（实测 404）；华为云与 Maven Central 都还全
    const urls = [`https://mirrors.huaweicloud.com/apache/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.${ext}`,
      `https://repo1.maven.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.${ext}`];
    downloadWithFallback(urls, zip);
  }
  extractArchive(zip, P('vendor', 'tmp-maven'));
  moveInnerDir(P('vendor', 'tmp-maven'), 'maven');
  log('Maven：已解压到 vendor/maven');
}

// ---------- 6. sensitive-word CLI ----------
function ensureSensitiveWord() {
  const jar = P('vendor', 'sensitive-word', 'sensitive-word-cli.jar');
  if (existsSync(jar) && !FORCE) { log('sensitive-word：已就绪'); return; }
  mkdirSync(path.dirname(jar), { recursive: true });
  run(P('vendor', 'maven', 'bin', IS_WIN ? 'mvn.cmd' : 'mvn'), ['-B', '-q',
    `-Dmaven.repo.local=${P('vendor', 'maven-repo')}`, 'package'],
  { cwd: P('vendor', 'sensitive-word-workspace'), shell: IS_WIN,
    env: { ...process.env, JAVA_HOME: BUILD_JAVA_HOME } });
  if (!existsSync(jar)) die('sensitive-word 构建完成但没找到 jar');
  log('sensitive-word：jar 已生成');
}

// ---------- 7. godlp CLI ----------
function ensureGodlp() {
  const exe = P('vendor', 'godlp', `godlp-cli${EXE}`);
  if (existsSync(exe) && !FORCE) { log('godlp：已就绪'); return; }
  // 容器里没有 gcc：必须静态编译（CGO_ENABLED=0），否则 build 会卡在 gcc 缺失
  const env = { ...process.env, GOPROXY: 'https://goproxy.cn,direct', GOSUMDB: 'off', GO111MODULE: 'on', CGO_ENABLED: '0' };
  const go = P('vendor', 'go', 'bin', `go${EXE}`);
  run(go, ['mod', 'tidy'], { cwd: P('vendor', 'godlp-cli'), env });
  run(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', exe, '.'], { cwd: P('vendor', 'godlp-cli'), env });
  log('godlp：可执行文件已生成');
}

function main() {
  log(`平台 ${process.platform}/${ARCH}，安装范围 ${ONLY}`);
  if (!CLI_SUPPORTED) {
    log('注意：macOS 目前只自动装配 Python 引擎；godlp/sensitive-word 请手动装 JDK+Go+Maven 后在设置页改命令。');
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
      ensureJdk();
      ensureGo();
      ensureMaven();
      ensureSensitiveWord();
      ensureGodlp();
    }
  }

  writeFileSync(P('vendor', '.engines-ready.json'), JSON.stringify({
    ready_at: new Date().toISOString(), platform: process.platform, arch: ARCH, scope: ONLY,
    python: P('python', 'vendor'), models: P('python', 'models'),
  }, null, 2));
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

module.exports = { runCli, main };
