'use strict';
// 面具 mask — 服务入口：Express 单进程 + node:sqlite + 静态前端，端口 9909。
// 同端口 HTTP/HTTPS 自适应（0x16 嗅探，承教材方案）；升级接替 = 同端口重试抢回（承游巷方案）。
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const express = require('express');
const { db, DATA_DIR, getSetting } = require('./db');
const secret = require('./secret');
const loginlog = require('./loginlog');
const restartService = require('./services/restartService');
const engines = require('./engines');
const { ensureSidecar } = require('./sidecarLauncher');
const pkg = require('../package.json');

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
app.use('/api/upgrade', require('./routes/upgradeRoutes')); // 升级：router 内有 admin 二次闸
app.use('/api/ssl', require('./routes/sslRoutes'));         // 自签证书：同上
app.use('/api/engines', require('./routes/engineRoutes'));  // 多引擎管理/致谢：同上

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'mask', uptime: Math.round(process.uptime()) }));
app.get('/api/system-info', (req, res) => res.json({ name: '面具', version: pkg.version, beian: getSetting('beian', '') }));

// ---- 分享页（/s/:token 免登录，token 即凭证；必须在 SPA 兜底之前）----
app.get('/s/:token', pub.sharePage);

// 404 for unknown API
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---- 静态前端（hash 路由，只需 index.html）----
// 目录口径与 upgradeService 完全一致：自检会把仓库根指到临时副本，这里必须跟着环境变量走。
const UPGRADE_ROOT = process.env.MASK_UPGRADE_ROOT || path.join(__dirname, '..'); // server/ 的上一级 = 仓库根（多退一级会指到工作区 D:\cc，前端就找不到了）
const WEB_ROOT = process.env.MASK_WEB_ROOT || path.join(UPGRADE_ROOT, 'web');
const DIST_ROOT = path.join(WEB_ROOT, 'dist');
// 每请求现算最新时间戳目录（升级只换前端时不用重启）；排序口径 = 纯数字名字典序最大，
// 与 upgradeService.distDirs() 一字不差。没有时间戳目录时回落整块 dist（v0.2.0 及以前的安装形状）。
function latestDist() {
  try {
    const dirs = fs.readdirSync(DIST_ROOT).filter((n) => /^\d{8,}$/.test(n)
      && fs.statSync(path.join(DIST_ROOT, n)).isDirectory()).sort();
    if (dirs.length) {
      const p = path.join(DIST_ROOT, dirs[dirs.length - 1]);
      if (fs.existsSync(path.join(p, 'index.html'))) return p;
    }
  } catch { /* dist 不存在走下面的回落 */ }
  return fs.existsSync(path.join(DIST_ROOT, 'index.html')) ? DIST_ROOT : null;
}
const staticOpts = { index: 'index.html', maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } };
// 目录每请求现算（latestDist），升级只换前端时无需重启即生效
app.use((req, res, next) => {
  const d = latestDist();
  if (!d) return next();
  express.static(d, staticOpts)(req, res, next);
});
app.get(/^\/(?!api\/).*/, (req, res) => {
  const d = latestDist();
  if (d) res.sendFile(path.join(d, 'index.html'));
  else res.type('text/plain; charset=utf-8')
    .send('面具 mask 服务已在运行，但前端尚未构建：在 web/ 目录执行 npm install && npm run build');
});

// 统一错误出口（multer 超限给 400；升级包超限走 UpgradeError 413；express.raw 超限给 413）
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '附件超过 20MB 上限' });
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: `上传内容超过上限（约 ${(Number(err.limit) / 1048576).toFixed(0)}MB）`, code: 'TOO_LARGE' });
  }
  console.error('[mask]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ---- 启动 ----
const PORT = Number(process.env.PORT || 9909);

// 升级会重启服务：老进程退出、detached 子进程重试直到端口释放（Windows 没有 SO_REUSEPORT）。
// 接班子进程给足 24×500ms=12s 抢端口；普通启动只重试 2 次（开发机真撞端口时快速失败）。
const IS_CHILD = restartService.isChild();
const RETRY_LEFT = IS_CHILD ? 24 : 2;
const RETRY_EVERY = IS_CHILD ? 500 : 1000;

// HTTPS 证书（设置 → HTTPS 证书 生成/上传后放这里）。两个文件都在才启用 HTTPS。
const SSL_CERT = path.join(DATA_DIR, 'ssl', 'cert.pem');
const SSL_KEY = path.join(DATA_DIR, 'ssl', 'key.pem');

function listenLocal(srv) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

// 同一个端口同时接 HTTP 和 HTTPS：外层 net 服务器读第一个字节，
// 0x16（TLS handshake）走内层 https，其余走内层 http，两个内层都只听 127.0.0.1。
// 第一段数据必须在 net.connect 后立刻 write（连接建立前会自动排队），
// 否则 request body 前面几 KB（上传、大 POST）可能乱序。
async function createDualServer(certPem, keyPem) {
  const httpsInner = https.createServer({ cert: certPem, key: keyPem }, app);
  const httpInner = http.createServer(app);
  const [tcpPort, tlsPort] = await Promise.all([listenLocal(httpInner), listenLocal(httpsInner)]);
  const outer = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.once('data', (buf) => {
      const target = net.connect(buf[0] === 0x16 ? tlsPort : tcpPort, '127.0.0.1');
      target.on('error', () => socket.destroy());
      socket.on('error', () => target.destroy());
      target.write(buf); // 首段立即入队，保证字节顺序
      socket.pipe(target);
      target.pipe(socket);
    });
  });
  return { server: outer, inner: [httpInner, httpsInner], tls: true };
}

async function boot() {
  let left = RETRY_LEFT;
  let info = null;

  // 证书坏了不能让服务起不来：读失败就退回纯 HTTP，并在日志里说明。
  if (fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
    try {
      info = await createDualServer(fs.readFileSync(SSL_CERT), fs.readFileSync(SSL_KEY));
    } catch (e) {
      console.warn('[mask] data/ssl 下的证书无法加载，本次以纯 HTTP 启动：', e.message);
    }
  }
  const server = info ? info.server : http.createServer(app);

  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && --left > 0) {
      console.log(`[mask] 端口 ${PORT} 被占用（多半是上一个进程还没退干净），${RETRY_EVERY}ms 后重试，还剩 ${left} 次`);
      return setTimeout(() => { server.listen(PORT, '0.0.0.0'); }, RETRY_EVERY);
    }
    console.error('[mask] 监听失败：', err.code || '', err.message);
    restartService.writeFatal(err);
    process.exit(3);
  };
  server.on('error', onError);
  server.listen(PORT, '0.0.0.0', () => {
    server.off('error', onError);
    const pending = restartService.readPending();
    // 一次没完成交接的重启会留下 restart_pending=true。现在这个进程不是那次交接拉起来的，
    // 就把话说出来，别让那次升级看起来成功了（接替进程自己要靠这个标记判断在接班，所以有 !IS_CHILD）。
    if (pending && pending.restart_pending && !IS_CHILD) {
      const what = pending.reason || '升级';
      const ver = pending.from_version || pending.to_version
        ? `（v${pending.from_version || '?'} → v${pending.to_version || '?'}）` : '';
      console.warn(`[mask] 上次${what}${ver}的重启没有完成交接；`
        + `如果行为异常，把 ${pending.backup_dir || 'data/upgrades/backup_*'} 里的文件拷回安装目录再启动`);
    }
    restartService.clearPending();

    // 外部引擎边车：本机地址且没在跑就自动拉起（MASK_NO_SIDECAR=1 时跳过）。
    // 不 await：拉不起来也只是外部引擎不可用，主服务照常。
    ensureSidecar(() => engines.getCfg().sidecar_url)
      .catch((e) => console.warn('[sidecar] 自动拉起异常：', e.message));

    if (info && info.tls) {
      console.log(`[mask] 面具 AI 脱敏系统 v${pkg.version} 已启动：HTTP/HTTPS 同端口自适应 :${PORT}（证书 ${SSL_CERT}）`);
    } else {
      console.log(`[mask] 面具 AI 脱敏系统 v${pkg.version} 已启动：http://127.0.0.1:${PORT}（数据目录 ${DATA_DIR}）`);
      if (fs.existsSync(SSL_CERT)) console.log('[mask] 提示：data/ssl 的证书没能启用，当前只有 HTTP');
    }
  });
}

boot();
