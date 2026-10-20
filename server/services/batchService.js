'use strict';
// 批量脱敏（v0.4.0）：多文件/会话 → 异步任务 → 整批共用一张对照表 → 打包下载。
// 约束：全部本机处理；单文件失败不拦整批；绝不把未脱敏文本当结果落盘。
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('../db');
const { extractText, MAX_CHARS } = require('../extract');
const engines = require('../engines');
const { loadCfg } = require('../routes/maskRoutes')();
const { buildZip } = require('./zipService');

const MAX_FILES = 50;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
const BATCH_DIR = path.join(DATA_DIR, 'batches');
const RUNNING = new Set(); // 进程内运行中的 job id

const RULE_ZH_SRC = require('../engine').RULES;
const RULE_ZH = Object.fromEntries(RULE_ZH_SRC.map((r) => [r.key, r.zh]));

function batchDir(id) { return path.join(BATCH_DIR, String(id)); }
function inPath(id, fid) { return path.join(batchDir(id), 'in', String(fid)); }
function rawTxtPath(id, fid) { return path.join(batchDir(id), 'txt', String(fid) + '.raw.txt'); }
function outTxtPath(id, fid) { return path.join(batchDir(id), 'out', String(fid) + '.masked.txt'); }
function mkdirs(id) {
  for (const d of ['in', 'txt', 'out']) fs.mkdirSync(path.join(batchDir(id), d), { recursive: true });
}
function rmDir(id) { try { fs.rmSync(batchDir(id), { recursive: true, force: true }); } catch { /* 已删 */ } }

// 进程重启：running 任务没有执行者了，如实标失败（不能让用户以为还在跑）
db.prepare(`UPDATE batch_jobs SET status='failed', error='服务重启，任务中断', finished_at=datetime('now','localtime')
  WHERE status='running'`).run();

function sanitizeBase(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\r\n\t\0]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
}

function createJob(userId, mode = 'text', options = {}) {
  const info = db.prepare('INSERT INTO batch_jobs (user_id, mode, status, options_json) VALUES (?, ?, ?, ?)')
    .run(userId, mode === 'table' ? 'table' : 'text', 'ready', JSON.stringify(options || {}));
  return Number(info.lastInsertRowid);
}

function addFile(jobId, { name, ext, size, srcPath, buf }) {
  const info = db.prepare('INSERT INTO batch_files (batch_id, name, ext, size, status) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, String(name).slice(0, 160), String(ext || '').toLowerCase(), Number(size) || 0, 'pending');
  const fid = Number(info.lastInsertRowid);
  mkdirs(jobId);
  if (srcPath) fs.renameSync(srcPath, inPath(jobId, fid));
  else fs.writeFileSync(inPath(jobId, fid), buf || Buffer.alloc(0));
  db.prepare('UPDATE batch_jobs SET total = total + 1 WHERE id = ?').run(jobId);
  return fid;
}

function jobCounts(id) {
  const r = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS ok,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS fail
    FROM batch_files WHERE batch_id = ?`).get(id);
  return { total: r.total || 0, ok: r.ok || 0, fail: r.fail || 0 };
}

function loadBatchMap(jobId) {
  const map = new Map();
  for (const row of db.prepare("SELECT * FROM mappings WHERE scope_type = 'batch' AND scope_id = ?").all(jobId)) {
    map.set(row.term, { term: row.term, code: row.code, key: row.rule_key, cat: row.category, style: row.style || 'A' });
  }
  return map;
}

// 执行任务（不 await：调用方立即返回 202；进度靠轮询）
function startJob(jobId) {
  if (RUNNING.has(jobId)) throw new Error('这个批次正在执行');
  const job = db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error('批次不存在');
  const busy = db.prepare("SELECT id FROM batch_jobs WHERE user_id = ? AND status = 'running' AND id <> ?").get(job.user_id, jobId);
  if (busy) throw new Error('你还有批次正在执行，等它跑完再开新的');
  db.prepare("UPDATE batch_jobs SET status='running', error='', finished_at=NULL WHERE id = ?").run(jobId);
  RUNNING.add(jobId);
  processJob(jobId).catch((e) => {
    db.prepare("UPDATE batch_jobs SET status='failed', error=?, finished_at=datetime('now','localtime') WHERE id = ?")
      .run(String(e.message || e).slice(0, 300), jobId);
  }).finally(() => RUNNING.delete(jobId));
}

// 前几个文件确认过的实体 → 当前文件的候选。跨文件同码的前提是「先认出来」：
// 第二份文件里孤立出现的「张三」没有上下文锚点，内置规则根本不认识，只能靠批次对照补。
function seedCandidates(text, map) {
  const out = [];
  for (const e of map.values()) {
    if (!e || typeof e.term !== 'string' || e.term.length < 2) continue;
    const ascii = /^[A-Za-z0-9@._+-]+$/.test(e.term);
    let from = 0;
    let idx;
    while ((idx = text.indexOf(e.term, from)) !== -1) {
      const before = text[idx - 1] || '';
      const after = text[idx + e.term.length] || '';
      // ASCII 实体（邮箱/手机/卡号）别在更长的同类串里咬一半
      if (ascii && (/[A-Za-z0-9@._+-]/.test(before) || /[A-Za-z0-9@._+-]/.test(after))) {
        from = idx + 1;
        continue;
      }
      out.push({ term: e.term, start: idx, end: idx + e.term.length, key: e.key || 'ext', prio: 60, seeded: true });
      from = idx + Math.max(1, e.term.length);
    }
  }
  return out;
}

async function processJob(jobId) {
  const job = db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(jobId);
  const cfg = loadCfg(job.user_id); // 跟随批次所有者的规则配置（管理员代跑也按所有者）
  const map = loadBatchMap(jobId);
  const files = db.prepare("SELECT * FROM batch_files WHERE batch_id = ? AND status IN ('pending','failed') ORDER BY id").all(jobId);
  for (const f of files) {
    db.prepare("UPDATE batch_files SET status='running', error='' WHERE id = ?").run(f.id);
    try {
      const buf = fs.readFileSync(inPath(jobId, f.id));
      const ex = extractText(f.name, buf, '');
      if (ex.error) throw new Error(ex.error);
      const text = ex.text || '';
      fs.writeFileSync(rawTxtPath(jobId, f.id), text, 'utf8');
      const out = await engines.runMask(text, cfg, map, seedCandidates(text, map));
      if (out.skipped) throw new Error('未脱敏：' + (out.reason || '脱敏总开关关闭'));
      fs.writeFileSync(outTxtPath(jobId, f.id), out.masked, 'utf8');
      // 对照落库：同一批次重跑码不变
      const up = db.prepare("INSERT OR IGNORE INTO mappings (scope_type, scope_id, code, rule_key, category, style, term) VALUES ('batch', ?, ?, ?, ?, ?, ?)");
      for (const e of map.values()) up.run(jobId, e.code, e.key, e.cat || null, e.style || 'A', e.term);
      const note = text.length >= MAX_CHARS ? `\n[注意] 原文超过 ${MAX_CHARS} 字符，已按上限截断` : '';
      db.prepare(`UPDATE batch_files SET status='done', chars=?, match_count=?, preview_raw=?, preview_masked=?, out_name=? WHERE id = ?`)
        .run(text.length, out.count || 0, (text + note).slice(0, 4000), out.masked.slice(0, 4000), sanitizeBase(f.name) + '.masked.txt', f.id);
      db.prepare('INSERT INTO desens_history (user_id, scope, ref_id, item_count, mapping_json, masked_preview) VALUES (?, ?, ?, ?, ?, ?)')
        .run(job.user_id, 'batch', jobId, out.count || 0, JSON.stringify(out.mapping || []), out.masked.slice(0, 2000));
    } catch (e) {
      db.prepare("UPDATE batch_files SET status='failed', error=? WHERE id = ?")
        .run(String(e.message || e).slice(0, 300), f.id);
    }
    const c = jobCounts(jobId);
    db.prepare('UPDATE batch_jobs SET ok_count=?, fail_count=? WHERE id = ?').run(c.ok, c.fail, jobId);
    await new Promise((r) => setImmediate(r));
  }
  const c = jobCounts(jobId);
  const status = c.ok > 0 ? 'done' : 'failed';
  const firstErr = db.prepare("SELECT error FROM batch_files WHERE batch_id = ? AND status='failed' AND error <> '' LIMIT 1").get(jobId);
  db.prepare("UPDATE batch_jobs SET status=?, ok_count=?, fail_count=?, error=?, finished_at=datetime('now','localtime') WHERE id = ?")
    .run(status, c.ok, c.fail, c.ok ? '' : (firstErr ? firstErr.error : '没有可处理的文件'), jobId);
}

// ---- 打包 ----
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function mappingCsv(jobId) {
  const rows = db.prepare("SELECT term, code, rule_key, category FROM mappings WHERE scope_type='batch' AND scope_id=? ORDER BY id").all(jobId);
  const lines = ['原文,占位码,规则,类别'];
  for (const r of rows) lines.push([r.term, r.code, RULE_ZH[r.rule_key] || r.rule_key || '', r.category || ''].map(csvCell).join(','));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8'); // BOM：Excel 直接打开不乱码
}
function buildJobZip(jobId) {
  const files = db.prepare('SELECT * FROM batch_files WHERE batch_id = ? ORDER BY id').all(jobId);
  const entries = [];
  const used = new Set();
  for (const f of files) {
    if (f.status !== 'done') continue;
    let name = 'masked/' + sanitizeBase(f.name) + '.masked.txt';
    let n = 2;
    while (used.has(name)) { name = `masked/${sanitizeBase(f.name)} (${n++}).masked.txt`; }
    used.add(name);
    const p = outTxtPath(jobId, f.id);
    entries.push({ name, data: fs.readFileSync(p) });
  }
  const errs = files.filter((f) => f.status === 'failed');
  const errText = errs.length
    ? errs.map((f) => `${f.name}\t${f.error || '未知错误'}`).join('\r\n') + '\r\n'
    : '没有失败的文件。\r\n';
  entries.push({ name: '_errors.txt', data: Buffer.from('﻿' + errText, 'utf8') });
  entries.push({ name: 'mapping.csv', data: mappingCsv(jobId) });
  return buildZip(entries);
}

module.exports = {
  MAX_FILES, MAX_FILE, MAX_TOTAL, BATCH_DIR,
  batchDir, inPath, rawTxtPath, outTxtPath, mkdirs, rmDir, sanitizeBase,
  createJob, addFile, jobCounts, loadBatchMap, startJob, buildJobZip, mappingCsv,
  isRunning: (id) => RUNNING.has(id),
};
