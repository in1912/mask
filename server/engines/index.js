'use strict';
// 多脱敏引擎架构（v0.3.0，需求 7+8）：内置规则引擎之外，接入外部本地引擎，统一候选协议。
//
// 统一接口：每个外部引擎最终产出实体数组 [{term, start, end, type}]（start/end 为 JS 字符串下标，
// term 必须等于 text.slice(start,end)——适配器里会校验，对不上就按 term 顺序重定位）。
// 实体 type 映射到内置规则 key（PERSON→person…），映射不到的用 'ext'（码前缀 EXT）。
// 之后与内置规则走**同一条 encode 管线**：对照表、编码风格、解码复原全部复用，零分叉。
//
// 三种接入形态：
//   builtin  现有 server/engine.js 的规则引擎（主引擎=它时零开销直通，不经过本层）
//   stdio    可配置命令行：文本走 stdin，stdout 回 {"entities":[...]} JSON（godlp / sensitive-word）
//   sidecar  本地 Python 边车 python/sidecar.py 的 HTTP 接口（Presidio / GLiNER-PII / argus-redact）
//
// 红线不动：所有引擎都在本机跑，原文不出网；引擎挂了/没装如实报错，绝不假装脱敏成功。
const fs = require('fs');
const path = require('path');
const { getSetting, setSetting } = require('../db');
const { runStdioEngine } = require('./stdioAdapter');
const { sidecarProbe, sidecarDetect } = require('./sidecarAdapter');

const CFG_KEY = 'mask_engines';

// ---------- 实体类型 → 内置规则 key ----------
const TYPE_MAP = {
  EMAIL: 'email', EMAIL_ADDRESS: 'email',
  PHONE: 'mobile', PHONE_NUMBER: 'mobile', CELL_PHONE: 'mobile', MOBILE: 'mobile', TEL: 'tel',
  PERSON: 'person', PEOPLE: 'person', NAME: 'person', NAME_CN: 'person',
  CREDIT_CARD: 'bankcard', CREDIT_CARD_NUMBER: 'bankcard', BANK_ACCOUNT: 'bankcard', BANK: 'bankcard',
  IP: 'ip', IP_ADDRESS: 'ip', URL: 'url', DOMAIN: 'url',
  ADDRESS: 'address', LOCATION: 'address', LOCATION_CN: 'address',
  ID: 'idcard', ID_CARD: 'idcard', NATIONAL_ID: 'idcard', IDENTITY: 'idcard', PASSPORT: 'passport',
  DATE_TIME: 'birthday', DATE_TIME_BIRTHDAY: 'birthday', BIRTHDAY: 'birthday', BIRTH: 'birthday',
  COMPANY: 'org', ORGANIZATION: 'org', ORG: 'org', DEPT: 'dept',
  WECHAT: 'wechat', QQ: 'qq', USERNAME: 'nickname', NICKNAME: 'nickname',
  MEDICAL: 'medical', AGE: 'number', AGE_CN: 'number', KEY: 'secretkey', SECRET: 'secretkey',
};

// ---------- 引擎注册表 ----------
// stdio 命令模板可用 {INPUT} 占位（不带占位符则文本走 stdin）；命令在设置页可改。
const ENGINES = [
  {
    id: 'builtin', name: '内置规则引擎', kind: 'builtin', hidden: false,
    vendor: '面具自带', home: '', license: 'MIT（本项目）',
    desc: '纯正则/锚定/词典/启发式规则，零依赖零外呼，默认引擎。人名四路识别（列表/锚定/称谓/引号）。',
  },
  {
    id: 'godlp', name: 'godlp', kind: 'stdio', hidden: false,
    vendor: '字节跳动 ByteDance', home: 'https://gitee.com/bytedance/godlp', license: 'Apache-2.0',
    desc: 'Go 实现的数据脱敏 SDK。需自行编译/安装 CLI，并让命令按「stdin 进文本、stdout 出 {"entities":[…]} JSON」工作（可用薄包装脚本转格式，见 README）。',
    defCommand: 'godlp',
  },
  {
    id: 'sensitive_word', name: 'sensitive-word', kind: 'stdio', hidden: false,
    vendor: 'houbb', home: 'https://github.com/houbb/sensitive-word', license: 'Apache-2.0',
    desc: 'Java 中文敏感词库（百万级词库，词组识别强）。需 JDK + CLI 包装（stdin 文本 → stdout 实体 JSON），命令在设置页配置。',
    defCommand: 'java -jar sensitive-word-cli.jar',
  },
  {
    id: 'presidio', name: 'Presidio', kind: 'sidecar', hidden: false,
    vendor: 'Microsoft', home: 'https://github.com/microsoft/presidio', license: 'MIT',
    desc: 'Python 脱敏框架（分析器+匿名化器，可插拔识别器）。pip install presidio-analyzer presidio-anonymizer spacy 后由 python/sidecar.py 承载。',
  },
  {
    id: 'gliner', name: 'GLiNER-PII', kind: 'sidecar', hidden: false,
    vendor: 'knowledgator', home: 'https://huggingface.co/knowledgator/gliner-pii', license: 'Apache-2.0',
    desc: '通用信息抽取模型（零样本 NER，PII 专项微调，中英文均可）。pip install gliner 后由 python/sidecar.py 承载，首次调用会下载模型（数百 MB，纯本地推理）。',
  },
  {
    id: 'argus', name: 'argus-redact', kind: 'sidecar', hidden: false,
    vendor: 'PyPI argus-redact', home: 'https://pypi.org/project/argus-redact/', license: '见 PyPI 页',
    desc: 'Python 脱敏库。pip install argus-redact 后由 python/sidecar.py 承载（未安装或 API 不兼容会如实报错）。',
  },
  {
    // 隐藏引擎：边车自带的自检伪引擎（无第三方依赖，固定回两个实体），
    // 用于离线验证 sidecar 适配器全链路 + 自检；UI 不显示。
    id: 'selftest', name: '边车自检引擎', kind: 'sidecar', hidden: true,
    vendor: '面具自带', home: '', license: 'MIT（本项目）',
    desc: 'python/sidecar.py 内置，返回固定实体，用于链路验证。',
  },
];
const BY_ID = new Map(ENGINES.map((e) => [e.id, e]));

// ---------- 配置（settings 表 mask_engines） ----------
// { mode:'primary'|'parallel', primary:'builtin', enabled:{id:bool}, commands:{id:cmd}, sidecar_url }
const DEFAULT_CFG = { mode: 'primary', primary: 'builtin', enabled: { builtin: true }, commands: {}, sidecar_url: 'http://127.0.0.1:9812' };
function getCfg() {
  const saved = getSetting(CFG_KEY, null);
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_CFG, enabled: { ...DEFAULT_CFG.enabled }, commands: {} };
  return {
    mode: saved.mode === 'parallel' ? 'parallel' : 'primary',
    primary: BY_ID.has(saved.primary) ? saved.primary : 'builtin',
    enabled: { ...DEFAULT_CFG.enabled, ...(saved.enabled || {}) },
    commands: { ...(saved.commands || {}) },
    sidecar_url: String(saved.sidecar_url || DEFAULT_CFG.sidecar_url),
  };
}
function saveCfg(patch) {
  const cur = getCfg();
  const next = {
    mode: patch.mode === 'parallel' || patch.mode === 'primary' ? patch.mode : cur.mode,
    primary: BY_ID.has(patch.primary) ? patch.primary : cur.primary,
    enabled: (patch.enabled && typeof patch.enabled === 'object') ? patch.enabled : cur.enabled,
    commands: (patch.commands && typeof patch.commands === 'object') ? patch.commands : cur.commands,
    sidecar_url: /^\S+$/.test(String(patch.sidecar_url || '')) ? String(patch.sidecar_url).trim() : cur.sidecar_url,
  };
  setSetting(CFG_KEY, next); // setSetting 内部已 JSON.stringify（存字符串会被 getCfg 当坏配置丢弃）
  return next;
}

// 探测结果缓存（内存 + settings 持久，致谢页用「最近一次探测成功」）
let probeCache = {};
try { probeCache = JSON.parse(getSetting('engines_probe') || '{}') || {}; } catch { probeCache = {}; }
function rememberProbe(id, ok, error) {
  probeCache[id] = { ok: !!ok, at: new Date().toISOString(), error: ok ? '' : String(error || '').slice(0, 300) };
  try { setSetting('engines_probe', probeCache); } catch { /* 展示层失败不炸主流程 */ }
}

// ---------- 探测 ----------
async function probeEngine(id) {
  const e = BY_ID.get(id);
  if (!e) return { ok: false, error: '没有这个引擎' };
  if (e.kind === 'builtin') { rememberProbe(id, true, ''); return { ok: true }; }
  try {
    if (e.kind === 'stdio') {
      const cmd = getCfg().commands[id] || e.defCommand;
      const r = await runStdioEngine(cmd, '探测样例：13812345678 test@example.com', 10000);
      rememberProbe(id, true, '');
      return { ok: true, sample_count: r.entities.length };
    }
    const r = await sidecarProbe(getCfg().sidecar_url, id);
    rememberProbe(id, r.ok, r.error);
    return r;
  } catch (err) {
    rememberProbe(id, false, err.message);
    return { ok: false, error: err.message };
  }
}

// ---------- 检测 ----------
async function detectWithEngine(id, text) {
  const e = BY_ID.get(id);
  if (!e || e.kind === 'builtin') return [];
  if (e.kind === 'stdio') {
    const cmd = getCfg().commands[id] || e.defCommand;
    const r = await runStdioEngine(cmd, text, 15000);
    return r.entities;
  }
  const r = await sidecarDetect(getCfg().sidecar_url, id, text); // 失败在适配器里抛，成功只回 {entities}
  return r.entities;
}

// 校准实体坐标：声明的 slice 对得上就用声明值；对不上按 term 从上次位置向后找（Python 偏移是码点，
// JS 是 UTF-16 单元，含 emoji 等增补平面字符时会有偏差——按内容重定位最稳）
function locateEntities(text, entities) {
  const out = [];
  let from = 0;
  for (const it of (entities || [])) {
    if (!it || typeof it.term !== 'string' || !it.term) continue;
    let start = Number(it.start), end = Number(it.end);
    if (!(start >= 0 && end > start && text.slice(start, end) === it.term)) {
      start = text.indexOf(it.term, from);
      if (start < 0) start = text.indexOf(it.term); // 乱序/错坐标实体回退全文找，别直接丢
      if (start < 0) continue;
      end = start + it.term.length;
    }
    from = Math.max(from, start + 1); // 游标只前进：重复实体按出现序落位，乱序实体重定位不拽回游标
    out.push({ term: it.term, start, end, type: String(it.type || '').toUpperCase() });
  }
  return out;
}

// 实体 → 内部候选（prio 61：高于内置启发式（20~46），低于最强正则锚（62）——外部 NER 在人名/地址
// 这类启发式区域应赢，但手机号/身份证这种确定性正则不输给外部引擎的模糊判断）
function toCandidates(text, entities, engineId) {
  const out = [];
  for (const it of locateEntities(text, entities)) {
    out.push({
      term: it.term, start: it.start, end: it.end,
      key: TYPE_MAP[it.type] || 'ext', prio: 61, ext_engine: engineId, ext_type: it.type,
    });
  }
  return out;
}

// 当前配置下需要外呼的引擎（builtin 直通不算）
function activeExternalEngines() {
  const cfg = getCfg();
  if (cfg.mode === 'primary') return cfg.primary !== 'builtin' ? [cfg.primary] : [];
  return Object.keys(cfg.enabled).filter((id) => id !== 'builtin' && cfg.enabled[id] && BY_ID.has(id));
}

// 并行调用 + 并集去重（重叠取长跨度；等长取先到）。单个引擎失败不拦整体，如实带回去。
async function detectExternal(text) {
  const ids = activeExternalEngines();
  if (!ids.length) return { candidates: [], stats: [] };
  const settled = await Promise.all(ids.map(async (id) => {
    try {
      const ents = await detectWithEngine(id, text);
      return { id, ok: true, count: ents.length, candidates: toCandidates(text, ents, id), error: '' };
    } catch (e) {
      return { id, ok: false, count: 0, candidates: [], error: e.message };
    }
  }));
  const merged = [];
  for (const s of settled) {
    for (const c of s.candidates) {
      const clash = merged.find((m) => m.start < c.end && c.start < m.end);
      if (!clash) merged.push(c);
      else if (c.end - c.start > clash.end - clash.start) merged[merged.indexOf(clash)] = c;
    }
  }
  merged.sort((a, b) => a.start - b.start);
  return { candidates: merged, stats: settled.map(({ id, ok, count, error }) => ({ id, ok, count, error })) };
}

// ---------- 对外汇总（设置页/致谢页） ----------
function engineList() {
  const cfg = getCfg();
  return ENGINES.map((e) => ({
    id: e.id, name: e.name, kind: e.kind, hidden: e.hidden,
    vendor: e.vendor, home: e.home, license: e.license, desc: e.desc,
    command: cfg.commands[e.id] || e.defCommand || '',
    enabled: !!cfg.enabled[e.id],
    last_probe: probeCache[e.id] || null,
  }));
}
function acknowledgements() {
  // 「成功配置」= 最近一次探测 ok 的外部引擎（含隐藏的自检引擎——它探测成功也说明边车链路通了）
  return ENGINES.filter((e) => e.kind !== 'builtin' && (probeCache[e.id] || {}).ok)
    .map((e) => ({ name: e.name, vendor: e.vendor, home: e.home, license: e.license, desc: e.desc, probe_at: probeCache[e.id].at }));
}

// ---------- 门面：业务侧统一入口（替代直接调 engine.encode） ----------
// 三种形态：主引擎=builtin → 零开销直通；主引擎=外部 → _extOnly 完全让位；并行 → 并集合并。
// 引擎失败如实上抛/带 stats，绝不静默当没配过。
const builtin = require('../engine');
async function runMask(text, cfg, persisted) {
  const cfgAll = getCfg();
  const ids = activeExternalEngines();
  if (!ids.length) return builtin.encode(text, cfg, persisted);
  let extra = [];
  let stats = [];
  if (cfgAll.mode === 'primary') {
    // 单一外部主引擎：失败就如实抛错（没有兜底引擎在跑，不能假装脱敏成功）
    const ents = await detectWithEngine(ids[0], text);
    extra = toCandidates(text, ents, ids[0]);
  } else {
    const r = await detectExternal(text);
    extra = r.candidates;
    stats = r.stats;
    const failed = stats.filter((s) => !s.ok);
    if (failed.length === ids.length && ids.length > 0) {
      throw new Error(`并行引擎全部失败：${failed.map((f) => `${f.id}(${f.error})`).join('；')}`);
    }
  }
  const conf = { ...(cfg || {}) };
  if (cfgAll.mode === 'primary') conf._extOnly = true;
  const out = builtin.encode(text, conf, persisted, extra);
  if (stats.length) out.engine_stats = stats;
  return out;
}

module.exports = {
  ENGINES, TYPE_MAP,
  getCfg, saveCfg, probeEngine, detectWithEngine, detectExternal, activeExternalEngines,
  engineList, acknowledgements, locateEntities, toCandidates, runMask,
};
