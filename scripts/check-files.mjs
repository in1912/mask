#!/usr/bin/env node
// 面具 mask — 文件脱敏全链路自检：四种格式提取 / 文档级同码 / AI 往返泄漏断言 / 下载 / 分享回文 / Agent 只写 / 权限隔离
// 红线复述：分享页只许出现码文；匿名回文者永远拿不回原文；回文解码只发生在主人侧
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9923;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB_PORT = 3991;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 桩 AI：记录请求体；回文里原样回带收到的占位码 ----
let stubBodies = [];
const stub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(buf); } catch { /* 忽略 */ }
    stubBodies.push(body);
    const userText = body?.messages?.filter((m) => m.role === 'user').pop()?.content || '';
    const codes = [...userText.matchAll(/\[[^\]\n]{1,24}\]|\b[A-Z]{2,4}-[0-9A-Z]{4,6}\b/g)].map((m) => m[0]);
    const reply = `已核对：${codes.join('；')||'（无码）'}，处理完毕。`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'stub-1', usage: { total_tokens: 10 }, choices: [{ message: { content: reply } }] }));
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
async function uploadDoc(tk, name, buf, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), name);
  const r = await fetch(BASE + '/api/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: fd });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function page(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, text: await r.text() };
}

// ---- 手工 zip（stored）----
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zipStore(files) {
  const chunks = [], central = []; let off = 0;
  for (const [name, str] of files) {
    const data = Buffer.from(str, 'utf8'), nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    chunks.push(lh, nb, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(off, 42);
    central.push(cd, nb);
    off += 30 + nb.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---- 手工 PDF（未压缩流 + 1 字节 ToUnicode CMap）----
function pdfBuild() {
  const chars = { 0x41: '676D', 0x42: '5DDE', 0x43: '4E91', 0x44: '68AF', 0x45: '667A', 0x46: '9020', 0x47: '6709', 0x48: '9650', 0x49: '516C', 0x4A: '53F8', 0x4B: '624B', 0x4C: '673A', 0x4D: '0031', 0x4E: '0033', 0x4F: '0038', 0x50: '0031', 0x51: '0032', 0x52: '0033', 0x53: '0034', 0x54: '0035', 0x55: '0036', 0x56: '0037', 0x57: '0038' };
  const bf = Object.entries(chars).map(([k, v]) => `<${Number(k).toString(16).toUpperCase()}> <${v}>`).join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
${Object.keys(chars).length} beginbfchar
${bf}
endbfchar
endcmap
end
end`;
  const content = `BT /TT0 12 Tf 72 720 Td <4142434445464748494A> Tj 0 -18 Td <4B4C4D4E4F5051525354555657> Tj ET`;
  const objs = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /TT0 4 0 R >> >> /Contents 5 0 R >>\nendobj`,
    `4 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /Test /ToUnicode 6 0 R >>\nendobj`,
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
    `6 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj`,
  ];
  return Buffer.from('%PDF-1.4\n' + objs.join('\n') + '\n%%EOF\n', 'latin1');
}

const PHONE = '13812345678', ORG = '杭州云梯智造有限公司';
const RAW = `甲方：${ORG}\n联系手机：${PHONE}，报价 45万元整。\n请尽快确认。`;

const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-files-'));
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

  console.log('A. 上传与提取（txt/docx/xlsx/pdf + 拒收）');
  const a1 = await uploadDoc(tk, '合同说明.txt', Buffer.from(RAW), 'text/plain');
  ok('A1 txt 提取', a1.status === 200 && a1.json.engine === 'plain' && a1.json.text.includes(PHONE), JSON.stringify(a1.json).slice(0, 120));
  const docId = a1.json.id;
  const a2 = await uploadDoc(tk, '旧版.doc', Buffer.from('x'), 'application/msword');
  ok('A2 老格式如实拒收并指路', a2.status === 400 && /另存/.test(a2.json.error || ''), a2.json.error);
  const a3 = await uploadDoc(tk, '图.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  ok('A3 图片拒收（明文风险）', a3.status === 400 && /图片/.test(a3.json.error || ''), a3.json.error);
  const docx = zipStore([['word/document.xml', `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>甲方：${ORG}</w:t></w:r></w:p><w:p><w:r><w:t>联系手机：${PHONE}</w:t></w:r></w:p></w:body></w:document>`]]);
  const a4 = await uploadDoc(tk, '合同.docx', docx);
  ok('A4 docx 提取（共享正文段）', a4.status === 200 && a4.json.engine === 'docx' && a4.json.text.includes(ORG) && a4.json.text.includes(PHONE), JSON.stringify(a4.json).slice(0, 120));
  const xlsx = zipStore([
    ['xl/sharedStrings.xml', `<sst><si><t>公司</t></si><si><t>${ORG}</t></si><si><t>手机</t></si><si><t>${PHONE}</t></si></sst>`],
    ['xl/worksheets/sheet1.xml', `<sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="s"><v>2</v></c><c t="s"><v>3</v></c></row></sheetData>`],
  ]);
  const a5 = await uploadDoc(tk, '客户表.xlsx', xlsx);
  ok('A5 xlsx 提取（共享字符串）', a5.status === 200 && a5.json.engine === 'xlsx' && a5.json.text.includes(PHONE), JSON.stringify(a5.json).slice(0, 120));
  const a6 = await uploadDoc(tk, '扫描说明.pdf', pdfBuild());
  ok('A6 pdf 提取（1 字节 CMap）', a6.status === 200 && a6.json.engine === 'pdf' && a6.json.text.includes(ORG) && a6.json.text.includes(PHONE), JSON.stringify(a6.json).slice(0, 120));
  const a7 = await req('GET', '/api/documents', { token: tk });
  ok('A7 列表默认 5 条/页', a7.json.size === 5 && a7.json.total === 4, `size=${a7.json.size} total=${a7.json.total}`);

  console.log('B. 文档级脱敏（同实体同码，重复执行不换码）');
  const b1 = await req('POST', `/api/documents/${docId}/mask`, { token: tk, body: {} });
  ok('B1 脱敏计数 ≥2', b1.status === 200 && b1.json.count >= 2, `status=${b1.status} ${JSON.stringify(b1.json).slice(0, 160)}`);
  const codeOf = (out, term) => (out.mapping || []).find((m) => m.term === term)?.code;
  const phoneCode = codeOf(b1.json, PHONE), orgCode = codeOf(b1.json, ORG);
  ok('B2 码文无手机号明文', b1.json.masked && !b1.json.masked.includes(PHONE));
  ok('B3 码文无公司名明文', b1.json.masked && !b1.json.masked.includes('云梯'));
  ok('B4 拿到手机/公司占位码', !!phoneCode && !!orgCode, `${phoneCode} ${orgCode}`);
  const b2 = await req('POST', `/api/documents/${docId}/mask`, { token: tk, body: {} });
  ok('B5 重跑同码', codeOf(b2.json, PHONE) === phoneCode && codeOf(b2.json, ORG) === orgCode);
  const det = await req('GET', `/api/documents/${docId}`, { token: tk });
  ok('B6 详情三栏数据齐', det.status === 200 && det.json.masked_text.includes(phoneCode) && det.json.mapping.length >= 2 && Array.isArray(det.json.doc.meta_report) && det.json.doc.meta_report.length >= 2);
  const hist = await req('GET', '/api/history?scope=file', { token: tk });
  ok('B7 脱敏入历史 scope=file', hist.json.total >= 2, `total=${hist.json.total}`);
  const b8 = await req('GET', '/api/engines/options', { token: tk });
  const optIds = (b8.json.options || []).map((o) => o.id);
  ok('B8 文件页引擎下拉含内置与外部文本引擎、不含工具类',
    b8.status === 200 && optIds[0] === 'builtin' && optIds.includes('presidio') && !optIds.includes('cloakdb') && !(b8.json.options || []).some((o) => o.kind === 'tool'),
    `status=${b8.status} ${optIds.join(',')}`);
  const b9 = await req('POST', `/api/documents/${docId}/mask`, { token: tk, body: { engine: 'builtin' } });
  const det9 = await req('GET', `/api/documents/${docId}`, { token: tk });
  ok('B9 选内置引擎脱敏并落库', b9.status === 200 && det9.json.doc.mask_engine === 'builtin' && codeOf(b9.json, PHONE) === phoneCode);
  const b10 = await req('POST', `/api/documents/${docId}/mask`, { token: tk, body: { engine: 'no-such-engine' } });
  const det10 = await req('GET', `/api/documents/${docId}`, { token: tk });
  ok('B10 未知引擎回落到跟随全局（不落非法值）', b10.status === 200 && det10.json.doc.mask_engine === '');
  // B11：mappings 是持久底账，换引擎/改规则后旧条目仍躺在库里。详情只许回「原文里有、且当前脱敏文里已经不存在」的词。
  {
    const mdb = new DatabaseSync(path.join(dataDir, 'mask.sqlite'));
    const ins = mdb.prepare("INSERT OR IGNORE INTO mappings (scope_type, scope_id, code, rule_key, category, style, term) VALUES ('doc', ?, ?, ?, ?, 'A', ?)");
    ins.run(docId, '[人名ZZ]', 'person', 'pii', '请尽快');   // 原文有、脱敏后原样保留 → 不该出现在对照表
    ins.run(docId, '[人名ZY]', 'person', 'pii', '万店掌系'); // 旧引擎留下的碎片，当前原文里根本没有 → 不该出现
    mdb.close();
    const det11 = await req('GET', `/api/documents/${docId}`, { token: tk });
    const terms11 = (det11.json.mapping || []).map((m) => m.term);
    ok('B11 详情对照表滤掉陈旧映射条目',
      det11.status === 200 && !terms11.includes('请尽快') && !terms11.includes('万店掌系') && terms11.includes(PHONE) && terms11.includes(ORG),
      JSON.stringify(terms11));
  }

  console.log('C. 外部 AI 往返（桩 AI 收到的只能有码文）');
  const c1 = await req('POST', `/api/documents/${docId}/ai`, { token: tk, body: { instruction: '请总结要点。' } });
  const stubDoc = stubBodies.at(-1);
  ok('C1 桩 AI 未收到手机号明文', c1.status === 200 && !JSON.stringify(stubDoc).includes(PHONE), JSON.stringify(c1.json).slice(0, 160));
  ok('C2 桩 AI 未收到公司名明文', !JSON.stringify(stubDoc).includes('云梯'));
  ok('C3 桩 AI 收到的是码', JSON.stringify(stubDoc).includes(phoneCode) && JSON.stringify(stubDoc).includes(orgCode));
  ok('C4 回文已复原手机号', c1.json.restored.includes(PHONE));
  ok('C5 回文已复原公司名', c1.json.restored.includes(ORG));
  ok('C6 复核结论完整', c1.json.review?.verdict === 'complete', JSON.stringify(c1.json.review));
  const det2 = await req('GET', `/api/documents/${docId}`, { token: tk });
  ok('C7 回文落库 source=internal', det2.json.replies[0]?.source === 'internal' && det2.json.replies[0]?.restored_text.includes(PHONE));

  console.log('D. 下载（token 即凭证）');
  const dl = async (which) => {
    const r = await fetch(`${BASE}/api/documents/${docId}/download?which=${which}&token=${tk}`);
    return { status: r.status, cd: r.headers.get('content-disposition') || '', text: await r.text() };
  };
  const d1 = await dl('raw');
  ok('D1 原文下载', d1.status === 200 && d1.text.includes(PHONE) && /\.txt/.test(d1.cd), `status=${d1.status} cd=${d1.cd}`);
  const d2 = await dl('masked');
  ok('D2 脱敏下载（无明文）', d2.status === 200 && !d2.text.includes(PHONE) && d2.text.includes(phoneCode));
  const d3 = await dl('restored');
  ok('D3 回文下载（已复原）', d3.status === 200 && d3.text.includes(PHONE));
  const d4 = await fetch(`${BASE}/api/documents/${docId}/download?which=raw`);
  ok('D4 无 token 拒收', d4.status === 401);

  console.log('E. 分享与回文（1/7 天，绝无永久）');
  const e0 = await req('POST', `/api/documents/${docId}/share`, { token: tk, body: { days: 30 } });
  ok('E0 永久天数被压回 1 天', e0.json.days === 1, JSON.stringify(e0.json).slice(0, 100));
  const e1 = await req('POST', `/api/documents/${docId}/share`, { token: tk, body: { days: 1 } });
  const sTok = e1.json.token, sPair = e1.json.pair_token;
  ok('E1 成对生成分享/回文令牌', e1.status === 200 && !!sTok && !!sPair && sTok !== sPair && (e1.json.guide || '').includes('占位'));
  const p1 = await page('/s/' + sTok);
  ok('E2 分享页只含码文', p1.status === 200 && p1.text.includes(phoneCode) && !p1.text.includes(PHONE) && !p1.text.includes('云梯'));
  ok('E3 分享页含引导语与回文地址', p1.text.includes('占位码') && p1.text.includes(sPair));
  const p2 = await page('/s/' + sPair);
  ok('E4 回文页不露码文正文', p2.status === 200 && !p2.text.includes(phoneCode) && p2.text.includes('回文'));
  const w0 = await req('POST', `/api/pub/write/${sPair}`, { body: { content: '' } });
  ok('E5 空内容 400', w0.status === 400);
  const w0b = await req('POST', `/api/pub/write/${sPair}`, { body: { content: 'x'.repeat(2 * 1024 * 1024 + 10) } });
  ok('E6 超 2MB 400', w0b.status === 400);
  const w0c = await req('POST', `/api/pub/write/${sTok}`, { body: { content: '写给主 token' } });
  ok('E7 主 token 不收回文', w0c.status === 400 && /分享页地址/.test(w0c.json.error || ''));
  const reply1 = `关于[${orgCode}]的说明：联系人手机 [${phoneCode}]，确认无误。`; // 码在文本里是带括号形态（style A）
  const w1 = await req('POST', `/api/pub/write/${sPair}`, { body: { content: reply1 } });
  ok('E8 回文写入 200（匿名）', w1.status === 200 && w1.json.word_count > 0);
  const w2 = await req('POST', `/api/pub/write/${sPair}`, { body: { content: reply1 } });
  ok('E9 同内容 10s 内去重 409', w2.status === 409);
  ok('E9b 匿名方拿不到复原结果', !JSON.stringify(w1.json).includes(PHONE));
  const det3 = await req('GET', `/api/documents/${docId}`, { token: tk });
  ok('E10 主人侧回文已复原', det3.json.replies[0]?.source === 'share' && det3.json.replies[0]?.restored_text.includes(PHONE) && det3.json.replies[0]?.restored_text.includes(ORG), JSON.stringify(det3.json.replies?.[0]).slice(0, 400));
  // 强制过期（直改临时库）
  const sdb = new DatabaseSync(path.join(dataDir, 'mask.sqlite'));
  sdb.prepare('UPDATE links SET expires_at = ? WHERE token = ?').run('2000-01-01 00:00:00', sTok);
  sdb.close();
  const p3 = await page('/s/' + sTok);
  ok('E11 过期页如实展示', p3.text.includes('过期'));
  const w3 = await req('POST', `/api/pub/write/${sPair}`, { body: { content: '过期后写入' } });
  ok('E11b 过期写回 410', w3.status === 410);
  // 撤销
  const e2 = await req('POST', `/api/documents/${docId}/share`, { token: tk, body: { days: 7 } });
  const s2Tok = e2.json.token, s2Pair = e2.json.pair_token;
  ok('E12 7 天档可用', e2.json.days === 7);
  const rv = await req('DELETE', `/api/shares/${s2Tok}`, { token: tk });
  ok('E12b 撤销成功', rv.status === 200);
  const p4 = await page('/s/' + s2Tok);
  ok('E12c 撤销页如实展示', p4.text.includes('撤销'));
  const w4 = await req('POST', `/api/pub/write/${s2Pair}`, { body: { content: '撤销后写入' } });
  ok('E12d 撤销写回 410', w4.status === 410);
  const p5 = await page('/s/' + 'f'.repeat(24));
  ok('E13 不存在的令牌给 404 体面页', p5.status === 404 && p5.text.includes('不存在'));

  console.log('F. Agent 只写通道（默认永久）');
  const f1 = await req('POST', '/api/agents', { token: tk, body: { days: 0 } });
  ok('F1 默认永久', f1.status === 200 && f1.json.days === 0 && f1.json.expires_at == null, JSON.stringify(f1.json).slice(0, 100));
  const agTok = f1.json.token, agId = f1.json.id;
  const p6 = await page('/s/' + agTok);
  ok('F2 Agent 页只有引导语+回文框', p6.status === 200 && p6.text.includes('Agent 回文通道') && !p6.text.includes(PHONE));
  ok('F2b Agent 引导语不再要求「不要粘贴敏感信息」', !p6.text.includes('请注意不要在这里粘贴任何未脱敏的敏感信息'));
  const mdText = `**结论**\n- 项目可行\n- 请补充 ${orgCode} 的资料`;
  const f3 = await req('POST', `/api/pub/write/${agTok}`, { body: { content: mdText } });
  ok('F3 Agent 回文写入 200', f3.status === 200);
  const f4 = await req('GET', '/api/agents', { token: tk });
  const agRow = f4.json.rows.find((x) => x.id === agId);
  ok('F4 列表计数与最近回文', f4.json.total >= 1 && agRow?.writes === 1 && !!agRow?.last_write);
  const f5 = await req('GET', `/api/agents/${agId}/writes`, { token: tk });
  ok('F5 摘要列表', f5.json.rows[0]?.excerpt.includes('结论'));
  const f6 = await req('GET', `/api/agents/writes/${f5.json.rows[0].id}`, { token: tk });
  ok('F6 全文原样保存（Markdown 不吃掉）', f6.json.content === mdText);
  const f7 = await req('POST', '/api/agents', { token: tk, body: { days: 7 } });
  ok('F7 7 天档', f7.json.days === 7 && !!f7.json.expires_at);
  const f8 = await req('DELETE', `/api/agents/${agId}`, { token: tk });
  ok('F8 删除链接连带回文', f8.status === 200);
  const p7 = await page('/s/' + agTok);
  const w5 = await req('POST', `/api/pub/write/${agTok}`, { body: { content: '删除后写入' } });
  ok('F8b 删除后令牌即刻失效', p7.status === 404 && w5.status === 404);

  console.log('G. 权限隔离（普通用户看不见他人文档与链接）');
  await req('POST', '/api/users', { token: tk, body: { username: 'u2', password: 'u123456', role: 'user', display_name: '二号' } });
  const l2 = await req('POST', '/api/auth/login', { body: { username: 'u2', password: 'u123456' } });
  const tk2 = l2.json.token;
  const g1 = await req('GET', `/api/documents/${docId}`, { token: tk2 });
  ok('G1 他人文档详情 403', g1.status === 403);
  const g2 = await req('DELETE', `/api/documents/${docId}`, { token: tk2 });
  ok('G2 他人文档删除 403', g2.status === 403);
  const g3 = await req('GET', '/api/documents', { token: tk2 });
  ok('G3 列表只见自己（空）', g3.json.total === 0);
  const f4b = await req('GET', '/api/agents', { token: tk2 });
  ok('G4 Agent 链接按人隔离', f4b.json.total === 0);
  const f5b = await req('GET', `/api/agents/writes/${f5.json.rows[0] ? f5.json.rows[0].id : 0}`, { token: tk2 });
  ok('G5 他人回文全文 403/404', f5b.status === 403 || f5b.status === 404, `status=${f5b.status}`);

  console.log('H. 删除文档连带清理');
  const h1 = await req('DELETE', `/api/documents/${docId}`, { token: tk });
  const h1b = await req('GET', `/api/documents/${docId}`, { token: tk });
  const p8 = await page('/s/' + sTok);
  ok('H1 文档删除后链接同灭', h1.status === 200 && h1b.status === 404 && p8.status === 404);
} finally {
  child.kill();
  stub.close();
}

console.log(`\ncheck-files：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
