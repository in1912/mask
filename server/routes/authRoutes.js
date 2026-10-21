'use strict';
// 面具 mask — 认证路由：登录（三态日志）/登出/我/改密/主题
const crypto = require('crypto');
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { verifyPassword, hashPassword } = require('../secret');

// v1.01：连续输错 3 次 → 该账号锁 30 分钟；提示只说上限已达，不透露剩余时间
const LOCK_FAILS = 3;
const LOCK_MINUTES = 30;
const LOCK_MSG = '密码输入错误上限已达，禁止登录系统';

module.exports = function (ctx) {
  const { loginlog } = ctx;
  const r = express.Router();

  r.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const ip = req.clientIp;
    const ua = req.headers['user-agent'];
    if (loginlog.isBlocked(ip)) {
      loginlog.audit({ username, status: 'blocked', ip, password, ua });
      return res.status(403).json({ error: '该 IP 已被封禁，无法登录' });
    }
    if (loginlog.rateBlocked(ip)) {
      loginlog.audit({ username, status: 'blocked', ip, password, ua });
      return res.status(429).json({ error: '尝试过于频繁，请 5 分钟后再试' });
    }
    const u = username
      ? db.prepare('SELECT * FROM users WHERE username = ?').get(String(username))
      : null;
    // 限时锁定：密码正确也拒；只看是否仍在锁定期，不告诉对方还剩多久
    if (u && u.locked_until && db.prepare("SELECT ? > datetime('now','localtime') AS v").get(u.locked_until).v) {
      loginlog.audit({ username: u.username, displayName: u.display_name, status: 'blocked', ip, ua });
      return res.status(403).json({ error: LOCK_MSG });
    }
    if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
      loginlog.audit({ username, displayName: u ? u.display_name : null, status: 'fail', ip, password: String(password || ''), ua });
      if (u && loginlog.recentFails(u.username, LOCK_MINUTES) >= LOCK_FAILS) {
        db.prepare(`UPDATE users SET locked_until = datetime('now','localtime','+${LOCK_MINUTES} minutes') WHERE id = ?`).run(u.id);
        return res.status(403).json({ error: LOCK_MSG });
      }
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (u.status !== 'active') {
      loginlog.audit({ username: u.username, displayName: u.display_name, status: 'blocked', ip, ua });
      return res.status(403).json({ error: '账号已停用，请联系管理员' });
    }
    if (u.locked_permanent) {
      loginlog.audit({ username: u.username, displayName: u.display_name, status: 'blocked', ip, ua });
      return res.status(403).json({ error: '账号已被管理员锁定，请联系管理员解锁' });
    }
    const token = 'm_' + crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now','localtime','+7 days'))").run(token, u.id);
    db.prepare("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?").run(u.id);
    loginlog.audit({ username: u.username, displayName: u.display_name, status: 'ok', ip, ua });
    res.setHeader('Set-Cookie', `mask_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
    res.json({ token, user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role } });
  });

  r.post('/logout', (req, res) => {
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.setHeader('Set-Cookie', 'mask_token=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    const u = req.user;
    // 自己选过风格（theme:u<id>）用自己的；从没选过就跟随管理员设的站点默认风格
    res.json({ user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role }, theme: getSetting(`theme:u${u.id}`, getSetting('theme:default', 'dark')) });
  });

  r.post('/theme', (req, res) => {
    const t = String((req.body || {}).theme || '');
    if (!['dark', 'light', 'purple', 'green'].includes(t)) return res.status(400).json({ error: '未知主题' });
    setSetting(`theme:u${req.user.id}`, t);
    res.json({ ok: true, theme: t });
  });

  r.post('/password', (req, res) => {
    const { old: oldPw, next: newPw } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(oldPw || ''), u.password_hash)) return res.status(400).json({ error: '原密码不正确' });
    if (String(newPw || '').length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPw)), u.id);
    // 其他会话全部失效，只保留当前
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, req.token || '');
    res.json({ ok: true });
  });

  return r;
};
