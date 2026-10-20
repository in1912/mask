'use strict';
// 面具 mask — 服务入口：Express 单进程 + node:sqlite + 静态前端，端口 9909
const path = require('path');
const fs = require('fs');
const express = require('express');
const { db, getSetting } = require('./db');
const secret = require('./secret');
const loginlog = require('./loginlog');
const pkg = require('../package.json');

const DATA_DIR = require('./db').DATA_DIR;
const aesKey = secret.loadSecretKey(DATA_DIR);
const ll = loginlog(aesKey);
const ctx = { loginlog: ll, aesKey };

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));

// ---- 全站第一道闸：IP 黑名单（承工作台 ipBanService 语义）----
app.use((req, res, next) => {
  req.clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ll.isBlocked(req.clientIp)) return res.status(403).json({ error: 'IP 已被封禁' });
  next();
});

// ---- 免登录白名单（注意：挂载在 /api 下的中间件里 req.path 已去掉 /api 前缀）----
const EXEMPT = ['/auth/login', '/health', '/system-info', '/pub'];

app.use('/api', (req, res, next) => {
  if (EXEMPT.some((e) => req.path === e || req.path.startsWith(e + '/'))) return next();
  let token = '';
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && req.headers.cookie) {
    const m = /(?:^|;\s*)mask_token=([^;]+)/.exec(req.headers.cookie);
    if (m) token = m[1];
  }
  if (!token && req.query.token) token = String(req.query.token);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const row = db.prepare(`SELECT s.token, s.expires_at, u.id, u.username, u.role, u.display_name, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || row.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (row.status !== 'active') return res.status(403).json({ error: '账号已停用' });
  req.token = row.token;
  req.user = { id: row.id, username: row.username, role: row.role, display_name: row.display_name };
  next();
});

// ---- 业务路由 ----
app.use('/api/auth', require('./routes/authRoutes')(ctx));
app.use('/api', require('./routes/adminRoutes')(ctx));
const mask = require('./routes/maskRoutes')();
app.use('/api', mask.router);
app.use('/api', require('./routes/chatRoutes')(ctx));
app.use('/api', require('./routes/fileRoutes')(ctx).router);
app.use('/api', require('./routes/agentRoutes')().router);
const pub = require('./routes/pubRoutes');
app.use('/api', pub.router); // /pub 前缀在 EXEMPT 免登录名单里

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'mask', uptime: Math.round(process.uptime()) }));
app.get('/api/system-info', (req, res) => res.json({ name: '面具', version: pkg.version, beian: getSetting('beian', '') }));

// ---- 分享页（/s/:token 免登录，token 即凭证；必须在 SPA 兜底之前）----
app.get('/s/:token', pub.sharePage);

// 404 for unknown API
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---- 静态前端（hash 路由，只需 index.html）----
const DIST = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST, { index: 'index.html', maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text/plain; charset=utf-8')
    .send('面具 mask 服务已在运行，但前端尚未构建：在 web/ 目录执行 npm install && npm run build'));
}

// 统一错误出口（multer 超限等给 400）
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '附件超过 20MB 上限' });
  console.error('[mask]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

const PORT = Number(process.env.PORT || 9909);
let tries = 0;
function listen(port) {
  const srv = app.listen(port, () => {
    console.log(`[mask] 面具 AI 脱敏系统 v${pkg.version} 已启动：http://127.0.0.1:${port}（数据目录 ${DATA_DIR}）`);
    if (port !== PORT) console.log(`[mask] 注意：默认端口 ${PORT} 被占用，本次使用 ${port}`);
  });
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) { tries++; listen(port + 1); }
    else { console.error('[mask] 启动失败', e.message); process.exit(1); }
  });
}
listen(PORT);
