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

// 项目内自带运行时（scripts/engines-setup.mjs 首次启动铺好）：命令默认指向项目内路径，
// 不要求用户改 PATH，也不碰系统安装的 Java/Go。
const ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'vendor');
const IS_WIN = process.platform === 'win32';
const GODLP_BIN = path.join(VENDOR, 'godlp', IS_WIN ? 'godlp-cli.exe' : 'godlp-cli');
const JAVA_BIN = path.join(VENDOR, 'jdk', 'bin', IS_WIN ? 'java.exe' : 'java');
const SW_JAR = path.join(VENDOR, 'sensitive-word', 'sensitive-word-cli.jar');
const SW_CMD = `"${JAVA_BIN}" -cp "${SW_JAR}" local.mask.SensitiveWordCli`;

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
  // Presidio 中文自定义识别器 / scrubadub 原生类型 / OpenAI Privacy Filter 标签
  CN_PHONE: 'mobile', CN_ID_CARD: 'idcard', CN_BANK_CARD: 'bankcard',
  PERSON_NAME: 'person', TWITTER: 'nickname', SKYPE: 'nickname',
  PRIVATE_PERSON: 'person', OTHER_PERSON: 'person', PERSONAL_NAME: 'person', PERSONAL_HANDLE: 'nickname',
  PRIVATE_EMAIL: 'email', PERSONAL_EMAIL: 'email', OTHER_EMAIL: 'email',
  PRIVATE_PHONE: 'mobile', PERSONAL_PHONE: 'mobile', OTHER_PHONE: 'mobile',
  PRIVATE_ADDRESS: 'address', PERSONAL_LOCATION: 'address', OTHER_LOCATION: 'address',
  PRIVATE_DATE: 'birthday', PERSONAL_DATE: 'birthday', OTHER_DATE: 'birthday',
  PRIVATE_URL: 'url', PERSONAL_URL: 'url', OTHER_URL: 'url', SECRET_URL: 'url',
  ACCOUNT_NUMBER: 'bankcard', PERSONAL_FIN_ID: 'bankcard', PERSONAL_GOV_ID: 'idcard',
  PERSONAL_HEALTH_ID: 'idcard', PERSONAL_ORG: 'org',
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
    desc: 'Go 实现的数据脱敏 SDK。项目自带 CLI 包装（stdin 文本 → stdout 实体 JSON），首次启动自动编译到 vendor/godlp。',
    defCommand: `"${GODLP_BIN}"`,
  },
  {
    id: 'sensitive_word', name: 'sensitive-word', kind: 'stdio', hidden: false,
    vendor: 'houbb', home: 'https://github.com/houbb/sensitive-word', license: 'Apache-2.0',
    desc: 'Java 中文敏感词库（百万级词库，词组识别强）。项目自带 JDK 与 CLI 包装，首次启动自动构建 jar，无需系统装 Java。',
    defCommand: SW_CMD,
  },
  {
    id: 'presidio', name: 'Presidio', kind: 'sidecar', hidden: false,
    vendor: 'Microsoft', home: 'https://github.com/microsoft/presidio', license: 'MIT',
    desc: 'Python 脱敏框架（分析器+匿名化器，可插拔识别器）。依赖装在项目内 python/vendor，由 python/sidecar.py 承载，无需系统 pip 安装。',
  },
  {
    id: 'gliner', name: 'GLiNER-PII', kind: 'sidecar', hidden: false,
    vendor: 'knowledgator', home: 'https://huggingface.co/knowledgator/gliner-pii', license: 'Apache-2.0',
    desc: '通用信息抽取模型（零样本 NER，PII 专项微调，中英文均可）。模型已预取到 python/models/gliner_multi_pii-v1，纯本地推理。',
  },
  {
    id: 'argus', name: 'argus-redact', kind: 'sidecar', hidden: false,
    vendor: 'PyPI argus-redact', home: 'https://pypi.org/project/argus-redact/', license: '见 PyPI 页',
    desc: 'Python 脱敏库（fast 档：本地正则+词表，不联网）。依赖装在项目内 python/vendor，由 python/sidecar.py 承载。',
  },
  {
    id: 'scrubadub', name: 'scrubadub', kind: 'sidecar', hidden: false,
    vendor: 'LeapBeyond', home: 'https://github.com/LeapBeyond/scrubadub', license: 'MIT',
    desc: '文本 PII 清洗库：邮箱/电话/URL/信用卡等规则识别，输出实体与坐标。由 python/sidecar.py 承载。',
  },
  {
    id: 'opf', name: 'OpenAI Privacy Filter', kind: 'sidecar', hidden: false,
    vendor: 'OpenAI', home: 'https://huggingface.co/openai/privacy-filter', license: 'Apache-2.0',
    desc: '1.5B MoE token 分类模型，本地 CPU 推理；模型约 2.8GB，由项目内 python/models/opf 承载。',
  },
  {
    // 隐藏引擎：边车自带的自检伪引擎（无第三方依赖，固定回两个实体），
    // 用于离线验证 sidecar 适配器全链路 + 自检；UI 不显示。
    id: 'selftest', name: '边车自检引擎', kind: 'sidecar', hidden: true,
    vendor: '面具自带', home: '', license: 'MIT（本项目）',
    desc: 'python/sidecar.py 内置，返回固定实体，用于链路验证。',
  },

  // ---------- D:\脱敏 源码归档里的数据库 / 大数据 / 统计类工具 ----------
  // 这些工具靠连库、整表脱敏或差分隐私工作，**不产出文本实体坐标**，因此不参与
  // 「聊天/文档文本 → 实体 → 编码」管线；仅在设置页与致谢页如实列出并说明适用场景。
  {
    id: 'cloakdb', name: 'CloakDB', kind: 'tool', hidden: false, applicable: false, category: 'database',
    vendor: 'latryee', home: 'https://github.com/latryee/CloakDB', license: 'Apache-2.0',
    desc: '数据库匿名化/差分隐私：流式处理 SQL、CSV、Parquet，保持外键与校验位。不参与文本识别。',
    use: '给测试环境造一份脱敏数据库：直接吃 SQL 导出/CSV/Parquet，外键和校验位仍然对得上。',
  },
  {
    id: 'shardingsphere', name: 'Apache ShardingSphere', kind: 'tool', hidden: false, applicable: false, category: 'database',
    vendor: 'Apache', home: 'https://shardingsphere.apache.org', license: 'Apache-2.0',
    desc: '数据库中间件，在 SQL 路由层做字段加密/脱敏。需接入数据库，不参与文本识别。',
    use: '线上数据库中间件层统一加密/脱敏：应用不改代码，SQL 到库前按规则改写字段。',
  },
  {
    id: 'postgresql_anonymizer', name: 'postgresql_anonymizer', kind: 'tool', hidden: false, applicable: false, category: 'database',
    vendor: 'Dalibo', home: 'https://gitlab.com/dalibo/postgresql_anonymizer', license: 'PostgreSQL License',
    desc: 'PostgreSQL 扩展：用匿名化视图/规则脱敏整库。需数据库实例，不参与文本识别。',
    use: 'PostgreSQL 整库脱敏：装成扩展后建匿名化视图，导出/给第三方看之前整库替换。',
  },
  {
    id: 'pg_anonymize', name: 'pg_anonymize', kind: 'tool', hidden: false, applicable: false, category: 'database',
    vendor: 'rjuju', home: 'https://github.com/rjuju/pg_anonymize', license: 'PostgreSQL License',
    desc: 'PostgreSQL 逻辑复制脱敏插件。需数据库实例，不参与文本识别。',
    use: '持续把生产库同步到测试库时顺手脱敏：挂在逻辑复制链路上，不用每次导出一遍。',
  },
  {
    id: 'ranger', name: 'Apache Ranger', kind: 'tool', hidden: false, applicable: false, category: 'platform',
    vendor: 'Apache', home: 'https://ranger.apache.org', license: 'Apache-2.0',
    desc: 'Hadoop 生态数据权限与脱敏策略中心。需大数据平台，不参与文本识别。',
    use: 'Hive/HDFS 集群上按用户/角色配脱敏策略：谁能看明文、谁只能看掩码，由平台统一管。',
  },
  {
    id: 'arx', name: 'ARX', kind: 'tool', hidden: false, applicable: false, category: 'stats',
    vendor: 'arx-deidentifier', home: 'https://github.com/arx-deidentifier/arx', license: 'Apache-2.0',
    desc: '统计数据集匿名化（k-匿名、l-多样性、差分隐私）。面向表格数据，不参与文本识别。',
    use: '对外发布统计表格前做隐私保护：k-匿名/l-多样性/差分隐私，防止从表格反推个人。',
  },
  {
    id: 'sdcMicro', name: 'sdcMicro', kind: 'tool', hidden: false, applicable: false, category: 'stats',
    vendor: 'sdcTools', home: 'https://github.com/sdcTools/sdcMicro', license: 'GPL-2.0',
    desc: 'R 包：统计披露控制与微观数据匿名化。面向表格数据，不参与文本识别。',
    use: '统计调查微观数据发布（R 环境）：sdcMicro 做披露风险度量与匿名化。',
  },
  {
    id: 'jailer', name: 'Jailer', kind: 'tool', hidden: false, applicable: false, category: 'testdata',
    vendor: 'Wisser', home: 'https://github.com/Wisser/Jailer', license: 'Apache-2.0',
    desc: '数据库子集提取与测试数据生成/脱敏。需数据库实例，不参与文本识别。',
    use: '从生产库抽一小份「够用」的测试数据：按外键关系抽子集，生成/脱敏后给开发用。',
  },
  {
    id: 'anonimatron', name: 'anonimatron', kind: 'tool', hidden: false, applicable: false, category: 'testdata',
    vendor: 'realrolfje', home: 'https://github.com/realrolfje/anonimatron', license: 'Apache-2.0',
    desc: 'JDBC 数据库字段匿名化（Java CLI）。需数据库实例，不参与文本识别。',
    use: '任意 JDBC 数据库一次性字段清洗：配 YAML 指出哪些列怎么变，CLI 跑一遍。',
  },
];
const isApplicable = (e) => e.applicable !== false;
const BY_ID = new Map(ENGINES.map((e) => [e.id, e]));

// ---------- 配置（settings 表 mask_engines） ----------
// { mode:'primary'|'parallel', primary:'builtin', enabled:{id:bool}, commands:{id:cmd}, sidecar_url }
const DEFAULT_CFG = { mode: 'primary', primary: 'builtin', enabled: { builtin: true }, commands: {}, sidecar_url: 'http://127.0.0.1:9812' };

// 老配置自愈：本机回环地址 + 本系统自己的端口（默认 9909）绝不可能是边车——
// 那是本系统的 SPA 首页，探测只会报「响应异常（HTTP 200）」。读到就回落到默认 9812。
function normalizeSidecarUrl(raw) {
  const s = String(raw || DEFAULT_CFG.sidecar_url);
  try {
    const x = new URL(s);
    const local = ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'].includes(x.hostname);
    const port = Number(x.port || (x.protocol === 'https:' ? 443 : 80));
    if (local && port === Number(process.env.PORT || 9909)) return DEFAULT_CFG.sidecar_url;
  } catch { /* 格式不对原样返回，探测时报格式错 */ }
  return s;
}

function getCfg() {
  const saved = getSetting(CFG_KEY, null);
  if (!saved || typeof saved !== 'object') return { ...DEFAULT_CFG, enabled: { ...DEFAULT_CFG.enabled }, commands: {} };
  return {
    mode: saved.mode === 'parallel' ? 'parallel' : 'primary',
    primary: (BY_ID.has(saved.primary) && isApplicable(BY_ID.get(saved.primary))) ? saved.primary : 'builtin',
    enabled: { ...DEFAULT_CFG.enabled, ...(saved.enabled || {}) },
    commands: { ...(saved.commands || {}) },
    sidecar_url: normalizeSidecarUrl(saved.sidecar_url),
  };
}
function saveCfg(patch) {
  const cur = getCfg();
  const next = {
    mode: patch.mode === 'parallel' || patch.mode === 'primary' ? patch.mode : cur.mode,
    primary: (BY_ID.has(patch.primary) && isApplicable(BY_ID.get(patch.primary))) ? patch.primary : cur.primary,
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
  if (!isApplicable(e)) {
    return { ok: false, applicable: false, error: `${e.name} 是数据库/统计类脱敏工具，不参与聊天与文档的文本识别，无法探测文本引擎` };
  }
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
  if (!isApplicable(e)) throw new Error(`${e.name} 不参与文本识别（数据库/统计类工具）`);
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
  const usable = (id) => BY_ID.has(id) && isApplicable(BY_ID.get(id));
  if (cfg.mode === 'primary') return cfg.primary !== 'builtin' && usable(cfg.primary) ? [cfg.primary] : [];
  return Object.keys(cfg.enabled).filter((id) => id !== 'builtin' && cfg.enabled[id] && usable(id));
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
    applicable: isApplicable(e), category: e.category || 'text',
    vendor: e.vendor, home: e.home, license: e.license, desc: e.desc, use: e.use || '',
    command: e.kind === 'stdio' ? (cfg.commands[e.id] || e.defCommand || '') : '',
    enabled: !!cfg.enabled[e.id],
    last_probe: isApplicable(e) ? (probeCache[e.id] || null) : null,
  }));
}
function acknowledgements() {
  // 用户拍板（2026-10-20）：系统引用了就要致谢——全部外部引擎常驻列表，
  // 探测状态只是附加信息（可用/未探测/失败），不再决定是否出现在页面上
  return ENGINES.filter((e) => e.kind !== 'builtin' && !e.hidden)
    .map((e) => {
      const p = isApplicable(e) ? (probeCache[e.id] || null) : null;
      return {
        name: e.name, vendor: e.vendor, home: e.home, license: e.license, desc: e.desc,
        kind: e.kind, applicable: isApplicable(e), category: e.category || 'text',
        probe: p ? { ok: p.ok, at: p.at, error: p.error || '' } : null,
      };
    });
}

// ---------- 门面：业务侧统一入口（替代直接调 engine.encode） ----------
// 三种形态：主引擎=builtin → 零开销直通；主引擎=外部 → _extOnly 完全让位；并行 → 并集合并。
// 引擎失败如实上抛/带 stats，绝不静默当没配过。
const builtin = require('../engine');
async function runMask(text, cfg, persisted, seed) {
  const cfgAll = getCfg();
  const ids = activeExternalEngines();
  // seed：调用方已经确认过的实体（批量脱敏里「前几个文件学到的对照」），
  // 即使当前文件没有上下文也要按已知实体脱敏，否则跨文件同码只是口号。
  const seeds = Array.isArray(seed) ? seed : [];
  if (!ids.length) return builtin.encode(text, cfg, persisted, seeds);
  let extra = [];
  let stats = [];
  if (cfgAll.mode === 'primary') {
    // 单一外部主引擎：失败就如实抛错（没有兜底引擎在跑，不能假装脱敏成功）
    const ents = await detectWithEngine(ids[0], text);
    extra = seeds.concat(toCandidates(text, ents, ids[0]));
  } else {
    const r = await detectExternal(text);
    extra = seeds.concat(r.candidates);
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
