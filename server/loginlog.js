'use strict';
// 面具 mask — 登录日志 + IP 黑名单 + 暴力防护（方案承教材 loginlog.js：尝试密码 AES-GCM 加密落库）
const crypto = require('crypto');
const { db } = require('./db');

module.exports = function (aesKey) {
  const secret = require('./secret');

  // ---- IP 黑名单 ----
  function isBlocked(ip) {
    if (!ip) return false;
    return !!db.prepare('SELECT 1 FROM ip_blacklist WHERE ip = ?').get(ip);
  }
  function blacklistAdd(ip, note, by) {
    ip = String(ip || '').trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some((o) => Number(o) > 255)) {
      throw new Error('IP 格式不合法');
    }
    if (ip === '127.0.0.1' || ip === '::1') throw new Error('不允许封禁回环地址');
    db.prepare('INSERT INTO ip_blacklist (ip, note, created_by) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET note = excluded.note')
      .run(ip, note || '', by || '');
  }
  function blacklistRemove(ip) { db.prepare('DELETE FROM ip_blacklist WHERE ip = ?').run(ip); }
  function blacklistList() { return db.prepare('SELECT * FROM ip_blacklist ORDER BY rowid DESC').all(); }

  // ---- IP 限流（5 分钟 8 次）----
  const attempts = new Map(); // ip -> [ts]
  function rateBlocked(ip) {
    const now = Date.now();
    const arr = (attempts.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
    arr.push(now);
    attempts.set(ip, arr);
    return arr.length > 8;
  }

  // ---- UA 解析 →「Chrome 120 · Windows」式客户端标签 ----
  function clientLabel(ua) {
    const s = String(ua || '');
    let browser = '未知浏览器';
    let ver = '';
    let m;
    if ((m = /Edg\/([\d]+)/.exec(s))) [browser, ver] = ['Edge', m[1]];
    else if ((m = /Chrome\/([\d]+)/.exec(s))) [browser, ver] = ['Chrome', m[1]];
    else if ((m = /Firefox\/([\d]+)/.exec(s))) [browser, ver] = ['Firefox', m[1]];
    else if (/Safari\//.test(s) && !/Chrome/.test(s)) browser = 'Safari';
    else if (/curl|node-fetch|python/i.test(s)) browser = '脚本/程序';
    let os = '未知系统';
    if (/Windows NT/.test(s)) os = 'Windows';
    else if (/Mac OS X/.test(s)) os = 'macOS';
    else if (/Android/.test(s)) os = 'Android';
    else if (/iPhone|iPad/.test(s)) os = 'iOS';
    else if (/Linux/.test(s)) os = 'Linux';
    return ver ? `${browser} ${ver.split('.')[0]} · ${os}` : `${browser} · ${os}`;
  }

  const isPrivate = (ip) => !ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('fe80');

  // ---- 地区：在线 ip-api（带缓存；私网=内网；MASK_GEO=off 可离线）----
  const geoCache = new Map(); // ip -> {region, ts}
  async function fillRegion(logId, ip) {
    try {
      if (process.env.MASK_GEO === 'off' || isPrivate(ip)) {
        db.prepare('UPDATE login_logs SET region = ? WHERE id = ?').run(isPrivate(ip) ? '内网' : '', logId);
        return;
      }
      const hit = geoCache.get(ip);
      if (hit && Date.now() - hit.ts < 24 * 3600 * 1000) {
        db.prepare('UPDATE login_logs SET region = ? WHERE id = ?').run(hit.region, logId);
        return;
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city&lang=zh-CN`, { signal: ctl.signal });
      clearTimeout(timer);
      const j = await r.json();
      const region = j.status === 'success' ? [j.country, j.regionName, j.city].filter(Boolean).join(' · ') : '未知';
      geoCache.set(ip, { region, ts: Date.now() });
      db.prepare('UPDATE login_logs SET region = ? WHERE id = ?').run(region, logId);
    } catch { /* 查询失败留空，不阻塞登录 */ }
  }

  // ---- 写日志。status: ok | fail | blocked；尝试密码仅失败/拦截时加密记录 ----
  function audit({ username, displayName, status, ip, password, ua }) {
    const info = db.prepare(
      'INSERT INTO login_logs (username, display_name, status, ip, password_enc, client, ua) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(username || '', displayName || '', status, ip || '',
      (status !== 'ok' && password) ? secret.enc(aesKey, password) : null,
      clientLabel(ua), String(ua || '').slice(0, 400));
    const id = Number(info.lastInsertRowid);
    fillRegion(id, ip);
    // 日志裁剪：保留最近 5000 行
    const n = db.prepare('SELECT COUNT(*) AS c FROM login_logs').get().c;
    if (n > 5100) db.prepare('DELETE FROM login_logs WHERE id <= (SELECT id FROM login_logs ORDER BY id DESC LIMIT 1 OFFSET 5000)').run();
    return id;
  }
  function logsPage({ page = 1, size = 5, q = '' } = {}) {
    size = [5, 15, 30, 50, 100].includes(Number(size)) ? Number(size) : 5;
    page = Math.max(1, Number(page) || 1);
    const where = q ? 'WHERE username LIKE ? OR ip LIKE ?' : '';
    const args = q ? [`%${q}%`, `%${q}%`] : [];
    const total = db.prepare(`SELECT COUNT(*) AS c FROM login_logs ${where}`).get(...args).c;
    const rows = db.prepare(`SELECT * FROM login_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
    return { total, page, size, rows: rows.map((r) => ({ ...r, password: r.password_enc ? secret.dec(aesKey, r.password_enc) : null })) };
  }

  // ---- 账号锁：15 分钟内 5 次失败临时拒，10 次永久锁 ----
  function recentFails(username) {
    return db.prepare(
      "SELECT COUNT(*) AS c FROM login_logs WHERE username = ? AND status = 'fail' AND at >= datetime('now','localtime','-15 minutes')"
    ).get(username).c;
  }

  return { isBlocked, blacklistAdd, blacklistRemove, blacklistList, rateBlocked, clientLabel, audit, logsPage, recentFails };
};
