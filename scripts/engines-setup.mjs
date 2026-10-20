#!/usr/bin/env node
// 面具 mask — 外部引擎装配的命令行入口（薄包装）。
// 本体在 server/services/enginesInstaller.js：在线升级只带 server/**.js，放在那里生产才升得动。
// 用法不变：node scripts/engines-setup.mjs [--only=all|cli|python] [--force]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.exit(require('../server/services/enginesInstaller.js').runCli(process.argv.slice(2)));
