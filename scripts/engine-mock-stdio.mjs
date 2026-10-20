#!/usr/bin/env node
// stdio 引擎包装**示例**（也是自检脚本用的 mock）：读 stdin 全文 → stdout 出实体 JSON。
// 给 godlp / sensitive-word 写真包装时照这个骨架来：把「识别」换成调真引擎，
// 把结果转成 {term,start,end,type}（坐标拿不准就给 0/1——主进程会按 term 内容重定位）。
// 诊断信息一律走 stderr，stdout 只许有 JSON。
import { createInterface } from 'node:readline';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf-8');
  const entities = [];
  // 手机号
  for (const m of text.matchAll(/1[3-9]\d{9}/g)) entities.push({ term: m[0], start: m.index, end: m.index + m[0].length, type: 'PHONE' });
  // 邮箱
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) entities.push({ term: m[0], start: m.index, end: m.index + m[0].length, type: 'EMAIL' });
  // 一个内置规则没有的类型（走 EXT 码），自检断言用
  for (const m of text.matchAll(/门禁卡[0-9]{6,}/g)) entities.push({ term: m[0], start: m.index, end: m.index + m[0].length, type: 'BADGE_ID' });
  process.stderr.write(`[mock] ${text.length} chars -> ${entities.length} entities\n`);
  process.stdout.write(JSON.stringify({ entities }));
  process.stdout.write('\n');
});
