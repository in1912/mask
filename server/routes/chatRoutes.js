'use strict';
// 面具 mask — 对话路由：会话管理 / 附件提取 / SSE 聊天（先脱敏后发送、流式复原）
const express = require('express');
const multer = require('multer');
const { db, getSetting } = require('../db');
const secret = require('../secret');
const ai = require('../ai');
const engine = require('../engine');
const engines = require('../engines');
const { extractText } = require('../extract');
const { loadCfg } = require('./maskRoutes')();

// defParamCharset：busboy 默认按 latin1 解 multipart 文件名，中文名会变乱码；浏览器发的是 UTF-8
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: 20 * 1024 * 1024 } });

const SYS_BASE = '文中形如 [公司A7]、[手机K3] 或 ORG-7K2M9 的记号是脱敏占位符：请在回复中原样保留这些记号，不要翻译、改写、展开或解释它们，也不要猜测它们代表的内容。';

module.exports = function (ctx) {
  const { aesKey } = ctx;
  const r = express.Router();

  r.get('/conversations', (req, res) => {
    res.json({ list: db.prepare('SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY id DESC').all(req.user.id) });
  });
  r.post('/conversations', (req, res) => {
    const info = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)')
      .run(req.user.id, String((req.body || {}).title || '新对话').slice(0, 24));
    res.json({ id: Number(info.lastInsertRowid) });
  });
  r.delete('/conversations/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!c) return res.status(404).json({ error: '会话不存在' });
    db.prepare('DELETE FROM messages WHERE conv_id = ?').run(c.id);
    db.prepare("DELETE FROM mappings WHERE scope_type = 'conv' AND scope_id = ?").run(c.id);
    db.prepare('DELETE FROM ai_replies WHERE conv_id = ?').run(c.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });
  r.get('/conversations/:id/messages', (req, res) => {
    const c = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!c) return res.status(404).json({ error: '会话不存在' });
    res.json({ messages: db.prepare('SELECT id, role, content, masked_content, mask_count, created_at FROM messages WHERE conv_id = ? ORDER BY id').all(c.id) });
  });

  r.post('/attachments', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const out = extractText(req.file.originalname, req.file.buffer, req.file.mimetype);
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ name: req.file.originalname, size: req.file.size, text: out.text, engine: out.engine });
  });

  // ---- 聊天主流程 ----
  r.post('/chat', async (req, res) => {
    const uid = req.user.id;
    const body = req.body || {};
    let msgs = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12);
    if (!msgs.length) return res.status(400).json({ error: '消息为空' });
    if (msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: '最后一条必须是用户消息' });

    let conv = body.conv_id
      ? db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(body.conv_id), uid)
      : null;
    if (!conv) {
      const first = [...msgs].reverse().find((m) => m.role === 'user');
      const info = db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)').run(uid, first.content.slice(0, 24));
      conv = { id: Number(info.lastInsertRowid) };
    }

    // AI 配置检查（未配置直接 503，别进 SSE）
    const aiCfg = getSetting('ai_config');
    const api_key = aiCfg && aiCfg.enc ? secret.dec(aesKey, aiCfg.enc) : '';
    if (!aiCfg || !aiCfg.base_url || !api_key) {
      return res.status(503).json({ error: 'AI 接口未配置：请在 设置 → AI 配置 填写接口地址、模型与 API Key' });
    }
    if (!aiCfg.model) return res.status(503).json({ error: 'AI 模型名称未配置' });

    // ---- 脱敏：会话级持久对照表（同一实体全程同码）----
    const cfg = loadCfg(uid);
    const useMask = !!body.desensitize;
    const map = new Map();
    let skipped = !useMask;
    let skipReason = useMask ? '' : '本轮未启用脱敏';
    if (useMask) {
      const rows = db.prepare("SELECT * FROM mappings WHERE scope_type = 'conv' AND scope_id = ?").all(conv.id);
      for (const row of rows) map.set(row.term, { term: row.term, code: row.code, key: row.rule_key, cat: row.category, style: row.style || 'A' });
      const preCount = map.size;
      const firstUser = [...msgs].reverse().find((m) => m.role === 'user');
      try {
        const probe = await engines.runMask(firstUser.content, cfg, map); // 单独探测开关状态
        if (probe.skipped) { skipped = true; skipReason = probe.reason; }
      } catch (e) {
        // 外部引擎失败：红线——绝不把原文放给 AI，如实退出
        return res.status(502).json({ error: `脱敏引擎失败：${e.message}` });
      }
    }

    const entries = [...map.values()];
    const outMsgs = [];
    for (const m of msgs) {
      if (!skipped) {
        try {
          const e = await engines.runMask(m.content, cfg, map);
          outMsgs.push({ role: m.role, content: e.masked });
        } catch (err) {
          return res.status(502).json({ error: `脱敏引擎失败：${err.message}` });
        }
      } else outMsgs.push({ role: m.role, content: m.content });
    }

    // 新增对照落库（INSERT OR IGNORE 兜底 UNIQUE）
    if (!skipped) {
      const up = db.prepare("INSERT OR IGNORE INTO mappings (scope_type, scope_id, code, rule_key, category, style, term) VALUES ('conv', ?, ?, ?, ?, ?, ?)");
      for (const e of map.values()) up.run(conv.id, e.code, e.key, e.cat || null, e.style || 'A', e.term);
    }

    // 发送上行的系统提示：占位符保留指令 +（可选）规则摘要
    const sys = [];
    if (!skipped && map.size) sys.push(SYS_BASE);
    if (!skipped && body.with_rules && map.size) {
      const on = engine.RULES.filter((x) => x.scan && cfg.types[x.key] !== false && !(x.amount && cfg.amount_on === 0)).map((x) => x.zh);
      sys.push(`当前脱敏规则：${on.join('、')}（共 ${on.length} 类）。`);
    }

    // SSE
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    const last = msgs[msgs.length - 1];
    const lastMasked = outMsgs[outMsgs.length - 1].content;

    // 本轮对照：只取本轮最后一条用户消息里真正出现的实体。
    // map 是整段会话的持久对照表（同实体全程同码），历史轮次的条目不再重复推给界面。
    const fullEntries = [...map.values()];
    let roundEntries = [];
    if (!skipped) {
      const used = new Set(engine.decode(lastMasked, fullEntries).usedCodes);
      roundEntries = fullEntries.filter((e) => used.has(e.code));
    }

    // 本轮实际参与识别的引擎（界面要如实显示，不能只说「已脱敏」）
    const engineUsed = skipped ? '' : (() => {
      const all = engines.getCfg();
      const ids = engines.activeExternalEngines();
      const nm = (id) => (engines.ENGINES.find((e) => e.id === id) || {}).name || id;
      if (!ids.length) return '内置规则引擎';
      if (all.mode === 'primary') return `${nm(ids[0])}（外部主引擎）`;
      return `内置规则 + ${ids.map(nm).join(' + ')}（并行）`;
    })();

    send({ type: 'start', conv_id: conv.id, masked: !skipped, mapping: skipped ? [] : roundEntries, count: skipped ? 0 : roundEntries.length, engine: engineUsed, skipped, reason: skipReason });

    // 流式复原：宁可扣住最后几个字符，也绝不把半个占位符泄进气泡
    let carry = '';
    let emitted = '';
    const holdLen = (s) => {
      const lb = s.lastIndexOf('[');
      if (lb !== -1 && s.indexOf(']', lb) === -1 && s.length - lb <= 16) return s.length - lb;
      let m = /[A-Za-z]{0,6}-[A-Za-z0-9]{0,5}$/.exec(s);
      if (m && m[0] && [...map.values()].some((e) => e.style === 'C' && e.code.toUpperCase().startsWith(m[0].toUpperCase()))) return m[0].length;
      m = /[A-Za-z]{2,6}$/.exec(s);
      if (m && [...map.values()].some((e) => e.style === 'C' && e.code.toUpperCase().startsWith(m[0].toUpperCase()))) return m[0].length;
      return 0;
    };

    let raw = '';
    try {
      raw = await ai.chatStream({
        base_url: aiCfg.base_url, api_key, model: aiCfg.model,
        messages: sys.length ? [{ role: 'system', content: sys.join('\n') }, ...outMsgs] : outMsgs,
        onDelta: (t) => {
          carry += t;
          const h = holdLen(carry);
          const cut = carry.length - h;
          if (cut <= 0) return;
          const head = carry.slice(0, cut);
          carry = carry.slice(cut);
          const dec = skipped ? head : engine.decode(head, [...map.values()], { loose: false }).restored;
          emitted += dec;
          send({ type: 'delta', text: dec });
        },
      });
      const tail = skipped ? carry : engine.decode(carry, [...map.values()], { loose: false }).restored;
      emitted += tail;
      send({ type: 'delta', text: tail });

      // 回文复核按整张会话表复原（回复可能引用前几轮实体），但「未出现」只统计本轮条目，
      // 否则前几轮的历史对照会被一直列出来，让人以为是本轮的问题。
      let review = null;
      if (!skipped) {
        const full = engine.review(emitted, fullEntries);
        const usedCodes = new Set(engine.decode(emitted, fullEntries).usedCodes);
        const unused = roundEntries.filter((e) => !usedCodes.has(e.code)).map((e) => e.term);
        review = { ...full, unused, restoredCount: roundEntries.length - unused.length };
      }

      db.prepare('INSERT INTO messages (conv_id, role, content, masked_content, mask_count) VALUES (?, ?, ?, ?, ?)')
        .run(conv.id, 'user', last.content, skipped ? null : lastMasked, skipped ? 0 : roundEntries.length);
      db.prepare('INSERT INTO messages (conv_id, role, content) VALUES (?, ?, ?)').run(conv.id, 'assistant', emitted);
      db.prepare('INSERT INTO ai_replies (conv_id, source, raw_return, restored_text, review_json) VALUES (?, ?, ?, ?, ?)')
        .run(conv.id, 'internal', raw, emitted, review ? JSON.stringify(review) : null);
      db.prepare('INSERT INTO desens_history (user_id, scope, ref_id, item_count, mapping_json, masked_preview) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uid, 'chat', conv.id, skipped ? 0 : map.size, JSON.stringify(skipped ? [] : [...map.values()]), (skipped ? '' : lastMasked).slice(0, 2000));
      db.prepare("UPDATE conversations SET updated_at = datetime('now','localtime') WHERE id = ?").run(conv.id);

      send({ type: 'done', conv_id: conv.id, content: emitted, review, engine: engineUsed });
    } catch (e) {
      send({ type: 'error', error: String(e.message || e).slice(0, 300) });
    }
    res.end();
  });

  return r;
};
