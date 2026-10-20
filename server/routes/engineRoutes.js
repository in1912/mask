// 设置 → 脱敏引擎（v0.3.0 多引擎架构）：注册表/配置/探测/试跑 + 致谢。
// 全部接口要求管理员（r.use 二次闸，与升级/SSL 路由同款）。试跑只回实体与码预览，
// 不落库、不产生对照——探测用的样例文本不进日志。
const express = require('express');
const engines = require('../engines');
const { toCandidates } = engines;

const router = express.Router();
router.use((req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '引擎管理仅管理员' });
  next();
});

// 引擎注册表 + 当前配置 + 最近探测结果（设置页「引擎」tab 数据源）
router.get('/', (req, res) => {
  res.json({ config: engines.getCfg(), engines: engines.engineList() });
});

// 致谢：最近一次探测成功的引擎（名称/厂商/仓库/许可证/探测时间）
router.get('/ack', (req, res) => {
  res.json({ items: engines.acknowledgements() });
});

// 探测单个引擎（真实调用一次，成功才进致谢）
router.post('/probe', async (req, res) => {
  const id = String((req.body || {}).id || '');
  const r = await engines.probeEngine(id);
  console.log(`[engines] 管理员 ${req.user.username} 探测 ${id} → ${r.ok ? '可用' : '失败：' + (r.error || '')}`);
  res.json(r);
});

const APP_PORT = Number(process.env.PORT || 9909);

// 边车地址校验：用户最容易把本系统自己的 9909 填进来（回的是 SPA 首页 HTML，探测只剩「响应异常 HTTP 200」）
function sidecarUrlError(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const u = String(raw).trim();
  if (!/^https?:\/\/\S+$/i.test(u)) return '边车地址格式不对（要 http://主机:端口，如 http://127.0.0.1:9812）';
  let x;
  try { x = new URL(u); } catch { return '边车地址解析失败（要 http://主机:端口，如 http://127.0.0.1:9812）'; }
  const local = ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'].includes(x.hostname);
  const port = Number(x.port || (x.protocol === 'https:' ? 443 : 80));
  if (local && port === APP_PORT) {
    return `边车地址是本系统自己的端口 ${APP_PORT}——那会把本系统的网页当成边车。边车是独立的 Python 进程，默认 http://127.0.0.1:9812`;
  }
  return '';
}

// 保存配置：{ mode, primary, enabled, commands, sidecar_url }
// primary 必须是注册过的引擎；mode 只认 primary|parallel；命令做长度与换行约束（防塞脚本捣乱）
router.put('/config', (req, res) => {
  const b = req.body || {};
  for (const [id, cmd] of Object.entries(b.commands || {})) {
    if (typeof cmd !== 'string' || cmd.length > 300 || /[\r\n]/.test(cmd)) {
      return res.status(400).json({ error: '命令格式不对（≤300 字符、单行）', engine: id });
    }
  }
  const urlErr = sidecarUrlError(b.sidecar_url);
  if (urlErr) return res.status(400).json({ error: urlErr });
  const enabled = {};
  for (const [id, v] of Object.entries(b.enabled || {})) {
    if (typeof v === 'boolean') enabled[id] = v;
  }
  if (b.mode === 'primary' && b.primary && !engines.ENGINES.some((e) => e.id === b.primary)) {
    return res.status(400).json({ error: '主引擎不存在', primary: b.primary });
  }
  const saved = engines.saveCfg({ mode: b.mode, primary: b.primary, enabled, commands: b.commands, sidecar_url: b.sidecar_url });
  console.log(`[engines] 管理员 ${req.user.username} 更新引擎配置（mode=${saved.mode}, primary=${saved.primary}）`);
  res.json({ ok: true, config: saved });
});

// 单引擎试跑（不落库）：回原始实体 + 映射后的候选预览
router.post('/test', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  const text = String(b.text || '').slice(0, 20000);
  if (!text.trim()) return res.status(400).json({ error: '试跑文本不能为空' });
  try {
    const ents = await engines.detectWithEngine(id, text);
    res.json({ ok: true, entities: ents, candidates: toCandidates(text, ents, id) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
