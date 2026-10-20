#!/usr/bin/env node
// 面具 mask — 批量脱敏全链路自检（v0.4.0）
// 覆盖：中文文件名 / 多文件上传 / 跨文件同码（补种）/ 单文件失败不拦整批 / 预览与下载 /
//       zip 不含明文 / 本人-管理员权限边界 / 会话生成批次 / 删除与历史保留 / 路径穿越
// 红线复述：全部本机处理；脱敏结果里绝不许出现原文敏感值；码文对照只在主人与管理员侧可见。
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractZip } from '../server/services/zipService.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9929;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
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
async function upload(tk, files) {
  const fd = new FormData();
  for (const [name, buf, mime] of files) fd.append('files', new Blob([buf], { type: mime || 'application/octet-stream' }), name);
  const r = await fetch(BASE + '/api/batch', {
    method: 'POST',
    headers: tk ? { Authorization: 'Bearer ' + tk } : {},
    body: fd
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function waitJob(id, tk) {
  for (let i = 0; i < 80; i++) {
    const d = await req('GET', '/api/batch/' + id, { token: tk });
    if (d.json.job && d.json.job.status !== 'running') return d.json;
    await sleep(250);
  }
  return (await req('GET', '/api/batch/' + id, { token: tk })).json;
}
const PHONE = '13812345678', NAME = '张三', NAME2 = '李四';
const codeIn = (text, kind) => (String(text || '').match(new RegExp(`\\[${kind}[^\\]]+\\]`)) || [])[0] || '';

const dataDir = mkdtempSync(path.join(tmpdir(), 'mask-batch-'));
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
  const lo = await req('POST', '/api/auth/login', { body: { username: 'aiadmin', password: 'admin123' } });
  const tk = lo.json.token;
  ok('A0 管理员登录', !!tk);
  await req('POST', '/api/users', { token: tk, body: { username: 'u2', password: 'u123456', role: 'user', display_name: '二号' } });
  const l2 = await req('POST', '/api/auth/login', { body: { username: 'u2', password: 'u123456' } });
  const tk2 = l2.json.token;

  console.log('A. 上传与限额');
  ok('A1 无 token 列表 401', (await req('GET', '/api/batch')).status === 401);
  ok('A2 空上传 400', (await upload(tk, [])).status === 400);
  const f1 = Buffer.from(`参会人员：${NAME}、${NAME2}。\r\n联系电话：${PHONE}\r\n`);
  const f2 = Buffer.from(`${NAME}今天又打了一次 ${PHONE}，${NAME2}没接。\r\n`);
  const f3 = Buffer.from('这其实不是 docx');
  // 故意用一个损坏的 docx（zip 结构坏了）→ 该文件失败、整批照常
  const up1 = await upload(tk, [
    ['会议纪要.txt', f1, 'text/plain'],
    ['跟进记录.txt', f2, 'text/plain'],
    ['损坏文件.docx', f3, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ]);
  ok('A3 三文件建批次 200', up1.status === 200 && up1.json.files?.length === 3, JSON.stringify(up1.json).slice(0, 200));
  const jobId = up1.json?.job?.id;
  ok('A4 中文文件名不乱码', up1.json.files?.[0]?.name === '会议纪要.txt' && up1.json.files?.[1]?.name === '跟进记录.txt',
    JSON.stringify((up1.json.files || []).map((f) => f.name)));
  ok('A5 初始状态 ready 且 total=3', up1.json.job?.status === 'ready' && up1.json.job?.total === 3);
  const big = new Uint8Array(20 * 1024 * 1024 + 1);
  const upBig = await upload(tk, [['超大.txt', big, 'text/plain']]);
  ok('A6 单文件超 20MB 400', upBig.status === 400 && /20MB/.test(upBig.json.error || ''), upBig.json.error);
  const many = Array.from({ length: 51 }, (_, i) => [`f${i}.txt`, Buffer.from('x'), 'text/plain']);
  const upMany = await upload(tk, many);
  ok('A7 超过 50 个文件 400', upMany.status === 400 && /50/.test(upMany.json.error || ''), upMany.json.error);

  console.log('B. 执行与跨文件同码');
  const run1 = await req('POST', `/api/batch/${jobId}/run`, { token: tk, body: {} });
  ok('B1 开始执行 200', run1.status === 200 && run1.json.status === 'running', JSON.stringify(run1.json));
  ok('B2 执行中再点 409', (await req('POST', `/api/batch/${jobId}/run`, { token: tk, body: {} })).status === 409);
  const d1 = await waitJob(jobId, tk);
  ok('B3 整批 done（失败文件不拦整批）', d1.job.status === 'done' && d1.job.ok_count === 2 && d1.job.fail_count === 1,
    `status=${d1.job.status} ok=${d1.job.ok_count} fail=${d1.job.fail_count}`);
  const byName = (n) => (d1.files || []).find((f) => f.name === n) || {};
  ok('B4 文件1 命中 ≥2', byName('会议纪要.txt').match_count >= 2, JSON.stringify(byName('会议纪要.txt')));
  ok('B5 损坏 docx 如实报错', byName('损坏文件.docx').status === 'failed' && /提取|zip|损坏/i.test(byName('损坏文件.docx').error || ''),
    byName('损坏文件.docx').error);
  const v1 = await req('GET', `/api/batch/${jobId}/file/${byName('会议纪要.txt').id}`, { token: tk });
  const v2 = await req('GET', `/api/batch/${jobId}/file/${byName('跟进记录.txt').id}`, { token: tk });
  ok('B6 文件1 原文可看（含手机号）', v1.json.raw?.includes(PHONE));
  ok('B7 文件1 脱敏后无手机号', v1.json.masked && !v1.json.masked.includes(PHONE));
  ok('B8 文件1 脱敏后无姓名', !v1.json.masked.includes(NAME));
  ok('B9 文件2 孤立姓名也脱敏（补种）', v2.json.masked && !v2.json.masked.includes(NAME) && !v2.json.masked.includes(NAME2),
    v2.json.masked);
  ok('B10 跨文件人名同码', codeIn(v1.json.masked, '人名') && codeIn(v1.json.masked, '人名') === codeIn(v2.json.masked, '人名'),
    `${codeIn(v1.json.masked, '人名')} vs ${codeIn(v2.json.masked, '人名')}`);
  ok('B11 跨文件手机号同码', codeIn(v1.json.masked, '手机号') && codeIn(v1.json.masked, '手机号') === codeIn(v2.json.masked, '手机号'),
    `${codeIn(v1.json.masked, '手机号')} vs ${codeIn(v2.json.masked, '手机号')}`);
  ok('B12 对照表 ≥3 项', d1.mapping_count >= 3, `mapping_count=${d1.mapping_count}`);
  ok('B13 详情带进度 processed=3', d1.processed === 3);
  // 还有失败文件时允许重跑：只重跑 pending/failed，成功的文件不动
  const rerun = await req('POST', `/api/batch/${jobId}/run`, { token: tk, body: {} });
  ok('B14 有失败文件时可重跑（200）', rerun.status === 200, `status=${rerun.status}`);
  const dRerun = await waitJob(jobId, tk);
  ok('B15 重跑只补失败文件、成功计数不变', dRerun.job.status === 'done' && dRerun.job.ok_count === 2 && dRerun.job.fail_count === 1,
    `ok=${dRerun.job.ok_count} fail=${dRerun.job.fail_count}`);

  console.log('C. 下载与 zip');
  const dlRaw = await fetch(`${BASE}/api/batch/${jobId}/file/${byName('会议纪要.txt').id}/download?which=raw&token=${tk}`);
  const rawText = await dlRaw.text();
  ok('C1 原文下载含明文', dlRaw.status === 200 && rawText.includes(PHONE) && /\.txt/.test(dlRaw.headers.get('content-disposition') || ''));
  const dlMasked = await fetch(`${BASE}/api/batch/${jobId}/file/${byName('会议纪要.txt').id}/download?which=masked&token=${tk}`);
  const maskedText = await dlMasked.text();
  ok('C2 脱敏下载无明文', dlMasked.status === 200 && !maskedText.includes(PHONE) && maskedText.includes(codeIn(maskedText, '手机号')));
  ok('C3 无 token 下载 401', (await fetch(`${BASE}/api/batch/${jobId}/download`)).status === 401);
  ok('C4 不存在的文件 404', (await req('GET', `/api/batch/${jobId}/file/999999`, { token: tk })).status === 404);
  const zipRes = await fetch(`${BASE}/api/batch/${jobId}/download?token=${tk}`);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  ok('C5 zip 下载 200', zipRes.status === 200 && /zip/.test(zipRes.headers.get('content-type') || '') && zipBuf.length > 100);
  let entries = [];
  try { entries = extractZip(zipBuf); } catch (e) { console.log('  zip 解包失败：' + e.message); }
  const names = entries.map((e) => e.name);
  ok('C6 zip 内两份脱敏文本', names.filter((n) => n.startsWith('masked/') && n.endsWith('.masked.txt')).length === 2, names.join(','));
  const csvEntry = entries.find((e) => e.name === 'mapping.csv');
  ok('C7 mapping.csv 存在且带 BOM', !!csvEntry && csvEntry.data[0] === 0xEF && csvEntry.data[1] === 0xBB && csvEntry.data[2] === 0xBF);
  const errEntry = entries.find((e) => e.name === '_errors.txt');
  ok('C8 _errors.txt 列出失败文件', !!errEntry && errEntry.data.toString('utf8').includes('损坏文件.docx'));
  const zipPlain = entries.filter((e) => e.name.startsWith('masked/')).map((e) => e.data.toString('utf8')).join('\n');
  ok('C9 zip 内脱敏文本无手机号明文', !zipPlain.includes(PHONE));
  ok('C10 zip 内脱敏文本无姓名明文', !zipPlain.includes(NAME));

  console.log('D. 权限（本人 / 管理员）');
  const u2list = await req('GET', '/api/batch', { token: tk2 });
  ok('D1 普通用户列表看不到他人批次', u2list.status === 200 && u2list.json.total === 0, `total=${u2list.json.total}`);
  ok('D2 他人详情 403', (await req('GET', `/api/batch/${jobId}`, { token: tk2 })).status === 403);
  ok('D3 他人文件全文 403', (await req('GET', `/api/batch/${jobId}/file/${byName('会议纪要.txt').id}`, { token: tk2 })).status === 403);
  ok('D4 他人下载 403', (await req('GET', `/api/batch/${jobId}/download`, { token: tk2 })).status === 403);
  ok('D5 他人删除 403', (await req('DELETE', `/api/batch/${jobId}`, { token: tk2 })).status === 403);
  const adminList = await req('GET', '/api/batch', { token: tk });
  const adminRow = (adminList.json.rows || []).find((r) => r.id === jobId);
  ok('D6 管理员列表见全部批次+用户名', adminList.json.total >= 1 && !!adminRow && adminRow.user_id !== undefined && !!adminRow.username,
    JSON.stringify(adminRow).slice(0, 160));
  ok('D7 管理员可看他人批次详情', (await req('GET', `/api/batch/${jobId}`, { token: tk })).status === 200);
  const adminView = await req('GET', `/api/batch/${jobId}/file/${byName('会议纪要.txt').id}`, { token: tk });
  ok('D8 管理员可见全文（含原文）', adminView.json.raw?.includes(PHONE));
  const hist2 = await req('GET', '/api/history?scope=batch', { token: tk2 });
  ok('D9 普通用户历史只见自己（空）', hist2.status === 200 && hist2.json.total === 0, `total=${hist2.json.total}`);
  const histA = await req('GET', '/api/history?scope=batch', { token: tk });
  const histRow = (histA.json.rows || []).find((r) => r.scope === 'batch' && r.ref_id === jobId);
  ok('D10 管理员历史见全部批次记录', histA.status === 200 && !!histRow && histRow.username === 'aiadmin',
    JSON.stringify(histRow || {}).slice(0, 160));

  console.log('E. 从会话生成批次');
  const conv = await req('POST', '/api/conversations', { token: tk2, body: { title: '客户沟通' } });
  const convId = conv.json?.id || conv.json?.conv?.id;
  ok('E1 建会话', !!convId, JSON.stringify(conv.json).slice(0, 120));
  {
    const sdb = new DatabaseSync(path.join(dataDir, 'mask.sqlite'));
    sdb.prepare("INSERT INTO messages (conv_id, role, content) VALUES (?, 'user', ?)").run(convId, `联系人：${NAME}，手机号 ${PHONE}，请跟进。`);
    sdb.prepare("INSERT INTO messages (conv_id, role, content) VALUES (?, 'assistant', '收到。')").run(convId);
    sdb.close();
  }
  const exp = await req('POST', '/api/batch/export', { token: tk2, body: { conversation_ids: [convId] } });
  ok('E2 会话导出建批次 200', exp.status === 200 && exp.json.files?.length === 1, JSON.stringify(exp.json).slice(0, 200));
  const expJob = exp.json?.job?.id;
  ok('E3 导出文件名=会话标题.txt', exp.json.files?.[0]?.name === '客户沟通.txt', exp.json.files?.[0]?.name);
  const expRun = await req('POST', `/api/batch/${expJob}/run`, { token: tk2, body: {} });
  const expDone = await waitJob(expJob, tk2);
  ok('E4 会话批次可执行且命中', expRun.status === 200 && expDone.job?.status === 'done' && (expDone.files?.[0]?.match_count || 0) >= 2,
    `status=${expDone.job?.status} hits=${expDone.files?.[0]?.match_count}`);
  ok('E4b 全部完成后再跑 400', (await req('POST', `/api/batch/${expJob}/run`, { token: tk2, body: {} })).status === 400);
  const expAdmin = await req('POST', '/api/batch/export', { token: tk, body: { conversation_ids: [convId] } });
  ok('E5 管理员不能借导出读他人会话（400）', expAdmin.status === 400, `status=${expAdmin.status}`);
  ok('E6 空选择 400', (await req('POST', '/api/batch/export', { token: tk, body: { conversation_ids: [] } })).status === 400);

  console.log('F. 文件名安全与删除');
  const trav = await upload(tk, [['../../evil.txt', Buffer.from('x'), 'text/plain']]);
  ok('F1 路径穿越名被 basename 化', trav.status === 200 && (trav.json.files?.[0]?.name || '').endsWith('evil.txt') && !(trav.json.files?.[0]?.name || '').includes('..'),
    trav.json.files?.[0]?.name);
  const travId = trav.json?.job?.id;
  if (travId) await req('DELETE', `/api/batch/${travId}`, { token: tk });

  const del = await req('DELETE', `/api/batch/${jobId}`, { token: tk });
  ok('F2 管理员删除他人批次 200', del.status === 200);
  ok('F3 删除后详情 404', (await req('GET', `/api/batch/${jobId}`, { token: tk })).status === 404);
  const batchDisk = path.join(dataDir, 'batches', String(jobId));
  ok('F4 磁盘目录同步删除', !existsSync(batchDisk), batchDisk);
  const histAfter = await req('GET', '/api/history?scope=batch', { token: tk });
  ok('F5 删除批次后历史仍保留', (histAfter.json.rows || []).some((r) => r.scope === 'batch' && r.ref_id === jobId));
} finally {
  child.kill();
}

console.log(`\ncheck-batch：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
