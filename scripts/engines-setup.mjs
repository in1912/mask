#!/usr/bin/env node
// 面具 mask — 外部脱敏引擎装配（首次启动安装，之后只做存在性检查）
//
// 设计约束：
//  * 所有依赖落在项目内（python/vendor、vendor/），不污染系统 Python / PATH；
//  * 幂等：每次启动只做快速检查，缺什么装什么；装好后离线也能启动；
//  * 失败不拦主服务：外部引擎不可用时，面具的内置规则引擎照常工作，探测页会如实报错。
//
// 用法：node scripts/engines-setup.mjs [--force]
//   --force  重新安装/重建全部组件（模型不重下，除非文件缺失）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const P = (...x) => path.join(ROOT, ...x);
const FORCE = process.argv.includes('--force');
const IS_WIN = process.platform === 'win32';
const PY = process.env.MASK_PYTHON || (IS_WIN ? 'python' : 'python3');

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

async function download(url, dest) {
  log(`下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`下载失败 HTTP ${res.status}：${url}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function unzip(zip, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (IS_WIN) {
    run('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]);
  } else {
    run('unzip', ['-o', zip, '-d', dest]);
  }
}

function moveInnerDir(tmp, finalName) {
  const items = readdirSync(tmp).filter((n) => statSync(path.join(tmp, n)).isDirectory());
  if (items.length !== 1) die(`${tmp} 里不是单一目录：${items.join(',')}`);
  rmSync(P(finalName), { recursive: true, force: true });
  renameSync(path.join(tmp, items[0]), P(finalName));
  rmSync(tmp, { recursive: true, force: true });
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

function ensurePython() {
  const st = pythonReady();
  if (st.ok && !FORCE) { log('Python 引擎依赖：已就绪'); return; }
  if (!st.ok) log(`Python 引擎依赖：缺 ${st.missing || st.why}`);
  run(PY, ['-m', 'pip', 'install', '--target', P('python', 'vendor'), '--upgrade',
    '--disable-pip-version-check', '--no-warn-script-location',
    'presidio-analyzer', 'presidio-anonymizer', 'spacy', 'gliner', 'argus-redact', 'scrubadub',
    'sentencepiece', 'protobuf']);
  run(PY, ['-m', 'pip', 'install', '--target', P('python', 'vendor'), '--upgrade', '--no-deps',
    '--disable-pip-version-check', P('vendor', 'engines-src', 'privacy-filter')]);
  run(PY, ['-m', 'pip', 'install', '--target', P('python', 'vendor'), '--upgrade',
    '--disable-pip-version-check', 'tiktoken']);
}

// ---------- 2. 模型 ----------
function ensureModels() {
  const gliner = P('python', 'models', 'gliner_multi_pii-v1', 'pytorch_model.bin');
  const opf = P('python', 'models', 'opf', 'config.json');
  if (existsSync(gliner) && existsSync(opf)) { log('模型：GLiNER + OpenAI Privacy Filter 已就绪'); return; }
  run(PY, [P('python', 'fetch_models.py')], { env: { ...process.env, MASK_MODELS_DIR: P('python', 'models') } });
}

// ---------- 3. JDK ----------
function ensureJdk() {
  if (existsSync(P('vendor', 'jdk', 'bin', 'java.exe')) && !FORCE) { log('JDK：已就绪'); return; }
  const zip = P('vendor', 'dl', 'jdk21.zip');
  if (!existsSync(zip)) {
    downloadWithFallback([
      'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
      'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse',
    ], zip);
  }
  unzip(zip, P('vendor', 'tmp-jdk'));
  moveInnerDir(P('vendor', 'tmp-jdk'), 'jdk');
  log('JDK：已解压到 vendor/jdk');
}

// ---------- 4. Go ----------
function ensureGo() {
  if (existsSync(P('vendor', 'go', 'bin', 'go.exe')) && !FORCE) { log('Go：已就绪'); return; }
  const zip = P('vendor', 'dl', 'go.zip');
  if (!existsSync(zip)) {
    downloadWithFallback([
      'https://golang.google.cn/dl/go1.23.4.windows-amd64.zip',
      'https://mirrors.aliyun.com/golang/go1.23.4.windows-amd64.zip',
    ], zip);
  }
  unzip(zip, P('vendor', 'tmp-go'));
  moveInnerDir(P('vendor', 'tmp-go'), 'go');
  log('Go：已解压到 vendor/go');
}

// ---------- 5. Maven ----------
function ensureMaven() {
  if (existsSync(P('vendor', 'maven', 'bin', 'mvn.cmd')) && !FORCE) { log('Maven：已就绪'); return; }
  const zip = P('vendor', 'dl', 'maven.zip');
  if (!existsSync(zip)) {
    downloadWithFallback([
      'https://repo1.maven.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip',
      'https://mirrors.aliyun.com/apache/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip',
    ], zip);
  }
  unzip(zip, P('vendor', 'tmp-maven'));
  moveInnerDir(P('vendor', 'tmp-maven'), 'maven');
  log('Maven：已解压到 vendor/maven');
}

// ---------- 6. sensitive-word CLI ----------
function ensureSensitiveWord() {
  const jar = P('vendor', 'sensitive-word', 'sensitive-word-cli.jar');
  if (existsSync(jar) && !FORCE) { log('sensitive-word：已就绪'); return; }
  mkdirSync(path.dirname(jar), { recursive: true });
  run(P('vendor', 'maven', 'bin', 'mvn.cmd'), ['-B', '-q',
    `-Dmaven.repo.local=${P('vendor', 'maven-repo')}`, 'package'],
  { cwd: P('vendor', 'sensitive-word-workspace'), shell: true,
    env: { ...process.env, JAVA_HOME: P('vendor', 'jdk') } });
  if (!existsSync(jar)) die('sensitive-word 构建完成但没找到 jar');
  log('sensitive-word：jar 已生成');
}

// ---------- 7. godlp CLI ----------
function ensureGodlp() {
  const exe = P('vendor', 'godlp', 'godlp-cli.exe');
  if (existsSync(exe) && !FORCE) { log('godlp：已就绪'); return; }
  const env = { ...process.env, GOPROXY: 'https://goproxy.cn,direct', GOSUMDB: 'off', GO111MODULE: 'on' };
  run(P('vendor', 'go', 'bin', 'go.exe'), ['mod', 'tidy'], { cwd: P('vendor', 'godlp-cli'), env });
  run(P('vendor', 'go', 'bin', 'go.exe'), ['build', '-o', exe, '.'], { cwd: P('vendor', 'godlp-cli'), env });
  log('godlp：exe 已生成');
}

async function main() {
  if (!IS_WIN) log('注意：JDK/Go/Maven 的自动下载按 Windows x64 编写，其他平台请手动准备');
  mkdirSync(P('vendor', 'dl'), { recursive: true });
  mkdirSync(P('python', 'vendor'), { recursive: true });
  mkdirSync(P('python', 'models'), { recursive: true });

  ensurePython();
  ensureModels();
  if (IS_WIN) {
    ensureJdk();
    ensureGo();
    ensureMaven();
    ensureSensitiveWord();
    ensureGodlp();
  }

  writeFileSync(P('vendor', '.engines-ready.json'), JSON.stringify({
    ready_at: new Date().toISOString(), platform: process.platform,
    python: P('python', 'vendor'), models: P('python', 'models'),
  }, null, 2));
  log('全部就绪。');
}

main().catch((e) => {
  console.error(`\n[engines-setup] 失败：${e.message}`);
  console.error('[engines-setup] 面具主服务仍可启动，外部引擎会如实报「未安装/不可用」。');
  process.exit(1);
});
