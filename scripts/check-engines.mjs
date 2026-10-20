#!/usr/bin/env node
// 面具 mask — 多引擎架构自检（v0.3.0 需求 7+8）
// 起真实服务（临时库）+ 真边车（python python/sidecar.py --port 9812）+ stdio mock（engine-mock-stdio.mjs）
// 覆盖：注册表/权限/配置校验、探测、stdio 适配器真链路、边车真链路、主引擎/并行两种模式、
//       内置让位语义、引擎失败如实 502、致谢、并行去重。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9927;
const BASE = `http://127.0.0.1:${PORT}`;
const SIDECAR_PORT = 9812;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${JSON.stringify(detail).slice(0, 300)}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-eng-'));
const srv = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, MASK_DATA_DIR: dataDir, PORT: String(PORT), MASK_GEO: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
const sidecar = spawn('python', [path.join(ROOT, 'python/sidecar.py'), '--port', String(SIDECAR_PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let sidecarLog = '', srvLog = '';
sidecar.stderr.on('data', (d) => { sidecarLog += d; });
sidecar.stdout.on('data', (d) => { sidecarLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });
srv.stdout.on('data', (d) => { srvLog += d; });

const children = [];
srv.on('exit', (c) => { if (c && !process.exitCode) { console.log('--- server exit', c); console.log(srvLog.slice(-2000)); } });

async function waitPort(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.status > 0) return true; } catch { /* 还没起 */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(300);
  }
}

async function putConfig(tok, body) {
  return req('PUT', '/api/engines/config', { token: tok, body });
}
const MOCK_CMD = `node "${path.join(ROOT, 'scripts/engine-mock-stdio.mjs')}"`;

try {
  if (!await waitPort(BASE + '/api/health', 15000)) throw new Error('服务没起来：' + srvLog.slice(-800));
  if (!await waitPort(`http://127.0.0.1:${SIDECAR_PORT}/health`, 15000)) throw new Error('边车没起来：' + sidecarLog.slice(-800));
  console.log('A. 边车本体');
  {
    const h = await (await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`)).json();
    ok('A1 health 回引擎可用性表', h.ok === true && typeof h.engines === 'object' && 'selftest' in h.engines && 'presidio' in h.engines, h);
    ok('A2 自检引擎恒可用', h.engines.selftest === true, h.engines);
  }

  const lo = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'admin123' } });
  const tk = lo.json.token;

  console.log('B. 注册表 / 权限 / 配置校验');
  {
    const anon = await req('GET', '/api/engines');
    ok('B1 匿名 401', anon.status === 401, anon.status);
    const lst = await req('GET', '/api/engines', { token: tk });
    const ids = lst.json.engines.map((e) => e.id);
    ok('B2 六引擎注册（含隐藏自检）', ['builtin', 'godlp', 'sensitive_word', 'presidio', 'gliner', 'argus', 'selftest'].every((x) => ids.includes(x)), ids);
    ok('B3 selftest 标记 hidden（UI 不显示）', lst.json.engines.find((e) => e.id === 'selftest').hidden === true);
    ok('B4 默认配置 主引擎=内置', lst.json.config.mode === 'primary' && lst.json.config.primary === 'builtin', lst.json.config);
    const bad = await putConfig(tk, { mode: 'primary', primary: 'nope-engine' });
    ok('B5 主引擎不存在 → 400', bad.status === 400, bad);
    const bad2 = await putConfig(tk, { mode: 'primary', primary: 'godlp', commands: { godlp: 'x\nrm -rf' } });
    ok('B6 命令带换行被拒', bad2.status === 400, bad2);
    const good = await putConfig(tk, { mode: 'primary', primary: 'builtin', enabled: { builtin: true } });
    ok('B7 合法配置 200', good.status === 200 && good.json.config.primary === 'builtin', good.json);
  }

  console.log('C. 探测（真调用）');
  {
    const p1 = await req('POST', '/api/engines/probe', { token: tk, body: { id: 'selftest' } });
    ok('C1 边车自检引擎探测可用', p1.json.ok === true, p1.json);
    const p2 = await req('POST', '/api/engines/probe', { token: tk, body: { id: 'gliner' } });
    ok('C2 未装依赖如实报（或装了也可用）', p2.json.ok === true || /安装|导入失败|导入/.test(p2.json.error || ''), p2.json);
    const p3 = await req('POST', '/api/engines/probe', { token: tk, body: { id: 'nope' } });
    ok('C3 未知引擎拒', p3.json.ok === false, p3.json);
    const p4 = await req('POST', '/api/engines/probe', { token: tk, body: { id: 'godlp' } });
    ok('C4 godlp 未配命令时探测失败（命令不存在）', p4.json.ok === false, p4.json);
  }

  console.log('D. stdio 适配器（mock 包装走真链路）');
  {
    await putConfig(tk, { mode: 'primary', primary: 'builtin', enabled: {}, commands: { godlp: MOCK_CMD } });
    const pr = await req('POST', '/api/engines/probe', { token: tk, body: { id: 'godlp' } });
    ok('D1 配置命令后 godlp 探测可用', pr.json.ok === true && pr.json.sample_count >= 2, pr.json);
    const tt = await req('POST', '/api/engines/test', { token: tk, body: { id: 'godlp', text: '门禁卡12345678，联系 13812345678 或 a@b.com' } });
    const keys = (tt.json.candidates || []).map((c) => c.key);
    ok('D2 PHONE/EMAIL 映射到内置 key', keys.includes('mobile') && keys.includes('email'), tt.json);
    ok('D3 未知类型走 EXT 码', keys.includes('ext') && tt.json.candidates.some((c) => c.key === 'ext' && c.ext_type === 'BADGE_ID'), tt.json);
  }

  console.log('E. 并行模式（并集 + 去重 + 坐标重定位）');
  {
    await putConfig(tk, { mode: 'parallel', primary: 'builtin', enabled: { selftest: true, godlp: true }, commands: { godlp: MOCK_CMD } });
    const pv = await req('POST', '/api/rules/preview', { token: tk, body: { text: '打卡机坏了，联系 13812345678' } });
    ok('E1 手机号被脱敏', pv.status === 200 && pv.json.masked && !pv.json.masked.includes('13812345678'), pv.json);
    const phones = (pv.json.mapping || []).filter((e) => e.term === '13812345678');
    ok('E2 双引擎同报手机号 → 去重成一个码', phones.length === 1, pv.json.mapping);
    const ext = (pv.json.mapping || []).find((e) => e.key === 'ext');
    ok('E3 打卡机（自检引擎故意给错坐标）按内容重定位成 EXT', !!ext && ext.term === '打卡机', pv.json.mapping);
    // 边车自检引擎的实体坐标故意写 0/1（码点/UTF-16 分歧的模型），重定位必须兜住
    const pv2 = await req('POST', '/api/rules/preview', { token: tk, body: { text: 'a@b.com 在场' } });
    ok('E4 邮箱同样重定位成功', pv2.json.masked && !pv2.json.masked.includes('a@b.com'), pv2.json);
  }

  console.log('F. 主引擎模式（内置让位 + 失败如实）');
  {
    await putConfig(tk, { mode: 'primary', primary: 'selftest' });
    const pv = await req('POST', '/api/rules/preview', { token: tk, body: { text: '工资金额 25000元，联系 13812345678' } });
    ok('F1 主引擎=selftest：手机号脱敏', pv.status === 200 && !pv.json.masked.includes('13812345678'), pv.json);
    ok('F2 内置启发式让位（金额不再被内置规则咬）', pv.json.masked.includes('25000'), pv.json.masked);
    // 失败路径：主引擎命令退出码非零
    await putConfig(tk, { mode: 'primary', primary: 'godlp', commands: { godlp: 'node -e "process.exit(3)"' } });
    const f1 = await req('POST', '/api/rules/preview', { token: tk, body: { text: '联系 13812345678' } });
    ok('F3 主引擎失败 → 502 如实（绝不静默放行原文）', f1.status === 502 && /退出码 3/.test(f1.json.error || ''), f1.json);
    // 并行全失败同样 502
    await putConfig(tk, { mode: 'parallel', primary: 'builtin', enabled: { godlp: true }, commands: { godlp: 'node -e "process.exit(4)"' } });
    const f2 = await req('POST', '/api/rules/preview', { token: tk, body: { text: '联系 13812345678' } });
    ok('F4 并行引擎全失败 → 502 如实', f2.status === 502 && /全部失败/.test(f2.json.error || ''), f2.json);
    // 恢复默认：主引擎=内置，纯内置零外呼
    await putConfig(tk, { mode: 'primary', primary: 'builtin', enabled: {}, commands: { godlp: MOCK_CMD } });
    const pv3 = await req('POST', '/api/rules/preview', { token: tk, body: { text: '工资金额 25000元' } });
    ok('F5 切回内置：启发式恢复（金额被咬）', pv3.status === 200 && !pv3.json.masked.includes('25000'), pv3.json);
  }

  console.log('G. 致谢（探测成功的才进）');
  {
    const anon = await req('GET', '/api/engines/ack');
    ok('G1 匿名 401', anon.status === 401, anon.status);
    const ack = await req('GET', '/api/engines/ack', { token: tk });
    const names = ack.json.items.map((x) => x.name);
    ok('G2 探测成功的 godlp/自检引擎在列', names.includes('godlp') && names.some((n) => n.includes('自检')), names);
    ok('G3 没探测成功的 presidio 不在列', !names.includes('Presidio'), names);
    const g = ack.json.items.find((x) => x.name === 'godlp');
    ok('G4 致谢带仓库/许可/厂商', g.home.includes('gitee.com/bytedance/godlp') && !!g.vendor && !!g.license, g);
  }
} catch (e) {
  fail++;
  console.log('FATAL', e.message);
  if (sidecarLog) console.log('--- sidecar log ---\n' + sidecarLog.slice(-1500));
} finally {
  srv.kill(); sidecar.kill();
  await sleep(400);
}

console.log(`\ncheck-engines：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
