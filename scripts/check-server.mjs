#!/usr/bin/env node
// 面具 mask — 服务级自检：起真实服务（临时数据目录），测登录三态/限流/IP黑名单/用户/规则/历史/附件/聊天降级
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9919;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, { token, body, xff } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(xff ? { 'X-Forwarded-For': xff } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// SSE 读取
async function sse(p, body, token) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  });
  if (!r.ok) return { status: r.status, events: [], json: await r.json().catch(() => ({})) };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const f = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const l = f.split('\n').find((x) => x.startsWith('data: '));
      if (l) { try { events.push(JSON.parse(l.slice(6))); } catch { /* 残帧 */ } }
    }
  }
  return { status: 200, events };
}

// ---- 无压缩 zip 构造（测 docx 提取）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(entries) {
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ---- 启动 ----
const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-check-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, MASK_NO_SIDECAR: '1', MASK_DATA_DIR: dataDir, PORT: String(PORT), MASK_GEO: 'off' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250);
  try { up = (await fetch(BASE + '/api/health')).ok; } catch { /* 未起 */ }
}
if (!up) { console.error('服务未能在 10s 内启动'); child.kill(); process.exit(1); }

try {
  console.log('A. 系统信息与登录');
  {
    const info = await req('GET', '/api/system-info');
    ok('A1 system-info 免登录可达', info.status === 200 && info.json.name === '面具');
    ok('A2 备案号默认为空（登录页不显示）', info.json.beian === '');

    const bad = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'wrongpw' }, xff: '8.8.4.4' });
    ok('A3 错误密码 401', bad.status === 401);
    const badLocal = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'wrongpw2' } });
    ok('A3b 本机来源失败也 401', badLocal.status === 401);

    const lo = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'admin123' } });
    ok('A4 默认管理员可登录', lo.status === 200 && lo.json.token);
    const tk = lo.json.token;

    const me = await req('GET', '/api/auth/me', { token: tk });
    ok('A5 me 返回角色 admin', me.json.user?.role === 'admin');

    const th = await req('POST', '/api/auth/theme', { token: tk, body: { theme: 'purple' } });
    const me2 = await req('GET', '/api/auth/me', { token: tk });
    ok('A6 主题保存后 me 读回 purple', th.status === 200 && me2.json.theme === 'purple');

    const anon = await req('GET', '/api/conversations');
    ok('A7 无 token 401', anon.status === 401);

    console.log('B. 登录日志（三态 + 尝试密码加密）');
    const logs = await req('GET', '/api/login-logs?size=15', { token: tk });
    ok('B1 日志默认 5 条/页可改', logs.json.size === 15);
    const failRow = logs.json.rows.find((r) => r.password === 'wrongpw');
    ok('B2 失败行含解密后的尝试密码 wrongpw', failRow?.status === 'fail' && failRow?.username === 'aiadmin');
    ok('B3 失败行有客户端标签', !!failRow?.client && failRow.client.length > 3);
    const localFail = logs.json.rows.find((r) => r.password === 'wrongpw2');
    ok('B4 私网来源地区=内网(不出网)', localFail?.region === '内网');
    const pubFail = logs.json.rows.find((r) => r.password === 'wrongpw');
    ok('B4b 公网来源地区留空(MASK_GEO=off)', pubFail?.region === '');
    const okRow = logs.json.rows.find((r) => r.status === 'ok');
    ok('B5 成功行不存密码', okRow && okRow.password == null);

    console.log('C. 暴力防护与 IP 黑名单');
    let last = null;
    for (let i = 0; i < 9; i++) last = await req('POST', '/api/auth/login', { body: { username: 'nobody', password: 'x' }, xff: '9.9.9.9' });
    ok('C1 同 IP 第 9 次尝试被 429 拦截', last.status === 429);
    const logs2 = await req('GET', '/api/login-logs?size=100', { token: tk });
    ok('C2 拦截行记为 blocked', logs2.json.rows.some((r) => r.status === 'blocked' && r.ip === '9.9.9.9'));

    const ban = await req('POST', '/api/ip-blacklist', { token: tk, body: { ip: '1.2.3.4', note: '测试封禁' } });
    ok('C3 黑名单可添加', ban.status === 200);
    const hit = await fetch(BASE + '/api/health', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    ok('C4 被封 IP 全站 403（含免登录路径）', hit.status === 403);
    const loop = await req('POST', '/api/ip-blacklist', { token: tk, body: { ip: '127.0.0.1' } });
    ok('C5 回环地址拒绝封禁', loop.status === 400);
    await req('DELETE', '/api/ip-blacklist/1.2.3.4', { token: tk });
    const after = await fetch(BASE + '/api/health', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    ok('C6 解封后恢复 200', after.status === 200);

    // v1.01：同一账号输错 3 次 → 锁 30 分钟；提示不透露剩余时间
    console.log('C7. 账号输错 3 次锁定 30 分钟');
    await req('POST', '/api/users', { token: tk, body: { username: 'locktest', password: '123456', role: 'user' } });
    const LOCK_MSG = '密码输入错误上限已达，禁止登录系统';
    const f1 = await req('POST', '/api/auth/login', { body: { username: 'locktest', password: 'bad' }, xff: '8.8.8.8' });
    const f2 = await req('POST', '/api/auth/login', { body: { username: 'locktest', password: 'bad' }, xff: '8.8.8.8' });
    const f3 = await req('POST', '/api/auth/login', { body: { username: 'locktest', password: 'bad' }, xff: '8.8.8.8' });
    ok('C7 前两次错误仍是 401', f1.status === 401 && f2.status === 401);
    ok('C8 第 3 次锁定且提示只有一句', f3.status === 403 && f3.json.error === LOCK_MSG, JSON.stringify(f3.json));
    const f4 = await req('POST', '/api/auth/login', { body: { username: 'locktest', password: '123456' }, xff: '8.8.8.8' });
    ok('C9 锁定期内密码正确也拒绝', f4.status === 403 && f4.json.error === LOCK_MSG);
    const users = await req('GET', '/api/users', { token: tk });
    const lockUser = users.json.users.find((x) => x.username === 'locktest');
    ok('C10 用户表能看到限时锁定', !!lockUser?.locked_until);
    await req('PUT', '/api/users/' + lockUser.id, { token: tk, body: { unlock: true } });
    const f5 = await req('POST', '/api/auth/login', { body: { username: 'locktest', password: '123456' }, xff: '8.8.8.8' });
    ok('C11 管理员解锁后可登录', f5.status === 200 && !!f5.json.token);

    console.log('D. 用户管理与权限');
    const nu = await req('POST', '/api/users', { token: tk, body: { username: 'u1', password: '123456', role: 'user', display_name: '测试员' } });
    ok('D1 创建普通用户', nu.status === 200);
    const lo2 = await req('POST', '/api/auth/login', { body: { username: 'u1', password: '123456' } });
    const tk2 = lo2.json?.token;
    ok('D2 新用户可登录', !!tk2);
    const forbidden = await req('GET', '/api/users', { token: tk2 });
    ok('D3 普通用户访问用户管理 403', forbidden.status === 403);
    const th2 = await req('POST', '/auth/theme'.replace('/auth', '/api/auth'), { token: tk2, body: { theme: 'green' } });
    const me3 = await req('GET', '/api/auth/me', { token: tk2 });
    ok('D4 普通用户可改自己的主题', th2.status === 200 && me3.json.theme === 'green');

    console.log('D5. 站点默认风格（管理员统一，用户自选优先）');
    const sys1 = await req('GET', '/api/settings/system', { token: tk });
    ok('D5 系统设置返回站点默认风格', sys1.status === 200 && sys1.json.default_theme === 'dark', JSON.stringify(sys1.json));
    const setDef = await req('POST', '/api/settings/system', { token: tk, body: { default_theme: 'light' } });
    const meLock = await req('GET', '/api/auth/me', { token: f5.json.token });
    ok('D6 没自选过的用户跟随站点默认 light', setDef.status === 200 && meLock.json.theme === 'light', String(meLock.json.theme));
    const meOwn = await req('GET', '/api/auth/me', { token: tk2 });
    ok('D7 自己选过风格的用户不被覆盖', meOwn.json.theme === 'green', String(meOwn.json.theme));
    const badDef = await req('POST', '/api/settings/system', { token: tk, body: { default_theme: 'pink' } });
    const sys2 = await req('GET', '/api/settings/system', { token: tk });
    ok('D8 非法风格拒绝且不改动', badDef.status === 400 && sys2.json.default_theme === 'light', String(badDef.status));
    await req('POST', '/api/settings/system', { token: tk, body: { default_theme: 'dark' } });

    console.log('E. 规则配置 / 试运行 / 历史');
    const save = await req('PUT', '/api/rules/config', {
      token: tk,
      body: { enabled: 1, code_style: 'B', mask_numbers: 0, amount_on: 1, types: { nickname: false }, fixed: ['绝密项目'] }
    });
    ok('E1 保存规则配置', save.status === 200 && save.json.cfg.code_style === 'B');
    const meta = await req('GET', '/api/rules/meta', { token: tk });
    ok('E2 meta 含四大类与配置', Object.keys(meta.json.catalog).length === 4 && meta.json.cfg.types.nickname === false);
    const pv = await req('POST', '/api/rules/preview', {
      token: tk,
      body: { text: '客户是杭州云梯智造有限公司，联系电话 13812345678，涉及绝密项目。' }
    });
    ok('E3 试运行已脱敏', pv.status === 200 && pv.json.masked && !pv.json.masked.includes('13812345678') && !pv.json.masked.includes('云梯'));
    ok('E4 B 风格序号码', pv.json.masked.includes('公司1') && pv.json.masked.includes('手机号1') && pv.json.masked.includes('关键词1'));
    ok('E5 试运行记入历史', typeof pv.json.history_id === 'number');
    const det = await req('GET', `/api/history/${pv.json.history_id}`, { token: tk });
    ok('E6 历史详情含对照映射', det.json.mapping?.some((e) => e.term === '13812345678'));
    const rv = await req('POST', `/api/history/${pv.json.history_id}/review`, { token: tk, method: 'POST' });
    ok('E7 二次复核完整', rv.json.verdict === 'complete' && rv.json.restoredCount >= 3);
    const hist = await req('GET', '/api/history?scope=preview', { token: tk });
    ok('E8 历史列表按来源过滤', hist.json.rows.length === 1);
    const u1hist = await req('GET', '/api/history', { token: tk2 });
    ok('E9 普通用户只看到自己的（0 条）', u1hist.json.total === 0);

    console.log('F. 附件提取');
    {
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.from('客户是杭州云梯智造有限公司，电话 13812345678', 'utf8')]), 'note.txt');
      const r = await fetch(BASE + '/api/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: fd });
      const j = await r.json();
      ok('F1 txt 附件提取', r.status === 200 && j.engine === 'plain' && j.text.includes('13812345678'));

      const docx = zipStore([
        { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>杭州云梯智造有限公司 报价 45万元</w:t></w:r></w:p></w:body></w:document>' }
      ]);
      const fd2 = new FormData();
      fd2.append('file', new Blob([docx]), '合同.docx');
      const r2 = await fetch(BASE + '/api/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: fd2 });
      const j2 = await r2.json();
      ok('F2 自造 docx 提取正文', r2.status === 200 && j2.engine === 'docx' && j2.text.includes('云梯') && j2.text.includes('45万元'));

      const fd3 = new FormData();
      fd3.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])]), 'photo.png');
      const r3 = await fetch(BASE + '/api/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: fd3 });
      const j3 = await r3.json();
      ok('F3 图片附件如实拒收', r3.status === 400 && /图片/.test(j3.error));
    }

    console.log('G. 聊天降级路径');
    await req('POST', '/api/settings/ai-config', { token: tk, body: { model: 'stub-1', base_url: 'http://127.0.0.1:9/v1', api_key: 'sk-test123' } });
    const aicfg = await req('GET', '/api/settings/ai-config', { token: tk });
    ok('G1 Key 只回尾号不回明文', aicfg.json.has_key === true && aicfg.json.key_tail === 't123' && !JSON.stringify(aicfg.json).includes('sk-test123'));
    const chatErr = await sse('/api/chat', { messages: [{ role: 'user', content: '你好' }], desensitize: false }, tk);
    ok('G2 上游不通时 SSE 如实报错', chatErr.events.some((e) => e.type === 'error'));

    const nokey = await req('POST', '/api/chat', { token: tk, body: { messages: [] } });
    ok('G3 空 messages 400', nokey.status === 400);

    console.log('H. Agent 链接备注与批量导出');
    const mk1 = await req('POST', '/api/agents', { token: tk, body: { days: 0 } });
    await req('PUT', '/api/agents/' + mk1.json.id, { token: tk, body: { remark: '客户A回文' } });
    const list = await req('GET', '/api/agents?size=5', { token: tk });
    ok('H1 备注已保存并在列表回显', list.json.rows.find((x) => x.id === mk1.json.id)?.remark === '客户A回文');
    const pub = await fetch(BASE + '/api/pub/write/' + mk1.json.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '这是外部 agent 的回文 A' })
    });
    ok('H2 外部回文可写入', pub.status === 200);
    const one = await fetch(BASE + '/api/agents/export?ids=' + mk1.json.id + '&token=' + tk);
    const oneText = await one.text();
    const cd = one.headers.get('content-disposition') || '';
    ok('H3 单个导出为 txt，文件名取自备注', /text\/plain/.test(one.headers.get('content-type') || '')
      && /filename\*=UTF-8''/.test(cd) && decodeURIComponent(cd).includes('客户A回文.txt'), cd);
    ok('H4 导出内容含备注与回文正文', oneText.includes('备注：客户A回文') && oneText.includes('这是外部 agent 的回文 A'));

    const mk2 = await req('POST', '/api/agents', { token: tk, body: { days: 7 } });
    await req('PUT', '/api/agents/' + mk2.json.id, { token: tk, body: { remark: '客户B回文' } });
    await fetch(BASE + '/api/pub/write/' + mk2.json.token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '这是外部 agent 的回文 B' })
    });
    const multi = await fetch(BASE + '/api/agents/export?ids=' + mk1.json.id + ',' + mk2.json.id + '&token=' + tk);
    const zipBuf = Buffer.from(await multi.arrayBuffer());
    ok('H5 多选导出为 zip', /application\/zip/.test(multi.headers.get('content-type') || '') && zipBuf.subarray(0, 2).toString() === 'PK');
    const { extractZip } = createRequire(import.meta.url)(path.join(ROOT, 'server', 'services', 'zipService.js'));
    const entries = extractZip(zipBuf).map((e) => e.name);
    ok('H6 zip 内每个链接一个 txt，文件名=备注', entries.includes('客户A回文.txt') && entries.includes('客户B回文.txt'), JSON.stringify(entries));
  }
} finally {
  child.kill();
}

console.log(`\ncheck-server：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
