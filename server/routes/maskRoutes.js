'use strict';
// 面具 mask — 规则配置 / 试运行 / 脱敏历史（含二次复核）
const express = require('express');
const { db } = require('../db');
const engine = require('../engine');
const engines = require('../engines');

function loadCfg(uid) {
  const row = db.prepare('SELECT * FROM rule_config WHERE user_id = ?').get(uid);
  if (!row) return { ...engine.DEFAULT_CFG, types: {}, fixed: [] };
  return {
    enabled: !!row.enabled,
    mask_numbers: !!row.mask_numbers,
    amount_on: !!row.amount_on,
    code_style: row.code_style,
    types: JSON.parse(row.types_json || '{}'),
    fixed: JSON.parse(row.fixed_terms_json || '[]'),
  };
}

module.exports = function () {
  const r = express.Router();

  r.get('/rules/meta', (req, res) => {
    res.json({ catalog: engine.catalog(), cfg: loadCfg(req.user.id) });
  });

  r.put('/rules/config', (req, res) => {
    const b = req.body || {};
    const types = (b.types && typeof b.types === 'object' && !Array.isArray(b.types)) ? b.types : {};
    const fixed = Array.isArray(b.fixed) ? b.fixed.slice(0, 500) : [];
    db.prepare(`INSERT INTO rule_config (user_id, enabled, mask_numbers, amount_on, code_style, types_json, fixed_terms_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, mask_numbers=excluded.mask_numbers,
        amount_on=excluded.amount_on, code_style=excluded.code_style, types_json=excluded.types_json,
        fixed_terms_json=excluded.fixed_terms_json, updated_at=excluded.updated_at`)
      .run(req.user.id, b.enabled === false ? 0 : 1, b.mask_numbers ? 1 : 0, b.amount_on === false ? 0 : 1,
        ['A', 'B', 'C'].includes(b.code_style) ? b.code_style : 'A', JSON.stringify(types), JSON.stringify(fixed));
    res.json({ ok: true, cfg: loadCfg(req.user.id) });
  });

  // 试运行：一次性 Map，不落 mappings 表；快照进历史
  r.post('/rules/preview', async (req, res) => {
    const text = String((req.body || {}).text || '');
    if (!text.trim()) return res.status(400).json({ error: '请输入试运行文本' });
    let out;
    try {
      out = await engines.runMask(text, loadCfg(req.user.id));
    } catch (e) {
      return res.status(502).json({ error: `脱敏引擎失败：${e.message}` });
    }
    if (out.skipped) return res.json({ skipped: true, reason: out.reason });
    const info = db.prepare('INSERT INTO desens_history (user_id, scope, ref_id, item_count, mapping_json, masked_preview) VALUES (?, ?, NULL, ?, ?, ?)')
      .run(req.user.id, 'preview', out.count, JSON.stringify(out.mapping), out.masked.slice(0, 2000));
    res.json({ masked: out.masked, mapping: out.mapping, count: out.count, history_id: Number(info.lastInsertRowid) });
  });

  // ---- 脱敏历史：本人可见全部自己的；管理员可见所有人的 ----
  r.get('/history', (req, res) => {
    const size = [10, 20, 30, 50, 100].includes(Number(req.query.size)) ? Number(req.query.size) : 10;
    const page = Math.max(1, Number(req.query.page) || 1);
    const scope = ['chat', 'preview', 'file', 'batch'].includes(req.query.scope) ? req.query.scope : '';
    const isAdmin = req.user.role === 'admin';
    const where = [];
    const args = [];
    if (!isAdmin) { where.push('h.user_id = ?'); args.push(req.user.id); }
    if (req.query.uid && isAdmin) { where.push('h.user_id = ?'); args.push(Number(req.query.uid) || 0); }
    if (scope) { where.push('h.scope = ?'); args.push(scope); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM desens_history h ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT h.id, h.created_at AS at, h.scope, h.ref_id, h.item_count, u.username, u.display_name
      FROM desens_history h LEFT JOIN users u ON u.id = h.user_id ${w} ORDER BY h.id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    res.json({ total, page, size, rows });
  });

  r.get('/history/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM desens_history WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '记录不存在' });
    if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: '无权查看' });
    res.json({ ...row, mapping: JSON.parse(row.mapping_json || '[]') });
  });

  // 二次复核：残留代码 / 未引用项 / 结论
  r.post('/history/:id/review', (req, res) => {
    const row = db.prepare('SELECT * FROM desens_history WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '记录不存在' });
    if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: '无权操作' });
    const mapping = JSON.parse(row.mapping_json || '[]');
    const rv = engine.review(row.masked_preview || '', mapping);
    db.prepare('INSERT INTO reviews (history_id, verdict, detail_json, by_user) VALUES (?, ?, ?, ?)')
      .run(row.id, rv.verdict, JSON.stringify({ residual: rv.residual, unused: rv.unused }), req.user.username);
    res.json(rv);
  });

  r.delete('/history/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM desens_history WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '记录不存在' });
    if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: '无权删除' });
    db.prepare('DELETE FROM desens_history WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM reviews WHERE history_id = ?').run(row.id);
    res.json({ ok: true });
  });

  return { router: r, loadCfg };
};
