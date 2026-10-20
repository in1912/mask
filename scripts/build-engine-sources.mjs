#!/usr/bin/env node
// 生成 server/services/engineSources.js：把两个命令行引擎的构建源码打进 JS（base64 zip）。
//
// 为什么需要：在线升级白名单只允许 server/**.js、web/dist、package.json，带不了 vendor/。
// 旧镜像（或 vendor/ 被宿主机卷整个盖住）里没有 godlp-cli / sensitive-word-workspace，
// 生产上点「安装命令行引擎」会卡在「找不到 pom.xml」。内置一份源码让安装器自给自足。
//
// 源码很小（约 260KB），只在安装器发现源码缺失时铺开；本地有源码时不会动它。
// 改 vendor 里的源码后必须重跑本脚本，check-setup 会比对两边是否一致。
//
// 用法：node scripts/build-engine-sources.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const { buildZip } = await import('../server/services/zipService.js');
const A = (...p) => path.join(ROOT, ...p);

// 只收构建真正需要的：godlp-cli + godlp 源码 + sensitive-word 工作区（不含 target/ 与 .git）
function walk(dir, out) {
  for (const n of fs.readdirSync(dir)) {
    if (n === '.git' || n === 'target' || n === '__pycache__') continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
}
const files = [];
for (const rel of ['vendor/godlp-cli', 'vendor/engines-src/godlp', 'vendor/sensitive-word-workspace']) {
  walk(A(rel), files);
}
const entries = files
  .map((abs) => ({ name: path.relative(A('vendor'), abs).split(path.sep).join('/'), data: fs.readFileSync(abs) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const zip = buildZip(entries);
const sha = crypto.createHash('sha256').update(zip).digest('hex');
const out = `'use strict';
// 自动生成，勿手改：node scripts/build-engine-sources.mjs
// 内容 = vendor/godlp-cli + vendor/engines-src/godlp + vendor/sensitive-word-workspace 的 zip。
// 用途：安装器发现构建源码缺失（旧镜像 / vendor 被挂载）时铺到 vendor/ 下。
const ZIP_B64 = '${zip.toString('base64')}';
module.exports = { zip_b64: ZIP_B64, sha256: '${sha}', entries: ${entries.length}, built_at: '${new Date().toISOString()}' };
`;
fs.writeFileSync(A('server', 'services', 'engineSources.js'), out, 'utf8');
console.log(`✅ server/services/engineSources.js  ${entries.length} 个文件  zip ${(zip.length / 1024).toFixed(1)} KB  ${sha.slice(0, 12)}`);
