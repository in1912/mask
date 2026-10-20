#!/usr/bin/env node
// 面具 mask — 自签 SSL 自检（v0.3.0）
// 两阶段：A 起服务测 API（状态/生成/下载/校验/权限/重启探针）；B 证书落盘后真重启进程，
// 验证同端口 HTTP/HTTPS 双协议（0x16 嗅探）真的在跑。全程临时数据目录。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9931;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${JSON.stringify(detail).slice(0, 260)}`); }
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
  return { status: r.status, json: await r.json().catch(() => ({})), text: r.ok ? '' : await r.text().catch(() => '') };
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-ssl-'));
let srv = null, srvLog = '';

function startServer() {
  srv = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, MASK_NO_SIDECAR: '1', MASK_DATA_DIR: dataDir, PORT: String(PORT), MASK_GEO: 'off', MASK_NO_RESTART: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.stdout.on('data', (d) => { srvLog += d; });
}
async function waitHealth(ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { /* 还没起 */ }
    if (Date.now() - t0 > ms) return false;
    await sleep(300);
  }
}
function httpsGet(p) { // 自签名：必须 rejectUnauthorized:false 才能握上手
  return new Promise((resolve) => {
    const r = https.request(`${BASE.replace('http:', 'https:')}${p}`, { rejectUnauthorized: false }, (res) => {
      const cert = res.socket ? res.socket.getPeerCertificate(true) : null; // 响应结束时 socket 可能已摘下，进场先抓
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: b, cert }));
    });
    r.on('error', (e) => resolve({ ok: false, error: e.message }));
    r.end();
  });
}
function httpsStrict(p) { // 不关校验：自签名证书应当握不上手（证明对面的确是 TLS）
  return new Promise((resolve) => {
    const r = https.request(`${BASE.replace('http:', 'https:')}${p}`, (res) => resolve({ ok: true }));
    r.on('error', () => resolve({ ok: false }));
    r.end();
  });
}

try {
  startServer();
  if (!await waitHealth()) throw new Error('服务没起来：' + srvLog.slice(-600));

  const lo = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'admin123' } });
  const tk = lo.json.token;

  console.log('A. 证书 API');
  {
    const anon = await req('GET', '/api/ssl/status');
    ok('A1 匿名 401', anon.status === 401, anon.status);
    const s0 = await req('GET', '/api/ssl/status', { token: tk });
    ok('A2 初始未配置', s0.json.configured === false && s0.json.max_days === 825, s0.json);
    const gen0 = await req('POST', '/api/ssl/generate', { token: tk, body: { cn: '' } });
    ok('A3 空 CN 拒绝', gen0.status === 400, gen0.json);
    const gen = await req('POST', '/api/ssl/generate', { token: tk, body: { cn: 'mask-check.local', org: 'check', san: '127.0.0.1, mask-check.local, 10.1.1.9', days: 99999 } });
    ok('A4 生成成功且天数夹到 825', gen.status === 200 && gen.json.ok && gen.json.days === 825, gen.json);
    ok('A5 SAN 域名/IP 解析（localhost 自动附赠）', gen.json.dns.includes('mask-check.local') && gen.json.dns.includes('localhost') && gen.json.ips.includes('10.1.1.9') && gen.json.ips.includes('127.0.0.1'), gen.json);
    ok('A6 替换后待重启标记', gen.json.status.pending_restart === true, gen.json.status);
    const cert = await fetch(BASE + '/api/ssl/file/cert?token=' + encodeURIComponent(tk));
    ok('A7 证书下载为 PEM', cert.status === 200 && (await cert.text()).includes('-----BEGIN CERTIFICATE-----'));
    const keyAnon = await fetch(BASE + '/api/ssl/file/key');
    ok('A8 私钥匿名不可下', keyAnon.status === 401, keyAnon.status);
    // 普通用户 403（管理员建号，走真实登录）
    await req('POST', '/api/users', { token: tk, body: { username: 'u_ssl', password: '12345678', role: 'user', display_name: '测' } });
    const lo2 = await req('POST', '/api/auth/login', { body: { username: 'u_ssl', password: '12345678' } });
    const s2 = await req('GET', '/api/ssl/status', { token: lo2.json.token });
    ok('A9 普通用户 403', s2.status === 403, s2.status);
    // 公钥不匹配的上传被拒
    const bad = await req('POST', '/api/ssl/upload', { token: tk, body: { cert: (await (await fetch(BASE + '/api/ssl/file/cert?token=' + encodeURIComponent(tk))).text()), key: '-----BEGIN PRIVATE KEY-----\nnotakey\n-----END PRIVATE KEY-----' } });
    ok('A10 私钥不匹配拒绝', bad.status === 400 && /匹配/.test(bad.json.message || ''), bad.json);
    // 重启探针（不真重启）：自检环境 MASK_NO_RESTART=1 回 suppressed，探针参数回 skipped
    const rs = await req('POST', '/api/ssl/restart', { token: tk, body: { restart: false } });
    ok('A11 重启探针（进程还在）', ['skipped', 'suppressed'].includes(rs.json.restart) && await waitHealth(3000), rs.json);
  }

  console.log('B. 真重启后同端口双协议');
  {
    srv.kill();
    await sleep(600);
    startServer();
    if (!await waitHealth()) throw new Error('重启后服务没起来：' + srvLog.slice(-600));
    const h = await fetch(BASE + '/api/health');
    ok('B1 重启后纯 HTTP 仍通', h.status === 200);
    const t = await httpsGet('/api/health');
    ok('B2 同端口 HTTPS 也通（0x16 嗅探）', t.ok && t.status === 200 && /ok/.test(t.body), t);
    const subj = t.cert ? `${t.cert.subject?.CN || ''} ${t.cert.subjectaltname || ''}` : ''; // node 证书对象是 null 原型，String() 会炸
    ok('B3 对面证书就是刚生成的（CN/SAN）', /mask-check\.local/.test(subj), subj);
    const strict = await httpsStrict('/api/health');
    ok('B4 严格校验握不上手（自签名未导入信任库）', strict.ok === false);
    const s1 = await req('GET', '/api/ssl/status', { token: tk });
    ok('B5 重启后待重启标记清除', s1.json.pending_restart === false, s1.json);
  }
} catch (e) {
  fail++;
  console.log('FATAL', e.message);
} finally {
  if (srv) srv.kill();
  await sleep(300);
}

console.log(`\ncheck-ssl：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
