#!/usr/bin/env node
// 面具 mask — 聊天全链路自检：桩 AI 收到的必须只有码文（泄漏断言），流式复原必须与最终文本一致
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9921;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB_PORT = 3989;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 桩 AI：记录收到的请求体，回复按 2 字符一拍流式返回（逼出半码问题）----
let stubBodies = [];
const stub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', async () => {
    let body = null;
    try { body = JSON.parse(buf); } catch { /* 忽略 */ }
    stubBodies.push(body);
    const userText = body?.messages?.filter((m) => m.role === 'user').pop()?.content || '';
    const reply = `好的，已收到关于${userText}的说明，我们会妥善处理并保密。`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < reply.length; i += 2) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(i, i + 2) } }] })}\n\n`);
      await sleep(4);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

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

async function chat(token, payload) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload)
  });
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
  return { status: r.status, events };
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-chat-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, MASK_NO_SIDECAR: '1', MASK_DATA_DIR: dataDir, PORT: String(PORT), MASK_GEO: 'off' },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

await new Promise((r) => stub.listen(STUB_PORT, r));
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await sleep(250);
  try { up = (await fetch(BASE + '/api/health')).ok; } catch { /* 未起 */ }
}
if (!up) { console.error('服务未能在 10s 内启动'); child.kill(); stub.close(); process.exit(1); }

try {
  const lo = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'admin123' } });
  const tk = lo.json.token;
  await req('POST', '/api/settings/ai-config', { token: tk, body: { model: 'stub-1', base_url: `http://127.0.0.1:${STUB_PORT}/v1`, api_key: 'sk-stub' } });

  const TEXT1 = '客户是杭州云梯智造有限公司，联系手机 13812345678，报价 45万元，请帮我拟一段跟进话术。';
  console.log('A. 第一轮：脱敏发送 + 流式复原');
  const r1 = await chat(tk, { messages: [{ role: 'user', content: TEXT1 }], desensitize: true, with_rules: true });
  const stub1 = stubBodies.at(-1);
  ok('A1 桩 AI 未收到手机号明文', !JSON.stringify(stub1).includes('13812345678'));
  ok('A2 桩 AI 未收到公司名明文', !JSON.stringify(stub1).includes('云梯'));
  ok('A3 桩 AI 未收到金额明文', !JSON.stringify(stub1).includes('45万元'));
  ok('A4 上行带占位码保留指令', stub1?.messages?.[0]?.role === 'system' && stub1.messages[0].content.includes('占位符'));
  ok('A5 with_rules 附规则摘要', stub1.messages[0].content.includes('当前脱敏规则'));
  const start1 = r1.events.find((e) => e.type === 'start');
  ok('A6 start 事件含对照表', start1?.masked === true && start1.mapping.length >= 3);
  const codeOf = (ev, term) => ev.mapping.find((m) => m.term === term)?.code;
  const phoneCode = codeOf(start1, '13812345678');
  const orgCode = codeOf(start1, '杭州云梯智造有限公司');
  ok('A7 混合语义码风格', /^[一-龥]{2,5}[0-9A-Z]{2}$/.test(phoneCode || '') || (phoneCode || '').startsWith('手机'));
  ok('A8 桩 AI 收到的是码', JSON.stringify(stub1).includes(phoneCode) && JSON.stringify(stub1).includes(orgCode));

  const deltas = r1.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  const done1 = r1.events.find((e) => e.type === 'done');
  ok('A9 流式增量拼接 == 最终文本（半码不外泄/不丢失）', deltas === done1?.content, `len ${deltas.length} vs ${done1?.content?.length}`);
  ok('A10 回复已复原手机号', done1?.content.includes('13812345678'));
  ok('A11 回复已复原公司名', done1?.content.includes('杭州云梯智造有限公司'));
  ok('A12 复核结论完整', done1?.review?.verdict === 'complete');
  ok('A13 start 带本轮识别引擎', start1?.engine === '内置规则引擎', String(start1?.engine));
  const opts = await req('GET', '/api/engines/options', { token: tk });
  const optIds = (opts.json.options || []).map((o) => o.id);
  ok('A14 对话页引擎下拉含内置与外部文本引擎、不含工具类',
    opts.status === 200 && optIds[0] === 'builtin' && optIds.includes('presidio') && !optIds.includes('cloakdb'),
    `${opts.status} ${optIds.join(',')}`);
  const convId = done1?.conv_id;

  console.log('B. 第二轮：同会话同码 + 持久化');
  const r2 = await chat(tk, {
    conv_id: convId,
    messages: [
      { role: 'user', content: TEXT1 },
      { role: 'assistant', content: done1.content },
      { role: 'user', content: '对方手机还是 13812345678，再强调一下公司主体。' }
    ],
    desensitize: true
  });
  const stub2 = stubBodies.at(-1);
  const start2 = r2.events.find((e) => e.type === 'start');
  ok('B1 同会话手机号同码', codeOf(start2, '13812345678') === phoneCode);
  ok('B2 历史消息（assistant 复述）也被重新脱敏', !JSON.stringify(stub2).includes('13812345678'));
  ok('B3 桩 AI 请求里出现旧码', JSON.stringify(stub2).includes(phoneCode));
  const done2 = r2.events.find((e) => e.type === 'done');
  const deltas2 = r2.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  ok('B4 第二轮增量拼接仍一致', deltas2 === done2?.content);
  // 界面「本轮对照关系」只能看到本轮消息里的实体，历史轮次不重复列出（v1.00）
  ok('B5 start 对照表只含本轮实体', start2?.mapping?.some((m) => m.term === '13812345678')
    && !start2.mapping.some((m) => m.term === '杭州云梯智造有限公司' || m.term === '45万元'),
    JSON.stringify((start2?.mapping || []).map((m) => m.term)));
  ok('B6 复核「未出现」不含历史实体', !(done2?.review?.unused || []).includes('杭州云梯智造有限公司'),
    JSON.stringify(done2?.review?.unused || []));

  console.log('C. 持久化与历史');
  const convs = await req('GET', '/api/conversations', { token: tk });
  ok('C1 会话已保存', convs.json.list.length === 1);
  const msgs = await req('GET', `/api/conversations/${convId}/messages`, { token: tk });
  const userRows = msgs.json.messages.filter((m) => m.role === 'user');
  ok('C2 用户原文落库（本机）', userRows[0]?.content.includes('13812345678'));
  ok('C3 脱敏版另存 masked_content', (userRows[0]?.masked_content || '').includes(phoneCode));
  const aiRows = msgs.json.messages.filter((m) => m.role === 'assistant');
  ok('C4 助手回复落库为复原文本', aiRows[0]?.content.includes('13812345678'));
  const hist = await req('GET', '/api/history?scope=chat', { token: tk });
  ok('C5 对话脱敏入历史（2 条）', hist.json.total === 2);
  const hd = await req('GET', `/api/history/${hist.json.rows[0].id}`, { token: tk });
  ok('C6 历史含对照快照', hd.json.mapping.some((m) => m.term === '13812345678'));

  console.log('D. 关闭脱敏的一轮（明文直通，如实不装）');
  const r4 = await chat(tk, { conv_id: convId, messages: [{ role: 'user', content: '这次不脱敏，手机 13999999999 直接发。' }], desensitize: false });
  const stub4 = stubBodies.at(-1);
  const start4 = r4.events.find((e) => e.type === 'start');
  ok('D1 明文原样到达桩 AI', JSON.stringify(stub4).includes('13999999999'));
  ok('D2 不注入占位码指令', !(stub4?.messages?.[0]?.role === 'system'));
  ok('D3 start 如实标记未脱敏', start4?.skipped === true && start4.mapping.length === 0);
  ok('D4 无增量解码变形', r4.events.filter((e) => e.type === 'delta').map((e) => e.text).join('') === r4.events.find((e) => e.type === 'done')?.content);

  console.log('E. 对话页自选引擎（本轮覆盖全局）');
  const r5 = await chat(tk, { conv_id: convId, messages: [{ role: 'user', content: '再核对一下手机 13812345678。' }], desensitize: true, engine: 'builtin' });
  const start5 = r5.events.find((e) => e.type === 'start');
  const done5 = r5.events.find((e) => e.type === 'done');
  ok('E1 选内置引擎时如实标注「本页所选」', start5?.masked === true && start5?.engine === '内置规则引擎（本页所选）', String(start5?.engine));
  ok('E2 自选引擎仍然脱敏并复原', !!start5?.mapping?.length && (done5?.content || '').includes('13812345678'));
  const r6 = await chat(tk, { conv_id: convId, messages: [{ role: 'user', content: '这条用默认配置。' }], desensitize: true, engine: 'no-such-engine' });
  const start6 = r6.events.find((e) => e.type === 'start');
  ok('E3 未知引擎 id 回落到全局配置', start6?.engine === '内置规则引擎', String(start6?.engine));
} finally {
  child.kill();
  stub.close();
}

console.log(`\ncheck-chat：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
