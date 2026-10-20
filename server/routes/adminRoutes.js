'use strict';
// 面具 mask — 管理路由：用户管理 / AI 配置（加密）/ 系统信息 / 登录日志 / IP 黑名单
const express = require('express');
const os = require('os');
const { db, getSetting, setSetting } = require('../db');
const secret = require('../secret');
const ai = require('../ai');
const { hashPassword } = require('../secret');

module.exports = function (ctx) {
  const { loginlog, aesKey } = ctx;
  const r = express.Router();
  const admin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: '需要管理员权限' }));

  // ---- 用户管理 ----
  r.get('/users', admin, (req, res) => {
    res.json({ users: db.prepare('SELECT id, username, role, display_name, status, locked_permanent, created_at, last_login_at FROM users ORDER BY id').all() });
  });
  r.post('/users', admin, (req, res) => {
    const { username, password, role, display_name } = req.body || {};
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(String(username || ''))) return res.status(400).json({ error: '用户名需 2-32 位字母数字 _ . -' });
    if (String(password || '').length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: '角色只能是 admin/user' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: '用户名已存在' });
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(String(password)), role, String(display_name || '').slice(0, 40) || null);
    res.json({ ok: true });
  });
  r.put('/users/:id', admin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const b = req.body || {};
    if (b.password !== undefined) {
      if (String(b.password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.password)), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (b.role !== undefined && ['admin', 'user'].includes(b.role)) {
      if (u.role === 'admin' && b.role === 'user' && db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'").get().c <= 1) {
        return res.status(400).json({ error: '不能取消最后一个管理员' });
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, u.id);
    }
    if (b.display_name !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(b.display_name).slice(0, 40) || null, u.id);
    if (b.status !== undefined && ['active', 'disabled'].includes(b.status)) db.prepare('UPDATE users SET status = ? WHERE id = ?').run(b.status, u.id);
    if (b.locked_permanent !== undefined) db.prepare('UPDATE users SET locked_permanent = ? WHERE id = ?').run(b.locked_permanent ? 1 : 0, u.id);
    if (b.unlock === true) {
      db.prepare('UPDATE users SET locked_permanent = 0 WHERE id = ?').run(u.id);
      db.prepare("DELETE FROM login_logs WHERE username = ? AND status = 'fail'").run(u.username);
    }
    res.json({ ok: true });
  });
  r.delete('/users/:id', admin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: '用户不存在' });
    if (u.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
    if (u.role === 'admin' && db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c <= 1) {
      return res.status(400).json({ error: '不能删除最后一个管理员' });
    }
    const convIds = db.prepare('SELECT id FROM conversations WHERE user_id = ?').all(u.id).map((x) => x.id);
    db.prepare('DELETE FROM messages WHERE conv_id IN (SELECT id FROM conversations WHERE user_id = ?)').run(u.id);
    for (const cid of convIds) db.prepare("DELETE FROM mappings WHERE scope_type = 'conv' AND scope_id = ?").run(cid);
    db.prepare('DELETE FROM conversations WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM rule_config WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM desens_history WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    res.json({ ok: true });
  });

  // ---- AI 配置（Key 只进 AES-GCM 密文，永不回传）----
  r.get('/settings/ai-config', admin, (req, res) => {
    const c = getSetting('ai_config') || {};
    const key = c.enc ? secret.dec(aesKey, c.enc) : '';
    res.json({ model: c.model || '', base_url: c.base_url || '', has_key: !!key, key_tail: key ? key.slice(-4) : '' });
  });
  r.post('/settings/ai-config', admin, (req, res) => {
    const b = req.body || {};
    const old = getSetting('ai_config') || {};
    const key = (b.api_key && String(b.api_key).trim()) ? String(b.api_key).trim() : (old.enc ? secret.dec(aesKey, old.enc) : '');
    if (!key) return res.status(400).json({ error: '请填写 API Key' });
    if (!String(b.model || '').trim()) return res.status(400).json({ error: '请填写模型名称' });
    setSetting('ai_config', { model: String(b.model).trim(), base_url: String(b.base_url || '').trim(), enc: secret.enc(aesKey, key) });
    res.json({ ok: true });
  });
  r.post('/settings/ai-test', admin, async (req, res) => {
    const b = req.body || {};
    const old = getSetting('ai_config') || {};
    const base_url = String(b.base_url || old.base_url || '').trim();
    const model = String(b.model || old.model || '').trim();
    const api_key = (b.api_key && String(b.api_key).trim()) ? String(b.api_key).trim() : (old.enc ? secret.dec(aesKey, old.enc) : '');
    if (!base_url || !model || !api_key) return res.status(400).json({ error: '先填好接口地址、模型与 API Key 再测试' });
    try {
      const out = await ai.chatOnce({ base_url, api_key, model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, timeout_ms: 20000 });
      res.json({ ok: true, model: out.model, reply: String(out.content).slice(0, 100) });
    } catch (e) {
      res.json({ ok: false, error: String(e.message || e).slice(0, 300) });
    }
  });

  // ---- 系统信息：备案号 / 外网域名 / 本机地址 ----
  r.get('/settings/system', admin, (req, res) => {
    res.json({
      beian: getSetting('beian', ''),
      external_base_url: getSetting('external_base_url', ''),
      local_base_url: getSetting('local_base_url', ''),
    });
  });
  r.post('/settings/system', admin, (req, res) => {
    const b = req.body || {};
    if (b.beian !== undefined) setSetting('beian', String(b.beian).trim().slice(0, 60));
    if (b.external_base_url !== undefined) setSetting('external_base_url', String(b.external_base_url).trim().slice(0, 200).replace(/\/+$/, ''));
    if (b.local_base_url !== undefined) setSetting('local_base_url', String(b.local_base_url).trim().slice(0, 200).replace(/\/+$/, ''));
    res.json({ ok: true });
  });
  r.get('/settings/lan-addrs', admin, (req, res) => {
    const addrs = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
    res.json({ addrs: [...new Set(addrs)] });
  });

  // ---- 登录日志（尝试密码仅管理员可见，已解密展示）----
  r.get('/login-logs', admin, (req, res) => {
    res.json(loginlog.logsPage({ page: req.query.page, size: req.query.size, q: String(req.query.q || '') }));
  });

  // ---- IP 黑名单 ----
  r.get('/ip-blacklist', admin, (req, res) => res.json({ list: loginlog.blacklistList() }));
  r.post('/ip-blacklist', admin, (req, res) => {
    try {
      loginlog.blacklistAdd((req.body || {}).ip, (req.body || {}).note, req.user.username);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.delete('/ip-blacklist/:ip', admin, (req, res) => {
    loginlog.blacklistRemove(req.params.ip);
    res.json({ ok: true });
  });

  return r;
};
