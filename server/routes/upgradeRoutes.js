// 在线升级（仅 admin）：预检 → 应用 → 重启 → 历史 / 备份下载。
//
// 鉴权是**两层**，缺一不可：
//   第 1 层 server/index.js 的全局 /api 中间件（已把 req.user 放进请求）；
//   第 2 层就是下面这个 r.use —— 路由自己再判一次，避免将来有人把挂载点挪走而权限静默失效。
// ⚠️ 本 router 里每一条都是 admin-only，所以这里的 r.use **不带路径**是安全的；
//    千万别把它改挂到 /api 根上——那样会拦下整站请求（工作台踩过这个坑）。
const express = require('express');
const fs = require('fs');
const path = require('path');
const svc = require('../services/upgradeService');
const { buildZip } = require('../services/zipService');

const r = express.Router();

r.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '升级管理仅管理员' });
  next();
});

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64);
}

// 统一出口：UpgradeError 带 code/status 的走语义化响应，其它一律 500（同样是 JSON）
function fail(res, e) {
  if (e instanceof svc.UpgradeError) {
    console.warn(`[upgrade] 拒绝(${e.code}) ${e.message}`);
    return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
  }
  console.error('[upgrade]', e);
  return res.status(500).json({ error: '升级处理失败：' + e.message, code: 'INTERNAL' });
}

// ---------- 上传体：原始 zip 二进制 ----------
// 全局 express.json 只认 JSON，二进制体会原样落到这里。上限与反代的 body 上限同口径。
const rawZip = express.raw({ type: () => true, limit: `${svc.MAX_UPLOAD_MB}mb` });

r.get('/status', (req, res) => {
  try { res.json(svc.statusSnapshot()); } catch (e) { fail(res, e); }
});

r.get('/logs', (req, res) => {
  try { res.json({ logs: svc.listLogs(req.query.limit) }); } catch (e) { fail(res, e); }
});

// 预检（只读，绝不写盘）：返回一次性 token + 明细。uploaded buffer 留在服务端内存，apply 不二次上传。
r.post('/plan', rawZip, (req, res) => {
  try {
    const out = svc.planUpgrade(req.body);
    console.log(`[upgrade] 预检通过 v${out.plan.version.incoming}（${out.plan.summary.files_total} 个文件，`
      + `新增 ${out.plan.summary.add}/覆盖 ${out.plan.summary.overwrite}/跳过 ${out.plan.summary.skip}，`
      + `restart=${out.plan.restart_required}）by ${req.user.username}`);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// 应用：只带 token，不二次上传。**响应之后**才清旧 dist、才拉起接替进程。
r.post('/apply', express.json(), (req, res) => {
  let out;
  try {
    out = svc.applyUpgrade({
      token: String((req.body && req.body.token) || ''),
      actor: req.user.username,
      ip: clientIp(req),
      allowDepChange: !!(req.body && req.body.allow_dep_change),
    });
  } catch (e) { return fail(res, e); }

  const afterRespond = out.afterRespond;
  delete out.afterRespond; // 不能把函数塞进 JSON
  res.json(out);
  // 'finish' = 响应已经离开本进程。重启只能在这之后（先让管理员看到「已申请重启」，
  // 再让进程退出），清旧 dist 同理（可能有请求正在 sendFile 那些目录）。
  res.on('finish', () => {
    try { afterRespond(); } catch (e) { console.error('[upgrade] 收尾（清 dist / 重启）失败:', e); }
  });
});

// 备份下载：把 data/upgrades/backup_<ts>/ 现打成 zip（浏览器里就能拿回滚材料，不用登服务器翻文件）
r.get('/backup/:id/download', (req, res) => {
  const dir = svc.backupZipPath(req.params.id);
  if (!dir) return res.status(404).json({ error: '备份不存在（可能已被保留数量策略清理）' });
  try {
    const entries = [];
    (function walk(d) {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) walk(p);
        else entries.push({ name: path.relative(dir, p).split(path.sep).join('/'), data: fs.readFileSync(p) });
      }
    })(dir);
    if (!entries.length) return res.status(404).json({ error: '备份目录是空的' });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const buf = buildZip(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.zip"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (e) { fail(res, e); }
});

module.exports = r;
