#!/usr/bin/env node
// 面具启动入口（v0.3.2）：先确保项目内引擎运行时/模型就位（首次装、之后只检查），再起主服务。
// 装配失败只警告，不拦主服务——内置规则引擎不依赖外部引擎，探测页会如实说哪些不可用。
// MASK_NO_SETUP=1 可跳过装配（调试/离线且已装好时用）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

if (process.env.MASK_NO_SETUP !== '1') {
  console.log('[mask] 检查本地脱敏引擎（首次启动会安装，可能耗时较久；已装好则秒过）…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'engines-setup.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    console.warn('[mask] 引擎装配未完成；主服务照常启动，外部引擎会如实报「不可用」。');
    console.warn('[mask] 装好依赖后重启即可，或单独运行：npm run setup:engines');
  }
}

await import('../server/index.js');
