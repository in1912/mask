'use strict';
// 面具 mask — Agent 协同路由：给外部 AI 的只写链接（默认永久，可 7/14/30 天）
// 语义：链接页只有引导语 + 回文框；写入只存码文/文本，解码只发生在主人侧
const express = require('express');
const { db } = require('../db');
const { newToken, baseUrl, agentGuide } = require('./shareUtil');

const SIZES = [5, 15, 30, 50, 100];

function ownLink(req, res) {
  const l = db.prepare('SELECT * FROM links WHERE id = ?').get(Number(req.params.id));
  if (!l || l.kind !== 'agent') { res.status(404).json({ error: '链接不存在' }); return null; }
  if (req.user.role !== 'admin' && l.created_by !== req.user.username) { res.status(403).json({ error: '无权访问他人链接' }); return null; }
  return l;
}

module.exports = function () {
  const r = express.Router();

  // days: 0=永久（默认）/7/14/30
  r.post('/agents', (req, res) => {
    const daysRaw = Number((req.body || {}).days);
    const days = [7, 14, 30].includes(daysRaw) ? daysRaw : 0;
    const token = newToken();
    db.prepare(`INSERT INTO links (token, kind, expires_at, created_by)
      VALUES (?, 'agent', ${days ? `datetime('now','localtime','+${days} days')` : 'NULL'}, ?)`)
      .run(token, req.user.username);
    const l = db.prepare('SELECT * FROM links WHERE token = ?').get(token);
    res.json({ id: l.id, token, days, url: `${baseUrl(req)}/s/${token}`, expires_at: l.expires_at });
  });

  r.get('/agents', (req, res) => {
    const size = SIZES.includes(Number(req.query.size)) ? Number(req.query.size) : 5;
    const page = Math.max(1, Number(req.query.page) || 1);
    const isAdmin = req.user.role === 'admin';
    const mine = !(isAdmin && req.query.all === '1');
    const clause = mine ? "WHERE l.created_by = ? AND l.kind = 'agent'" : "WHERE l.kind = 'agent'";
    const args = mine ? [req.user.username] : [];
    const total = db.prepare(`SELECT COUNT(*) AS c FROM links l ${clause}`).get(...args).c;
    const rows = db.prepare(`SELECT l.id, l.token, l.expires_at, l.revoked, l.created_by, l.created_at AS at,
      (SELECT COUNT(*) FROM link_writes w WHERE w.link_id = l.id) AS writes,
      (SELECT MAX(w.created_at) FROM link_writes w WHERE w.link_id = l.id) AS last_write
      FROM links l ${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size);
    res.json({ total, page, size, rows: rows.map((x) => ({ ...x, url: `${baseUrl(req)}/s/${x.token}` })) });
  });

  r.get('/agents/:id/writes', (req, res) => {
    const l = ownLink(req, res); if (!l) return;
    const size = SIZES.includes(Number(req.query.size)) ? Number(req.query.size) : 5;
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = db.prepare('SELECT COUNT(*) AS c FROM link_writes WHERE link_id = ?').get(l.id).c;
    const rows = db.prepare(`SELECT id, word_count, ua, created_at AS at, substr(content, 1, 200) AS excerpt
      FROM link_writes WHERE link_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(l.id, size, (page - 1) * size);
    res.json({ total, page, size, rows });
  });

  r.get('/agents/writes/:wid', (req, res) => {
    const w = db.prepare('SELECT * FROM link_writes WHERE id = ?').get(Number(req.params.wid));
    if (!w) return res.status(404).json({ error: '回文不存在' });
    const l = db.prepare('SELECT * FROM links WHERE id = ?').get(w.link_id);
    if (!l || (req.user.role !== 'admin' && l.created_by !== req.user.username)) return res.status(403).json({ error: '无权查看' });
    res.json({ id: w.id, link_id: w.link_id, content: w.content, word_count: w.word_count, ua: w.ua, created_at: w.created_at });
  });

  r.delete('/agents/:id', (req, res) => {
    const l = ownLink(req, res); if (!l) return;
    db.prepare('DELETE FROM link_writes WHERE link_id = ?').run(l.id);
    db.prepare('DELETE FROM links WHERE id = ?').run(l.id);
    res.json({ ok: true });
  });

  return { router: r };
};
