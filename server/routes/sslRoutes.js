// 设置 → HTTPS 证书（自签名，承教材方案）：状态 / 生成 / 下载 / 上传替换 / 重启生效。
// 全部接口要求管理员（r.use 二次闸，与升级路由同款）。证书是全局资源（index.js 启动时读
// <data>/ssl），与用户数据隔离无关。
//
// 上传走 JSON（{ cert, key } 两段 PEM 文本）而不是 multipart：前端用 File.text() 读出来即可。
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const ssl = require('../ssl');
const restart = require('../services/restartService');

const MAX_PEM = 1024 * 1024; // 单文件 1MB 足够放任何 PEM

const router = express.Router();
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '证书管理仅管理员' });
  next();
});

// 当前证书状态（起止日期/剩余天数/SAN/密钥匹配/待重启标记）
router.get('/status', (req, res) => {
  try { res.json(ssl.status()); } catch (e) { res.status(500).json({ error: 'ssl_status_failed', message: e.message }); }
});

// 生成新证书并替换（旧证书自动备份到 ssl/backup-<时间戳>/），重启后生效
router.post('/generate', (req, res) => {
  try {
    const b = req.body || {};
    const r = ssl.generateCert({ cn: b.cn, org: b.org, san: b.san, days: b.days });
    ssl.writePair(r.certPem, r.keyPem);
    console.log(`[ssl] 管理员 ${req.user.username} 生成了新自签名证书（CN=${b.cn}，${r.days} 天，SAN: ${[...r.dnsList, ...r.ipList].join(', ')}），重启服务后生效`);
    res.json({ ok: true, days: r.days, dns: r.dnsList, ips: r.ipList, status: ssl.status() });
  } catch (e) {
    res.status(400).json({ error: 'ssl_generate_failed', message: e.message });
  }
});

// 证书下载（可分发到各设备做信任导入）
router.get('/file/cert', (req, res) => {
  if (!fs.existsSync(ssl.CERT_PATH)) return res.status(404).json({ error: 'not_found', message: '证书文件不存在（尚未生成）' });
  res.setHeader('Content-Disposition', 'attachment; filename="cert.pem"');
  res.type('application/x-pem-file').send(fs.readFileSync(ssl.CERT_PATH, 'utf8'));
});
// 私钥下载（敏感：仅备份用途，切勿分发）
router.get('/file/key', (req, res) => {
  if (!fs.existsSync(ssl.KEY_PATH)) return res.status(404).json({ error: 'not_found', message: '私钥文件不存在（尚未生成）' });
  res.setHeader('Content-Disposition', 'attachment; filename="key.pem"');
  res.type('application/x-pem-file').send(fs.readFileSync(ssl.KEY_PATH, 'utf8'));
});

// 上传替换（外部工具生成的证书+私钥，需成对且公钥匹配）
router.post('/upload', (req, res) => {
  const b = req.body || {};
  const certPem = typeof b.cert === 'string' ? b.cert : '';
  const keyPem = typeof b.key === 'string' ? b.key : '';
  if (!certPem.trim() || !keyPem.trim()) {
    return res.status(400).json({ error: 'missing', message: '请同时提供 cert.pem 与 key.pem 两个文件' });
  }
  if (certPem.length > MAX_PEM || keyPem.length > MAX_PEM) {
    return res.status(413).json({ error: 'too_large', message: '文件太大（单个 PEM 上限 1MB）' });
  }
  try {
    const c = new crypto.X509Certificate(certPem); // 格式不对在此抛错
    if (!ssl.pubKeyMatch(c, keyPem)) {
      return res.status(400).json({ error: 'mismatch', message: '证书与私钥不匹配（两者公钥不一致）' });
    }
    ssl.writePair(certPem, keyPem);
    console.log(`[ssl] 管理员 ${req.user.username} 上传替换了证书（CN=${(c.subject || '').slice(0, 60)}），重启服务后生效`);
    res.json({ ok: true, status: ssl.status() });
  } catch (e) {
    res.status(400).json({ error: 'bad_pem', message: '证书/私钥解析失败：' + e.message });
  }
});

// 重启服务让新证书生效：发完响应再交接（与升级重启同一条路）
router.post('/restart', (req, res) => {
  if (restart.isSuppressed()) {
    return res.json({
      ok: true, restart: 'suppressed',
      note: 'MASK_NO_RESTART=1：进程没有重启（自检/调试模式），手动重启后新证书才生效',
    });
  }
  if (req.body && req.body.restart === false) {
    return res.json({ ok: true, restart: 'skipped', note: '测试探针：只验权限与响应，没有重启' });
  }
  console.log(`[ssl] 管理员 ${req.user.username} 请求重启服务以应用新证书`);
  res.json({ ok: true, restart: 'scheduled', note: '1~3 秒后服务重启，稍等后刷新页面' });
  res.on('finish', () => {
    try { restart.scheduleRestart({ reason: 'HTTPS 证书' }); } catch (e) { console.error('[ssl] 重启失败', e); }
  });
});

module.exports = router;
