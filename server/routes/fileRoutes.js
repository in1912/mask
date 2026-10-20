'use strict';
// 面具 mask — 文件脱敏路由：上传提取 / 文档级持久对照脱敏 / 外部 AI 往返 / 下载 / 分享回文
const express = require('express');
const multer = require('multer');
const { db, getSetting } = require('../db');
const secret = require('../secret');
const ai = require('../ai');
const engine = require('../engine');
const engines = require('../engines');
const { extractText } = require('../extract');
const { loadCfg } = require('./maskRoutes')();
const { newToken, baseUrl, shareGuide } = require('./shareUtil');

// defParamCharset：busboy 默认按 latin1 解 multipart 文件名，中文名会变乱码；浏览器发的是 UTF-8
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: 20 * 1024 * 1024 } });

const RULE_ZH = Object.fromEntries(engine.RULES.map((r) => [r.key, r.zh]));
const SIZES = [5, 15, 30, 50, 100];

const SYS_BASE = '文中形如 [公司A7]、[手机K3] 或 ORG-7K2M9 的记号是脱敏占位符：请在回复中原样保留这些记号，不要翻译、改写、展开或解释它们，也不要猜测它们代表的内容。';

// 文档级对照表 → Map
function docMap(docId) {
  const map = new Map();
  for (const row of db.prepare("SELECT * FROM mappings WHERE scope_type = 'doc' AND scope_id = ?").all(docId)) {
    map.set(row.term, { term: row.term, code: row.code, key: row.rule_key, cat: row.category, style: row.style || 'A' });
  }
  return map;
}

function ownDoc(req, res) {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!d) { res.status(404).json({ error: '文档不存在' }); return null; }
  if (req.user.role !== 'admin' && d.user_id !== req.user.id) { res.status(403).json({ error: '无权访问他人文档' }); return null; }
  return d;
}

module.exports = function (ctx) {
  const { aesKey } = ctx;
  const r = express.Router();

  // ---- 上传并提取 ----
  r.post('/documents', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const out = extractText(req.file.originalname, req.file.buffer, req.file.mimetype);
    if (out.error) return res.status(400).json({ error: out.error });
    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    const info = db.prepare('INSERT INTO documents (user_id, filename, type, size, raw_text) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, req.file.originalname.slice(0, 120), out.engine, req.file.size, out.text);
    res.json({ id: Number(info.lastInsertRowid), engine: out.engine, text: out.text });
  });

  // ---- 列表（默认 5 行；管理员可看全部）----
  r.get('/documents', (req, res) => {
    const size = SIZES.includes(Number(req.query.size)) ? Number(req.query.size) : 5;
    const page = Math.max(1, Number(req.query.page) || 1);
    const isAdmin = req.user.role === 'admin';
    const where = [];
    const args = [];
    if (!isAdmin || req.query.mine === '1') { where.push('d.user_id = ?'); args.push(req.user.id); }
    else if (req.query.uid && isAdmin) { where.push('d.user_id = ?'); args.push(Number(req.query.uid) || 0); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM documents d ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT d.id, d.filename, d.type, d.size, d.match_count, d.created_at AS at,
      u.username, u.display_name,
      (SELECT COUNT(*) FROM ai_replies a WHERE a.doc_id = d.id) AS reply_count
      FROM documents d LEFT JOIN users u ON u.id = d.user_id ${w} ORDER BY d.id DESC LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size);
    res.json({ total, page, size, rows });
  });

  // ---- 详情：原文 / 脱敏 / AI 返回（三栏数据源）----
  r.get('/documents/:id', (req, res) => {
    const d = ownDoc(req, res); if (!d) return;
    const replies = db.prepare('SELECT id, source, raw_return, restored_text, review_json, created_at AS at FROM ai_replies WHERE doc_id = ? ORDER BY id DESC LIMIT 5').all(d.id);
    const mapping = db.prepare("SELECT term, code, rule_key, category, style FROM mappings WHERE scope_type = 'doc' AND scope_id = ? ORDER BY id").all(d.id);
    const shares = db.prepare("SELECT id, token, pair_token, expires_at, revoked, created_at AS at FROM links WHERE kind = 'doc' AND doc_id = ? ORDER BY id DESC").all(d.id);
    res.json({
      doc: { id: d.id, filename: d.filename, type: d.type, size: d.size, created_at: d.created_at, match_count: d.match_count, meta_report: JSON.parse(d.meta_report_json || '[]') },
      raw_text: d.raw_text, masked_text: d.masked_text || '',
      mapping, replies: replies.map((x) => ({ ...x, review: x.review_json ? JSON.parse(x.review_json) : null, review_json: undefined })),
      shares,
    });
  });

  // ---- 脱敏：文档级持久对照（同一文档重复执行，同实体同码）----
  r.post('/documents/:id/mask', async (req, res) => {
    const d = ownDoc(req, res); if (!d) return;
    const cfg = loadCfg(d.user_id);
    const map = docMap(d.id);
    let out;
    try {
      out = await engines.runMask(d.raw_text || '', cfg, map);
    } catch (e) {
      return res.status(502).json({ error: `脱敏引擎失败：${e.message}` });
    }
    if (out.skipped) return res.json({ skipped: true, reason: out.reason });
    // 新增对照落库
    const up = db.prepare("INSERT OR IGNORE INTO mappings (scope_type, scope_id, code, rule_key, category, style, term) VALUES ('doc', ?, ?, ?, ?, ?, ?)");
    for (const e of map.values()) up.run(d.id, e.code, e.key, e.cat || null, e.style || 'A', e.term);
    // 匹配项数报告（按规则归类）
    const byRule = {};
    for (const e of map.values()) {
      const label = e.key === 'fixed' ? '关键词' : (RULE_ZH[e.key] || e.key || '数值');
      byRule[label] = (byRule[label] || 0) + 1;
    }
    const report = Object.entries(byRule).map(([rule, count]) => ({ rule, count }));
    db.prepare('UPDATE documents SET masked_text = ?, match_count = ?, meta_report_json = ? WHERE id = ?')
      .run(out.masked, out.count, JSON.stringify(report), d.id);
    db.prepare('INSERT INTO desens_history (user_id, scope, ref_id, item_count, mapping_json, masked_preview) VALUES (?, ?, ?, ?, ?, ?)')
      .run(d.user_id, 'file', d.id, out.count, JSON.stringify(out.mapping), out.masked.slice(0, 2000));
    res.json({ masked: out.masked, mapping: out.mapping, count: out.count, report });
  });

  // ---- 送外部 AI（码文往返；返回前已按对照表复原）----
  r.post('/documents/:id/ai', async (req, res) => {
    const d = ownDoc(req, res); if (!d) return;
    if (!d.masked_text) return res.status(400).json({ error: '请先执行脱敏，再送外部 AI' });
    const instruction = String((req.body || {}).instruction || '请总结这份文档的要点。').slice(0, 2000);
    const aiCfg = getSetting('ai_config');
    const api_key = aiCfg && aiCfg.enc ? secret.dec(aesKey, aiCfg.enc) : '';
    if (!aiCfg || !aiCfg.base_url || !api_key || !aiCfg.model) {
      return res.status(503).json({ error: 'AI 接口未配置：请在 系统设置 → AI 配置 填写接口地址、模型与 API Key' });
    }
    const map = docMap(d.id);
    const entries = [...map.values()];
    try {
      const out = await ai.chatOnce({
        base_url: aiCfg.base_url, api_key, model: aiCfg.model, max_tokens: 4096,
        messages: [
          { role: 'system', content: SYS_BASE + '\n以下是一份已脱敏的文档。' },
          { role: 'user', content: d.masked_text + '\n\n---\n' + instruction },
        ],
      });
      if (!out.content) throw new Error('AI 返回了空内容');
      const dec = engine.decode(out.content, entries);
      const review = engine.review(out.content, entries);
      db.prepare('INSERT INTO ai_replies (doc_id, source, raw_return, restored_text, review_json) VALUES (?, ?, ?, ?, ?)')
        .run(d.id, 'internal', out.content, dec.restored, JSON.stringify({ ...review, restored: undefined }));
      res.json({ raw: out.content, restored: dec.restored, review, model: out.model, usage: out.usage });
    } catch (e) {
      res.status(502).json({ error: '外部 AI 调用失败：' + String(e.message || e).slice(0, 200) });
    }
  });

  // ---- 下载：raw | masked | restored（restored = 最近一次 AI 回文的复原文本）----
  r.get('/documents/:id/download', (req, res) => {
    const d = ownDoc(req, res); if (!d) return;
    const which = req.query.which === 'masked' ? 'masked' : (req.query.which === 'restored' ? 'restored' : 'raw');
    let text;
    if (which === 'raw') text = d.raw_text;
    else if (which === 'masked') {
      if (!d.masked_text) return res.status(400).json({ error: '尚未脱敏' });
      text = d.masked_text;
    } else {
      const row = db.prepare('SELECT restored_text FROM ai_replies WHERE doc_id = ? ORDER BY id DESC LIMIT 1').get(d.id);
      if (!row || !row.restored_text) return res.status(400).json({ error: '还没有 AI 回文可下载' });
      text = row.restored_text;
    }
    const tag = { raw: '原文', masked: '脱敏', restored: '回文' }[which];
    const base = d.filename.replace(/\.[^.]+$/, '');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.attachment(`${base}.${tag}.txt`).send(text);
  });

  // ---- 分享：只允许 1 天 / 7 天（绝无永久）；生成分享链接 + 成对回文令牌 ----
  r.post('/documents/:id/share', (req, res) => {
    const d = ownDoc(req, res); if (!d) return;
    if (!d.masked_text) return res.status(400).json({ error: '请先脱敏再分享（分享页只包含码文）' });
    const days = Number((req.body || {}).days) === 7 ? 7 : 1;
    const token = newToken();
    const pair = newToken();
    db.prepare(`INSERT INTO links (token, kind, doc_id, pair_token, expires_at, created_by)
      VALUES (?, 'doc', ?, ?, datetime('now','localtime', ?), ?)`).run(token, d.id, pair, `'+${days} days'`, req.user.username);
    res.json({
      days, token, pair_token: pair,
      url: `${baseUrl(req)}/s/${token}`,
      pair_url: `${baseUrl(req)}/s/${pair}`,
      write_url: `${baseUrl(req)}/api/pub/write/${pair}`,
      guide: shareGuide(),
      expires_hint: `${days} 天后失效`,
    });
  });

  r.get('/documents/:id/shares', (req, res) => {
    const d = ownDoc(req, res); if (!d) return;
    const rows = db.prepare(`SELECT l.id, l.token, l.pair_token, l.expires_at, l.revoked, l.created_at AS at,
      (SELECT COUNT(*) FROM ai_replies a WHERE a.doc_id = l.doc_id AND a.source = 'share') AS writes
      FROM links l WHERE l.kind = 'doc' AND l.doc_id = ? ORDER BY l.id DESC`).all(d.id);
    res.json({ rows: rows.map((x) => ({ ...x, url: `${baseUrl(req)}/s/${x.token}` })) });
  });

  // ---- 撤销分享 ----
  r.delete('/shares/:token', (req, res) => {
    const l = db.prepare('SELECT * FROM links WHERE token = ?').get(String(req.params.token));
    if (!l) return res.status(404).json({ error: '链接不存在' });
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(l.doc_id);
    if (!d || (req.user.role !== 'admin' && d.user_id !== req.user.id)) return res.status(403).json({ error: '无权操作' });
    db.prepare('UPDATE links SET revoked = 1 WHERE id = ?').run(l.id);
    res.json({ ok: true });
  });

  // ---- 删除文档（连带对照/回文/分享链接）----
  r.delete('/documents/:id', (req, res) => {
    const d = ownDoc(req, res); if (!d) return;
    const linkIds = db.prepare('SELECT id FROM links WHERE doc_id = ?').all(d.id).map((x) => x.id);
    db.prepare('DELETE FROM link_writes WHERE link_id IN (' + (linkIds.length ? linkIds.map(() => '?').join(',') : '0') + ')').run(...linkIds);
    db.prepare('DELETE FROM links WHERE doc_id = ?').run(d.id);
    db.prepare("DELETE FROM mappings WHERE scope_type = 'doc' AND scope_id = ?").run(d.id);
    db.prepare('DELETE FROM ai_replies WHERE doc_id = ?').run(d.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
    res.json({ ok: true });
  });

  return { router: r, docMap };
};
