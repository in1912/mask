'use strict';
// 引擎运行时路径（v0.4.5）
//
// 背景：生产 Docker 把宿主机目录挂到了 /app/vendor，挂载点带 noexec，于是
// 「安装命令行引擎」在 Maven 那一步炸成 spawnSync /app/vendor/maven/bin/mvn EACCES——
// 文件在、可读、可写，就是不能执行。vendor 下所有可执行文件（mvn / java / go /
// 编译出来的 godlp-cli）都会被同一个问题挡住，逐个 chmod 也没用。
//
// 所以安装器会把「要执行的」装到另一个目录（默认 <项目>/.engines，可用 MASK_ENGINES_HOME
// 指定），并写 vendor/.engines-home.json 记下来。本模块统一解析，默认命令跟着走——
// 用户没改过命令时不需要知道这件事。
//
// 解析优先级：MASK_ENGINES_HOME 环境变量 > vendor/.engines-home.json > vendor/
// 每个路径再具体挑「先 home 后 vendor」里真实存在的那个文件，单测/旧部署都不受影响。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'vendor');
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
// MASK_ENGINES_MARKER 只给自检用：让测试能写临时标点文件，不去动项目里真的那个
const MARKER = process.env.MASK_ENGINES_MARKER
  ? path.resolve(process.env.MASK_ENGINES_MARKER)
  : path.join(VENDOR, '.engines-home.json');

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// 标点文件可能半写（安装器写时进程被杀），读坏了就当没有，退回 vendor。
// vendor 只读时安装器会把标点文件放到项目根，这里两个位置都看。
function markerHome() {
  for (const f of [MARKER, path.join(ROOT, '.engines-home.json')]) {
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (m && typeof m.home === 'string' && path.isAbsolute(m.home)) return m.home;
    } catch { /* 没有或读不了 */ }
  }
  return null;
}

function home() {
  if (process.env.MASK_ENGINES_HOME) return path.resolve(process.env.MASK_ENGINES_HOME);
  return markerHome() || VENDOR;
}

const firstExisting = (cands) => cands.find(existsFile) || cands[0];

function paths() {
  const h = home();
  return {
    home: h,
    vendor: VENDOR,
    // 编译产物：go 出的二进制必须能执行 → 跟着 home
    godlp: firstExisting([
      path.join(h, 'godlp', `godlp-cli${EXE}`),
      path.join(VENDOR, 'godlp', `godlp-cli${EXE}`),
    ]),
    // jar 只需要被 java 读，不需要执行位 → 先找 home，再找 vendor（Docker 镜像里在 vendor）
    swJar: firstExisting([
      path.join(h, 'sensitive-word', 'sensitive-word-cli.jar'),
      path.join(VENDOR, 'sensitive-word', 'sensitive-word-cli.jar'),
    ]),
    java: firstExisting([
      path.join(h, 'jdk', 'bin', `java${EXE}`),
      path.join(VENDOR, 'jdk', 'bin', `java${EXE}`),
    ]),
  };
}

function godlpCommand() {
  return `"${paths().godlp}"`;
}

function sensitiveWordCommand() {
  const p = paths();
  return `"${p.java}" -cp "${p.swJar}" local.mask.SensitiveWordCli`;
}

module.exports = { ROOT, VENDOR, EXE, IS_WIN, MARKER, home, markerHome, paths, godlpCommand, sensitiveWordCommand };
