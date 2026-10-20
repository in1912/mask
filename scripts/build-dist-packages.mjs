// build-dist-packages.mjs —— 生成三端分发压缩包（Windows / macOS / Docker），不含任何个人数据。
// 产物落在仓库根目录：面具-<版本>-windows.zip / -macos.zip / -docker.zip（*.zip 已在 .gitignore，不入库）
// 原则：只带「能跑起来的最小运行集」——data/ 一律空壳（里面有 mask.sqlite/.secret/AI Key/登录日志），
//       Logs/、web/src/、web/dist 的旧构建、python/vendor、python/models、vendor 运行时（JDK/Go/Maven/jar）
//       全部不带；外部引擎由 scripts/engines-setup.mjs 首次启动自动装配。
// 用法：node scripts/build-dist-packages.mjs [--out <目录>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : ROOT;
const STAGE_ROOT = process.env.DIST_STAGE || path.join(os.tmpdir(), 'mask-dist');
const A = (...p) => path.join(...p);

// 最新前端构建产物（web/dist 下按时间戳累积，只带最新的那份；根目录平铺的旧构建不带）
const distParent = A(ROOT, 'web', 'dist');
const latestDist = fs.readdirSync(distParent)
  .filter((d) => /^\d{8,}$/.test(d) && fs.statSync(A(distParent, d)).isDirectory())
  .sort().pop();
if (!latestDist) throw new Error('web/dist 下没有时间戳目录，请先 npm run build:web');

function copy(relSrc, dst, filter) {
  const src = A(ROOT, relSrc);
  if (!fs.existsSync(src)) { console.log(`   · 跳过（不存在）${relSrc}`); return; }
  const dest = A(dst, relSrc);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter });
}
const noJunk = (s) => !/(\.DS_Store|Thumbs\.db|desktop\.ini|\.git$|__pycache__|\.pyc$)/.test(s);

// ---------- 生产依赖（node_modules 只装 dependencies） ----------
function buildProdModules() {
  const dir = A(STAGE_ROOT, '_prod_modules');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(A(ROOT, 'package.json'), A(dir, 'package.json'));
  fs.copyFileSync(A(ROOT, 'package-lock.json'), A(dir, 'package-lock.json'));
  console.log('── 安装生产依赖（npm ci --omit=dev）');
  for (const extra of [['--prefer-offline'], []]) {
    const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', ...extra], { cwd: dir, stdio: 'inherit', shell: true });
    if (r.status === 0) {
      const nm = A(dir, 'node_modules');
      if (!fs.existsSync(A(nm, 'express')) || !fs.existsSync(A(nm, 'multer'))) throw new Error('npm ci 成功但 node_modules 里缺 express/multer');
      console.log(`   ✅ 依赖就绪 ${nm}\n`);
      return nm;
    }
    console.log(`   · 重试（去掉 ${extra.join(' ') || '无附加参数'}）`);
  }
  throw new Error('npm ci --omit=dev 失败——分发包需要能跑起来的 node_modules，先修网络后重跑');
}

// 分发包里的 README：摘掉所有配图行（本包不带 img/，留着就是裂图）。只改暂存副本。
function stripReadmeImages(STAGE) {
  const p = A(STAGE, 'README.md');
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*!\[[^\]]*\]\(img\//.test(lines[i])) { kept.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && /^\s*\*[^*\n]+\*\s*$/.test(lines[j])) i = j;
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  const note = '> **本分发包不含界面截图**——README 里的配图行已摘掉（截图见项目主页）。\n\n';
  fs.writeFileSync(p, out.replace(/^(#\s[^\n]*\n)/, `$1\n${note}`), 'utf8');
}

function deployNote(variant) {
  const common = [
    `面具 mask v${VERSION}（${variant} 版）`,
    '',
    '本包不含任何历史个人数据：data/ 是空目录，首次启动自动建库。',
    '默认管理员：aiadmin / admin123 —— 登录后请立刻在「用户管理」里改掉。',
    '',
    '内置规则引擎开箱即用（40 余条规则、人名四路识别、批量脱敏）。外部引擎（Presidio / GLiNER-PII /',
    'argus-redact / scrubadub / OpenAI Privacy Filter / godlp / sensitive-word）由首次启动自动装配，',
    '需要联网且体积数 GB；装配失败不影响主服务，设置 → 引擎里会如实报哪个不可用。',
    '原文与对照表始终只在本机；本项目不接任何云端 NER。',
    '',
  ];
  const byVariant = {
    windows: [
      '【Windows 部署】',
      '1. 解压到任意目录（路径别太长、别含特殊符号）。',
      '2. 需要 Node.js 22.5 或更高（https://nodejs.org 下载 LTS）。',
      '   本应用用 Node 内置的 node:sqlite，22.4 及以下没有这个模块。',
      '3. 双击 start.bat，浏览器打开 http://127.0.0.1:9909 。',
      '4. 依赖（node_modules）已随包附带，无需联网安装。',
      '5. Windows 上外部引擎装配最完整：Python 引擎 + JDK/Go/Maven 构建的 godlp、sensitive-word。',
    ],
    macos: [
      '【macOS 部署】',
      '1. 解压到任意目录。',
      '2. 需要 Node.js 22.5 或更高（https://nodejs.org 或 brew install node）。',
      '3. 首次运行前给启动器加执行权限：',
      '       cd 解压出来的目录 && chmod +x start.command',
      '   然后双击 start.command。首次双击若被系统拦下，右键 →「打开」。',
      '4. 浏览器打开 http://127.0.0.1:9909 。',
      '5. 依赖（node_modules）已随包附带，正常无需联网安装；若提示缺依赖，在该目录执行 npm install --omit=dev。',
      '',
      '【macOS 外部引擎说明】',
      '· 首次启动自动装配 Python 引擎（Presidio / GLiNER-PII / argus / scrubadub / OPF），需联网、数 GB。',
      '· godlp 与 sensitive-word 的自动构建目前只按 Windows 编写，macOS 上不会装这两个；',
      '  内置规则引擎与 Python 引擎不受影响。',
    ],
    docker: [
      '【Docker 部署】',
      '1. 把整个目录上传到服务器（或群晖 / 飞牛 NAS）。',
      '2. 按需改 docker-compose.yml（端口、管理员密码、挂载路径）。',
      '3. 在目录里执行：',
      '       docker compose up -d --build',
      '4. 容器 restart: unless-stopped，开机自动启动。',
      '5. 浏览器打开 http://<服务器IP>:9909 。',
      '',
      '【说明】',
      '· 本包不含 node_modules，依赖在 docker build 时安装（要联网）。',
      '· MASK_DATA_DIR=/app/data，数据落在宿主机 ./data 目录（compose 已挂载）。',
      '· .dockerignore 已排除 data/，数据库与密钥不会进镜像。',
      '· v0.4.1 起镜像内已构建 godlp 与 sensitive-word，开箱即用，无需改设置。',
      '· Python 引擎（Presidio/GLiNER/OPF/argus/scrubadub）默认不装配（MASK_NO_SETUP=1），',
      '  内置规则引擎 + 两个命令行引擎已够用。需要时执行：',
      '      docker compose exec mask node scripts/engines-setup.mjs',
      '  并把 compose 里 python/vendor、python/models 两行挂载放开，否则容器重建会丢（数 GB）。',
      '· 构建镜像未在本仓库的开发机上实测（开发机没有 Docker）；构建阶段的 godlp Linux 二进制',
      '  已交叉编译验证，sensitive-word jar 已在本机构建。首次 build 需要联网拉 Go/Maven 依赖。',
    ],
  };
  return [...common, ...byVariant[variant], '', '完整功能说明见 README.md。', '开发自检脚本（scripts/check-*.mjs）不随包分发。'].join('\n');
}

const VARIANTS = [
  {
    key: 'windows', label: 'Windows', launcher: 'start.bat',
    dirs: [['server'], [A('web', 'dist', latestDist)], ['vendor', 'engines-src', 'godlp'],
      ['vendor', 'engines-src', 'privacy-filter'], ['vendor', 'godlp-cli'], ['vendor', 'sensitive-word-workspace']],
    files: ['package.json', 'package-lock.json', 'README.md', 'start.bat', '.gitignore',
      A('python', 'sidecar.py'), A('python', 'fetch_models.py'),
      A('scripts', 'start.mjs'), A('scripts', 'engines-setup.mjs')],
    withModules: true,
  },
  {
    key: 'macos', label: 'macOS', launcher: 'start.command',
    dirs: [['server'], [A('web', 'dist', latestDist)], ['vendor', 'engines-src', 'privacy-filter']],
    files: ['package.json', 'package-lock.json', 'README.md', 'start.command', '.gitignore',
      A('python', 'sidecar.py'), A('python', 'fetch_models.py'),
      A('scripts', 'start.mjs'), A('scripts', 'engines-setup.mjs')],
    withModules: true,
  },
  {
    key: 'docker', label: 'Docker', launcher: null,
    dirs: [['server'], [A('web', 'dist', latestDist)], ['vendor', 'engines-src', 'privacy-filter'],
      ['vendor', 'engines-src', 'godlp'], ['vendor', 'godlp-cli'], ['vendor', 'sensitive-word-workspace']],
    files: ['package.json', 'package-lock.json', 'README.md', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.gitignore',
      A('python', 'sidecar.py'), A('python', 'fetch_models.py'),
      A('scripts', 'start.mjs'), A('scripts', 'engines-setup.mjs')],
    withModules: false,
  },
];

fs.mkdirSync(STAGE_ROOT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
console.log(`面具 v${VERSION}｜前端只带 dist/${latestDist}\n`);

const prodModules = VARIANTS.some((v) => v.withModules) ? buildProdModules() : null;

// 产物自检：解包读条目（zipService 会校验 CRC 与大小）
const { extractZip } = await import('../server/services/zipService.js');
function verifyZip(zip, v) {
  const entries = extractZip(fs.readFileSync(zip)).map((e) => e.name);
  const has = (s) => entries.some((n) => n === s || n.endsWith('/' + s));
  const bad = [/\/data\/(mask\.sqlite|secret\.key)/, /\/Logs\//, /\/web\/src\//, /\/python\/vendor\//,
    /\/python\/models\//, /\/vendor\/jdk\//, /\/vendor\/go\//, /\/vendor\/maven\//, /\/vendor\/dl\//];
  const hit = bad.find((re) => entries.some((n) => re.test(n)));
  if (hit) throw new Error(`${v.key} 包含不该分发的路径：${hit}`);
  for (const need of ['server/index.js', `web/dist/${latestDist}/index.html`, 'package.json', 'README.md',
    'scripts/start.mjs', 'scripts/engines-setup.mjs', 'python/sidecar.py']) {
    if (!has(need)) throw new Error(`${v.key} 缺少 ${need}`);
  }
  if (v.launcher && !has(v.launcher)) throw new Error(`${v.key} 缺少启动器 ${v.launcher}`);
  if (v.withModules && !has('node_modules/express/index.js')) throw new Error(`${v.key} 缺少生产依赖`);
  console.log(`   ✓ 条目 ${entries.length} 个，敏感路径 0 个`);
}

const result = [];
for (const v of VARIANTS) {
  const dirName = `面具-${VERSION}-${v.key}`;
  const STAGE = A(STAGE_ROOT, dirName);
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  console.log(`── ${v.label} → ${dirName}`);

  for (const seg of v.dirs) copy(A(...seg), STAGE, noJunk);
  for (const f of v.files) copy(f, STAGE, noJunk);
  if (v.withModules) fs.cpSync(prodModules, A(STAGE, 'node_modules'), { recursive: true, filter: noJunk });
  stripReadmeImages(STAGE);

  fs.mkdirSync(A(STAGE, 'data'), { recursive: true }); // 空壳：首启建库
  fs.writeFileSync(A(STAGE, '部署说明.txt'), deployNote(v.key), 'utf8');

  const zip = A(OUT, `${dirName}.zip`);
  fs.rmSync(zip, { force: true });
  // 必须用 scripts/zip-utf8.py：bsdtar/tar 写 zip 不给中文名打 UTF-8 标志，Windows 解压会乱码
  const z = spawnSync('python', [A(ROOT, 'scripts', 'zip-utf8.py'), STAGE, zip], { stdio: 'inherit', shell: true });
  if (z.status !== 0) throw new Error(`压缩失败 code=${z.status}（${zip}）`);
  verifyZip(zip, v);
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log(`   ✅ ${path.basename(zip)}  ${mb} MB\n`);
  result.push({ variant: v.key, zip, mb });
}

console.log('════════ 结果 ════════');
for (const r of result) console.log(`  ${r.variant.padEnd(8)} ${r.mb.padStart(6)} MB  ${r.zip}`);
