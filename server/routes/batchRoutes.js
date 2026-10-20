'use strict';
// 批量脱敏（v0.4.0）：上传多文件 / 从会话生成批次 → 异步执行 → 预览、单文件下载、整包 zip。
// 权限：本人可看可跑可删；管理员可看全部内容（用户 2026-10-20 拍板），并可删除清理。
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const svc = require('../services/batchService');

module.exports = function () {
  const r = express.Router();
  fs.mkdirSync(path.join(svc.BATCH_DIR, '_tmp'), { recursive: true });

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      if (!req._tmpDir) {
        req._tmpDir = path.join(svc.BATCH_DIR, '_tmp', `u${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        fs.mkdirSync(req._tmpDir, { recursive: true });
      }
      cb(null, req._tmpDir);
    },
    filename(req, file, cb) { cb(null, Math.random().toString(36).slice(2, 12)); },
  });
  const upload = multer({
    storage,
    defParamCharset: 'utf8', // 中文文件名不能按 latin1 解
    limits: { fileSize: svc.MAX_FILE, files: svc.MAX_FILES },
  });

  function uploadMany(req, res, next) {
    upload.array('files', svc.MAX_FILES)(req, res, (err) => {
      if (!err) return next();
      if (req._tmpDir) { try { fs.rmSync(req._tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '单个文件超过 20MB 上限'
        : err.code === 'LIMIT_FILE_COUNT' ? `一次最多 ${svc.MAX_FILES} 个文件`
          : `上传失败：${err.message}`;
      res.status(400).json({ error: msg });
    });
  }

  function jobDetail(id) {
    const j = db.prepare(`SELECT j.*, u.username, u.display_name FROM batch_jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.id = ?`).get(id);
    if (!j) return null;
    const files = db.prepare(`SELECT id, name, ext, size, status, error, chars, match_count, out_name,
      substr(preview_raw, 1, 600) AS preview_raw, substr(preview_masked, 1, 600) AS preview_masked
      FROM batch_files WHERE batch_id = ? ORDER BY id`).all(id);
    const mapping_count = db.prepare("SELECT COUNT(*) AS c FROM mappings WHERE scope_type='batch' AND scope_id=?").get(id).c;
    const processed = files.filter((f) => f.status === 'done' || f.status === 'failed').length;
    return { job: j, files, mapping_count, processed };
  }

  // 本人或管理员
  function ownJob(req, res) {
    const j = db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(Number(req.params.id));
    if (!j) { res.status(404).json({ error: '批次不存在' }); return null; }
    if (req.user.role !== 'admin' && j.user_id !== req.user.id) { res.status(403).json({ error: '无权访问他人批次' }); return null; }
    return j;
  }

  // ---- 新建批次：多文件上传 ----
  r.post('/', uploadMany, (req, res) => {
    const list = Array.isArray(req.files) ? req.files : [];
    try {
      if (!list.length) return res.status(400).json({ error: '未收到文件' });
      const total = list.reduce((s, f) => s + f.size, 0);
      if (total > svc.MAX_TOTAL) {
        return res.status(413).json({ error: `单批合计超过 ${Math.round(svc.MAX_TOTAL / 1048576)}MB 上限（本次 ${(total / 1048576).toFixed(1)}MB）` });
      }
      const id = svc.createJob(req.user.id, 'text', { source: 'upload' });
      try {
        for (const f of list) {
          const base = path.basename(String(f.originalname || 'file'));
          const ext = (base.split('.').pop() || '').toLowerCase();
          svc.addFile(id, { name: base, ext, size: f.size, srcPath: f.path });
        }
      } catch (e) {
        svc.rmDir(id);
        db.prepare('DELETE FROM batch_files WHERE batch_id = ?').run(id);
        db.prepare('DELETE FROM batch_jobs WHERE id = ?').run(id);
        return res.status(500).json({ error: '批次创建失败：' + e.message });
      }
      res.json(jobDetail(id));
    } finally {
      if (req._tmpDir) { try { fs.rmSync(req._tmpDir, { recursive: true, force: true }); } catch { /* 已移走 */ } }
    }
  });

  // ---- 从会话生成批次（用户拍板：v0.4.0 直接做）----
  r.post('/export', (req, res) => {
    const ids = Array.isArray((req.body || {}).conversation_ids)
      ? [...new Set(req.body.conversation_ids.map(Number).filter((x) => x > 0))].slice(0, svc.MAX_FILES)
      : [];
    if (!ids.length) return res.status(400).json({ error: '请选择至少一个会话' });
    const id = svc.createJob(req.user.id, 'text', { source: 'chat' });
    let n = 0;
    for (const cid of ids) {
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(cid, req.user.id);
      if (!conv) continue;
      const msgs = db.prepare('SELECT role, content FROM messages WHERE conv_id = ? ORDER BY id').all(cid);
      if (!msgs.length) continue;
      const text = `会话：${conv.title || ('#' + cid)}\r\n\r\n`
        + msgs.map((m) => `[${m.role === 'user' ? '我' : 'AI'}] ${m.content}`).join('\r\n\r\n') + '\r\n';
      const buf = Buffer.from(text, 'utf8');
      if (buf.length > svc.MAX_FILE) continue; // 单个会话超 20MB：跳过并计数
      svc.addFile(id, { name: (conv.title || ('会话' + cid)) + '.txt', ext: 'txt', size: buf.length, buf });
      n++;
    }
    if (!n) {
      db.prepare('DELETE FROM batch_jobs WHERE id = ?').run(id);
      return res.status(400).json({ error: '所选会话没有可导出的消息（或单会话超过 20MB）' });
    }
    res.json(jobDetail(id));
  });

  // ---- 列表：本人；管理员全部（含用户名）----
  r.get('/', (req, res) => {
    const size = [10, 20, 30, 50, 100].includes(Number(req.query.size)) ? Number(req.query.size) : 10;
    const page = Math.max(1, Number(req.query.page) || 1);
    const isAdmin = req.user.role === 'admin';
    const where = [];
    const args = [];
    if (!isAdmin || req.query.mine === '1') { where.push('j.user_id = ?'); args.push(req.user.id); }
    else if (req.query.uid && isAdmin) { where.push('j.user_id = ?'); args.push(Number(req.query.uid) || 0); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM batch_jobs j ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT j.*, u.username, u.display_name FROM batch_jobs j
      LEFT JOIN users u ON u.id = j.user_id ${w} ORDER BY j.id DESC LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size);
    res.json({ total, page, size, rows });
  });

  // ---- 详情 ----
  r.get('/:id', (req, res) => {
    if (!ownJob(req, res)) return;
    res.json(jobDetail(Number(req.params.id)));
  });

  // ---- 开始 / 重跑 ----
  r.post('/:id/run', (req, res) => {
    const j = ownJob(req, res); if (!j) return;
    if (j.status === 'running' || svc.isRunning(j.id)) return res.status(409).json({ error: '这个批次正在执行' });
    const pending = db.prepare("SELECT COUNT(*) AS c FROM batch_files WHERE batch_id = ? AND status IN ('pending','failed')").get(j.id).c;
    if (!pending) return res.status(400).json({ error: '没有待处理的文件（已全部完成）' });
    try {
      svc.startJob(j.id);
      res.json({ ok: true, status: 'running' });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  // ---- 查看单个文件（原文 / 脱敏全文，最多各 20 万字符）----
  r.get('/:id/file/:fid', (req, res) => {
    if (!ownJob(req, res)) return;
    const f = db.prepare('SELECT * FROM batch_files WHERE id = ? AND batch_id = ?').get(Number(req.params.fid), Number(req.params.id));
    if (!f) return res.status(404).json({ error: '文件不存在' });
    const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
    const raw = read(svc.rawTxtPath(f.batch_id, f.id));
    const masked = read(svc.outTxtPath(f.batch_id, f.id));
    const CAP = 200000;
    res.json({
      file: { id: f.id, name: f.name, status: f.status, error: f.error, chars: f.chars, match_count: f.match_count },
      raw: raw.slice(0, CAP), masked: masked.slice(0, CAP),
      truncated: raw.length > CAP || masked.length > CAP,
    });
  });

  // ---- 单文件下载：which=raw|masked ----
  r.get('/:id/file/:fid/download', (req, res) => {
    if (!ownJob(req, res)) return;
    const f = db.prepare('SELECT * FROM batch_files WHERE id = ? AND batch_id = ?').get(Number(req.params.fid), Number(req.params.id));
    if (!f) return res.status(404).json({ error: '文件不存在' });
    const which = req.query.which === 'masked' ? 'masked' : 'raw';
    const p = which === 'masked' ? svc.outTxtPath(f.batch_id, f.id) : svc.inPath(f.batch_id, f.id);
    if (!fs.existsSync(p)) return res.status(404).json({ error: which === 'masked' ? '这个文件还没有脱敏结果' : '原文件已被清理' });
    const name = which === 'masked' ? svc.sanitizeBase(f.name) + '.masked.txt' : f.name;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.sendFile(path.resolve(p));
  });

  // ---- 整包下载：脱敏文本 + mapping.csv + _errors.txt ----
  r.get('/:id/download', (req, res) => {
    const j = ownJob(req, res); if (!j) return;
    let zip;
    try { zip = svc.buildJobZip(j.id); } catch (e) { return res.status(500).json({ error: '打包失败：' + e.message }); }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('batch-' + j.id + '.zip')}`);
    res.send(zip);
  });

  // ---- 删除批次（内容 + 磁盘；历史记录保留）----
  r.delete('/:id', (req, res) => {
    const j = ownJob(req, res); if (!j) return;
    if (j.status === 'running' || svc.isRunning(j.id)) return res.status(409).json({ error: '批次正在执行，不能删除' });
    db.prepare("DELETE FROM mappings WHERE scope_type='batch' AND scope_id=?").run(j.id);
    db.prepare('DELETE FROM batch_files WHERE batch_id = ?').run(j.id);
    db.prepare('DELETE FROM batch_jobs WHERE id = ?').run(j.id);
    svc.rmDir(j.id);
    res.json({ ok: true });
  });

  return r;
};
