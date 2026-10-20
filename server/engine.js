'use strict';
// 《面具》脱敏引擎 — 四条设计红线（承工作台 v1.13.0，写死不改）：
// ① 纯规则、不调 AI、不联网——识别阶段绝不把原文发给任何模型
// ② 同一实体在同一会话/文档内同码（调用方持久化对照表，跨轮传入）
// ③ 替换按词长降序，防止「张三丰」被「张三」吃掉一半
// ④ 总开关关闭时如实返回 skipped，绝不假装脱敏
const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 字符，去 0/1/I/O
const MAX_ITEMS = 600;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 锚定取值字符类：故意不用 \S，防吞后半句（承工作台 pwd 教训）
const V = "[^\\s,，;；、。．:：!！?？（）()\\[\\]【】「」《》\"'<>@`|]";

// ---------------------------------------------------------------------------
// 规则定义。cat: pii 个人隐私 | ent 企业业务 | tech 技术系统 | meta 隐藏元数据（提取层处理）
// method 标注仅用于前端如实展示：regex 正则 | anchor 锚定 | luhn 校验 | heuristic 启发式 | dict 词典
// ---------------------------------------------------------------------------

const SUR = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董潘袁蔡蒋余于杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
const TITLE = '(?:先生|女士|老师|教授|医生|工程师|经理|总监|主管|科长|部长|董事长|总经理|律师|会计师|分析师|设计师|总|工)';

const ORG_SUFFIX = '有限公司|有限责任公司|股份有限公司|集团|银行|证券|保险公司|医院|学校|大学|学院|研究院|研究所|事务所|工作室|合作社';
const DEPT_SUFFIX = '事业部|分公司|子公司|部门|委员会|办公室|中心|科室|工作组|项目组';
const LEFT_TRIM = ['我们的', '你们', '他们的', '客户是', '甲方是', '乙方是', '公司是', '供应商是', '来自', '属于', '位于', '叫做', '名为', '以及', '还有', '和', '与', '及', '或', '由', '在', '是', '的'].sort((a, b) => b.length - a.length);
const GENERIC_LEFT = new Set(['很多', '这些', '那些', '各个', '每个', '某个', '部分', '各', '每', '本', '该', '全']);

// 公司/部门名字字符类：[一-龥] 挖掉连接字 与(4E0E)/及(53CA)/和(548C)/或(6216)，
// 否则「A公司与B公司」会被连成一个词元（check F2/H6 抓出的真 bug）
const NAME_CLS = '\\u4e00-\\u4e0d\\u4e0f-\\u53c9\\u53cb-\\u548b\\u548d-\\u6215\\u6217-\\u9fa5A-Za-z0-9·';

const AMT_NUM = '((?:人民币|RMB|CNY|￥|¥)?\\s?[0-9][0-9,，]*(?:\\.[0-9]+)?\\s?(?:万?元|万元|块)?)';

function trimLeftNoise(name) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of LEFT_TRIM) {
      if (name.startsWith(t) && name.length - t.length >= 2) { name = name.slice(t.length); changed = true; break; }
    }
  }
  return name;
}

// 通用扫描器
function scanRe(source, flags, pick) {
  return (text) => {
    const out = [];
    const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const term = pick ? pick(m) : m[0];
      if (term && term.length) out.push({ term, start: m.index + m[0].indexOf(term), end: m.index + m[0].indexOf(term) + term.length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
  };
}

// 锚定：关键词留在原文里，只取后面的值（pick=m[1]）
function anchorScan(kw, valSource, flags = 'gi') {
  return scanRe(`(?:${kw})[ \\t]*(?:是|为|[:：])?[ \\t]*(${valSource})`, flags, (m) => m[1]);
}

function luhnOk(s) {
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

const RULES = [
  // ---- 个人隐私 pii ----
  { key: 'idcard', zh: '身份证', en: 'ID', cat: 'pii', prio: 62, method: 'regex', scan: scanRe('(?<!\\d)[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx](?!\\d)', 'g') },
  { key: 'passport', zh: '护照', en: 'PASS', cat: 'pii', prio: 58, method: 'anchor', scan: anchorScan('护照(?:号码|号)?', '[A-Za-z]{0,2}\\d{8}(?!\\d)') },
  { key: 'hmt', zh: '通行证', en: 'HMT', cat: 'pii', prio: 58, method: 'anchor', scan: anchorScan('(?:港澳通行证|通行证)(?:号码|号)?', '[HMhm]\\d{8,10}(?!\\d)') },
  { key: 'driver', zh: '驾驶证', en: 'DRV', cat: 'pii', prio: 58, method: 'anchor', scan: anchorScan('驾驶证(?:号|号码)?', '\\d{12}(?!\\d)') },
  { key: 'mobile', zh: '手机号', en: 'PHONE', cat: 'pii', prio: 62, method: 'regex', scan: scanRe('(?<!\\d)1[3-9]\\d{9}(?!\\d)', 'g') },
  { key: 'tel', zh: '固话', en: 'TEL', cat: 'pii', prio: 56, method: 'regex', scan: scanRe('(?<!\\d)0\\d{2,3}-\\d{7,8}(?!\\d)', 'g') },
  { key: 'bankcard', zh: '银行卡', en: 'BANK', cat: 'pii', prio: 62, method: 'luhn', scan: (text) => { const out = []; const re = /(?<!\d)\d{13,19}(?!\d)/g; let m; while ((m = re.exec(text)) !== null) { if (luhnOk(m[0])) out.push({ term: m[0], start: m.index, end: m.index + m[0].length }); } return out; } },
  { key: 'payacct', zh: '支付账号', en: 'PAY', cat: 'pii', prio: 58, method: 'anchor', scan: anchorScan('(?:支付宝账号|支付宝帐号|支付账号|支付帐号|收款账号)', `${V}{6,30}`) },
  { key: 'person', zh: '人名', en: 'PER', cat: 'pii', prio: 20, method: 'heuristic', hint: '姓氏+称谓/引号启发式，可能漏或误', scan: (text) => {
    const out = [];
    const reT = new RegExp(`[${SUR}][一-龥]{0,2}${TITLE}(?![结体归功能谋])`, 'g');
    let m;
    while ((m = reT.exec(text)) !== null) out.push({ term: m[0], start: m.index, end: m.index + m[0].length });
    const reQ = new RegExp(`[「『“"‘']([${SUR}][一-龥]{1,3})[」』”"’']`, 'g');
    while ((m = reQ.exec(text)) !== null) out.push({ term: m[1], start: m.index + 1, end: m.index + 1 + m[1].length });
    return out;
  } },
  { key: 'nickname', zh: '昵称', en: 'NICK', cat: 'pii', prio: 42, method: 'anchor', scan: anchorScan('(?:昵称|网名|花名)', `${V}{2,30}`) },
  { key: 'email', zh: '邮箱', en: 'MAIL', cat: 'pii', prio: 62, method: 'regex', scan: scanRe('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', 'g') },
  { key: 'wechat', zh: '微信', en: 'WX', cat: 'pii', prio: 50, method: 'anchor', scan: anchorScan('(?:微信号|微信ID)', '[A-Za-z][A-Za-z0-9_-]{5,19}') },
  { key: 'qq', zh: 'QQ', en: 'QQ', cat: 'pii', prio: 50, method: 'anchor', scan: anchorScan('(?:QQ|qq|扣扣)(?:号|群)?', '[1-9]\\d{4,10}(?!\\d)') },
  { key: 'address', zh: '地址', en: 'ADDR', cat: 'pii', prio: 44, method: 'heuristic', hint: '路/街/巷+门牌特征，启发式', scan: scanRe('[一-龥A-Za-z0-9]{2,20}(?:路|街|大道|巷|道)\\s?[0-9一二三四五六七八九十]{1,6}号(?:[0-9]{1,5}(?:栋|幢|室|单元|楼层))?', 'g') },
  { key: 'birthday', zh: '生日', en: 'BIRTH', cat: 'pii', prio: 42, method: 'anchor', scan: anchorScan('(?:生日|出生日期|出生于|出生)', '(?:19|20)\\d{2}\\s*[年/.-]\\s*\\d{1,2}\\s*[月/.-]\\s*\\d{1,2}\\s*日?', '') },
  { key: 'medical', zh: '病历', en: 'MED', cat: 'pii', prio: 38, method: 'anchor', scan: anchorScan('(?:病历号|门诊号|住院号|体检编号|诊断证明书?号?)', `${V}{4,24}`) },
  { key: 'biometric', zh: '生物', en: 'BIO', cat: 'pii', prio: 38, method: 'dict', scan: scanRe('(?:人脸|指纹|虹膜|声纹)(?:数据|图像|照片|信息|模板|采集样本?)', 'g') },
  { key: 'social', zh: '社保', en: 'SSI', cat: 'pii', prio: 52, method: 'anchor', scan: anchorScan('(?:社保号|社保编号|社会保障号(?:码)?)', `${V}{6,20}`) },
  { key: 'fund', zh: '公积金', en: 'FUND', cat: 'pii', prio: 52, method: 'anchor', scan: anchorScan('公积金(?:账号|帐号|编号|号)?', `${V}{6,20}`) },
  // ---- 企业业务 ent ----
  { key: 'customer', zh: '客户', en: 'CUS', cat: 'ent', prio: 46, method: 'anchor', scan: anchorScan('(?:客户名称|客户全称|客户名为|甲方名称|甲方全称)', `${V}{2,40}`) },
  { key: 'supplier', zh: '供应商', en: 'SUP', cat: 'ent', prio: 46, method: 'anchor', scan: anchorScan('(?:供应商(?:名称|全称)?|乙方名称|乙方全称|供货方)', `${V}{2,40}`) },
  { key: 'contact', zh: '联系人', en: 'CON', cat: 'ent', prio: 42, method: 'anchor', scan: anchorScan('(?:联系人|对接人|负责人|经办人)', '[一-龥·]{2,4}') },
  { key: 'quote', zh: '报价', en: 'QTE', cat: 'ent', prio: 40, method: 'anchor', amount: true, scan: scanRe(`(?:报价|单价)(?:约|为|是|[:：])?\\s*${AMT_NUM}`, 'g', (m) => m[1]) },
  { key: 'amount', zh: '金额', en: 'AMT', cat: 'ent', prio: 40, method: 'anchor', amount: true, scan: scanRe(`(?:合同金额|总金额|金额|货款|定金|尾款|总价)(?:约|为|是|[:：])?\\s*${AMT_NUM}`, 'g', (m) => m[1]) },
  { key: 'payment', zh: '回款', en: 'PAYR', cat: 'ent', prio: 40, method: 'anchor', amount: true, scan: scanRe(`(?:回款(?:金额)?|已回款|收款)(?:约|为|是|[:：])?\\s*${AMT_NUM}`, 'g', (m) => m[1]) },
  { key: 'salary', zh: '薪资', en: 'SAL', cat: 'ent', prio: 40, method: 'anchor', amount: true, scan: scanRe(`(?:薪资|月薪|年薪|工资|薪水|报酬)(?:约|为|是|[:：])?\\s*${AMT_NUM}`, 'g', (m) => m[1]) },
  { key: 'project', zh: '项目', en: 'PRJ', cat: 'ent', prio: 46, method: 'anchor', scan: anchorScan('(?:项目名称|项目名|项目代号|内部代号|代号)', `${V}{2,40}`) },
  { key: 'plan', zh: '方案', en: 'PLAN', cat: 'ent', prio: 36, method: 'dict', hint: '词典级匹配，语义类条目无确定性识别', scan: scanRe('(?:未公开的?产品方案|内部方案|产品规划|产品路线图)', 'g') },
  { key: 'pricing', zh: '定价', en: 'PRICE', cat: 'ent', prio: 36, method: 'dict', hint: '词典级，只认关键词本身', scan: scanRe('(?:定价策略|价格策略|底价策略)', 'g') },
  { key: 'order', zh: '订单', en: 'ORD', cat: 'ent', prio: 54, method: 'anchor', scan: anchorScan('(?:订单号|订单编号|运单号|单号)', '[A-Za-z0-9-]{6,32}') },
  { key: 'custno', zh: '客户编号', en: 'CUSNO', cat: 'ent', prio: 54, method: 'anchor', scan: anchorScan('(?:客户编号|客户号|会员号|会员编号)', '[A-Za-z0-9-]{4,32}') },
  { key: 'clause', zh: '条款', en: 'CLAUSE', cat: 'ent', prio: 36, method: 'dict', hint: '词典级，涉密条款语义无法穷举', scan: scanRe('(?:保密条款|排他条款|独家条款|保密期限|涉密等级)', 'g') },
  { key: 'perf', zh: '绩效', en: 'PERF', cat: 'ent', prio: 38, method: 'anchor', scan: anchorScan('(?:绩效分|绩效得分|考核结果|KPI得分?)', `${V}{1,20}`) },
  { key: 'org', zh: '公司', en: 'ORG', cat: 'ent', prio: 46, method: 'heuristic', hint: '公司后缀词锚定，左侧截断虚词', scan: (text) => {
    const out = [];
    const re = new RegExp(`([${NAME_CLS}]{2,24})(${ORG_SUFFIX})`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = trimLeftNoise(m[1]);
      if (name.length < 2) continue;
      const start = m.index + (m[1].length - name.length);
      out.push({ term: name + m[2], start, end: m.index + m[0].length });
    }
    return out;
  } },
  { key: 'dept', zh: '部门', en: 'ORG', cat: 'ent', prio: 44, method: 'heuristic', hint: '部门后缀词锚定', scan: (text) => {
    const out = [];
    const re = new RegExp(`([${NAME_CLS}]{2,16})(${DEPT_SUFFIX})`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = trimLeftNoise(m[1]);
      if (name.length < 2 || GENERIC_LEFT.has(name)) continue;
      const start = m.index + (m[1].length - name.length);
      out.push({ term: name + m[2], start, end: m.index + m[0].length });
    }
    return out;
  } },
  { key: 'empno', zh: '工号', en: 'EMP', cat: 'ent', prio: 54, method: 'anchor', scan: anchorScan('(?:工号|员工编号|工牌号)', '[A-Za-z0-9-]{3,20}(?![0-9])') },
  { key: 'negotiation', zh: '谈判', en: 'NEG', cat: 'ent', prio: 34, method: 'dict', hint: '词典级', scan: scanRe('(?:谈判底线|心理价位|让步空间|最低接受价)[^\\n，。；]{0,30}', 'g') },
  { key: 'bid', zh: '投标', en: 'BID', cat: 'ent', prio: 34, method: 'dict', hint: '词典级', scan: scanRe('(?:标底|拦标价|评标基准价|内部测算价|投标底价)', 'g') },
  // ---- 技术系统 tech ----
  { key: 'ip', zh: 'IP', en: 'IP', cat: 'tech', prio: 55, method: 'regex', scan: (text) => {
    const out = [];
    const re = /(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1].split('.').every((o) => Number(o) <= 255)) out.push({ term: m[1], start: m.index, end: m.index + m[0].length });
    }
    return out;
  } },
  { key: 'intranet', zh: '域名', en: 'DOM', cat: 'tech', prio: 50, method: 'regex', scan: scanRe('\\b(?:[A-Za-z0-9][A-Za-z0-9-]*\\.)+(?:local|lan|corp|internal|intra|home|nas|arpa)\\b', 'gi') },
  { key: 'hostname', zh: '主机', en: 'HOST', cat: 'tech', prio: 50, method: 'anchor', scan: anchorScan('(?:主机名|服务器名|hostname)', '[A-Za-z0-9._-]{2,30}') },
  { key: 'dbaddr', zh: '数据库', en: 'DB', cat: 'tech', prio: 88, method: 'regex', scan: scanRe('(?:jdbc:[a-z0-9]+:[^\\s，；"\'）)]+|mongodb(?:\\+srv)?:\\/\\/[^\\s，；"\'）)]+|redis:\\/\\/[^\\s，；"\'）)]+|mysql:\\/\\/[^\\s，；"\'）)]+)', 'gi') },
  { key: 'acct', zh: '账号', en: 'ACC', cat: 'tech', prio: 75, method: 'anchor', scan: anchorScan('(?:账号|帐号|用户名|账户名|登录名|userid|username|user_name)', `${V}{2,64}`) },
  { key: 'pwd', zh: '密码', en: 'PWD', cat: 'tech', prio: 90, method: 'anchor', scan: anchorScan('(?:密码|口令|password|passwd|pwd)', `${V}{3,64}`) },
  { key: 'apikey', zh: '密钥', en: 'KEY', cat: 'tech', prio: 95, method: 'regex', scan: (text) => {
    const out = [];
    const pats = [
      /\bsk-[A-Za-z0-9_-]{12,}\b/g,
      /\bBearer\s+[A-Za-z0-9_\-.]{12,}/g,
      /\b(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret|token|private[_-]?key)\s*[:=：]\s*["'`]?([A-Za-z0-9_\-./+=]{8,})/gi,
      /\b(?=[A-Za-z0-9_-]{30,}\b)(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9_-]{30,}\b/g,
    ];
    for (const re of pats) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const term = m[0].startsWith('Bearer') ? m[0] : (m[1] || m[0]);
        if (term) out.push({ term, start: m.index, end: m.index + m[0].length });
      }
    }
    return out;
  } },
  { key: 'token', zh: '令牌', en: 'SEC', cat: 'tech', prio: 80, method: 'anchor', scan: anchorScan('(?:密钥|私钥|公钥|token|令牌|secret)', `["'\`]?[A-Za-z0-9_\\-./+=]{8,80}`) },
  { key: 'serial', zh: '序列号', en: 'SN', cat: 'tech', prio: 55, method: 'anchor', scan: anchorScan('(?:序列号|出厂编号|\\bSN\\b)', '[A-Za-z0-9-]{6,32}') },
  { key: 'mac', zh: 'MAC', en: 'MAC', cat: 'tech', prio: 55, method: 'regex', scan: scanRe('\\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b', 'g') },
  { key: 'tbl', zh: '表名', en: 'TBL', cat: 'tech', prio: 48, method: 'heuristic', hint: 'SQL 语境启发', scan: scanRe('(?:from|into|update|join|truncate|table)\\s+([A-Za-z_][A-Za-z0-9_]{2,40})', 'gi', (m) => m[1]) },
  { key: 'apipath', zh: '接口', en: 'API', cat: 'tech', prio: 72, method: 'regex', scan: scanRe('https?://[^\\s，；"\'）)]*(?:/api/|/internal/|/admin/)[^\\s，；"\'）)]*', 'gi') },
  { key: 'path', zh: '路径', en: 'PATH', cat: 'tech', prio: 70, method: 'regex', scan: scanRe('(?:[A-Za-z]:\\\\[^\\s，；"\'）)]{2,120}|/(?:home|var|opt|etc|usr|data|mnt|srv|root)/[^\\s，；"\'）)]{2,120})', 'g') },
  // ---- 隐藏元数据 meta（引擎内不参与文本替换；提取层剥离并生成报告）----
  { key: 'docmeta', zh: '文档属性', en: 'META', cat: 'meta', prio: 0, method: 'meta', hint: '提取时剥离并在报告中列出', scan: null },
  { key: 'exif', zh: '图片EXIF', en: 'EXIF', cat: 'meta', prio: 0, method: 'meta', hint: 'P2；P1 图片默认拒收', scan: null },
  { key: 'wordrev', zh: '修订批注', en: 'REV', cat: 'meta', prio: 0, method: 'meta', hint: '提取时不进入正文，检测到即报告', scan: null },
  { key: 'zipname', zh: '压缩包文件名', en: 'ZIP', cat: 'meta', prio: 0, method: 'meta', hint: 'P2', scan: null },
];

const RULE_BY_KEY = Object.fromEntries(RULES.map((r) => [r.key, r]));

const DEFAULT_CFG = {
  enabled: 1,
  mask_numbers: 0,   // 裸数字默认关（防 AI 算错）；结构化号码不受此开关影响
  amount_on: 1,      // 语境金额类（报价/金额/回款/薪资）默认脱
  code_style: 'A',   // A 混合语义码 [公司A7]（拍板默认）| B 纯序号 [公司1] | C 随机码 ORG-7K2M9
  types: {},         // 缺省视为开启，显式 false 才关
  fixed: [],         // [{term, code?}] 或 ['词']，上限 500
};

// ---------------------------------------------------------------------------
// 编码生成
// ---------------------------------------------------------------------------
function rand(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

function makeCode(style, rule, used, counters) {
  for (let i = 0; i < 80; i++) {
    let c;
    if (style === 'B') {
      const n = (counters[rule.zh] = (counters[rule.zh] || 0) + 1);
      c = `${rule.zh}${n}`;
    } else if (style === 'C') {
      c = `${rule.en}-${rand(5)}`;
    } else {
      c = `${rule.zh}${rand(2)}`;
    }
    if (!used.has(c)) { used.add(c); return c; }
  }
  const c = `${rule.en}-${Date.now().toString(36).toUpperCase()}`;
  used.add(c);
  return c;
}

function wrap(entry) {
  return entry.style === 'C' ? entry.code : `[${entry.code}]`;
}

// ---------------------------------------------------------------------------
// 抽取与替换
// ---------------------------------------------------------------------------
function normalizeFixed(fixed) {
  const out = [];
  for (const f of Array.isArray(fixed) ? fixed.slice(0, 500) : []) {
    if (typeof f === 'string' && f.trim()) out.push({ term: f.trim() });
    else if (f && typeof f === 'object' && f.term) out.push({ term: String(f.term), code: f.code ? String(f.code) : undefined });
  }
  return out;
}

function extractCandidates(text, cfg) {
  const types = cfg.types || {};
  const on = (k) => types[k] !== false;
  const cands = [];

  // 固定关键词：无条件，优先级最高
  for (const f of normalizeFixed(cfg.fixed)) {
    let idx = 0;
    while ((idx = text.indexOf(f.term, idx)) !== -1) {
      cands.push({ term: f.term, key: 'fixed', prio: 100, start: idx, end: idx + f.term.length, customCode: f.code });
      idx += f.term.length;
    }
  }

  for (const rule of RULES) {
    if (!rule.scan || !on(rule.key)) continue;
    if (rule.amount && cfg.amount_on === 0) continue;
    for (const hit of rule.scan(text)) {
      cands.push({ term: hit.term, key: rule.key, prio: rule.prio, start: hit.start, end: hit.end });
    }
  }

  // 裸数字（默认关）：≥3 位、非年份、非小数一部分
  if (cfg.mask_numbers) {
    const re = /(?<![\d.,])(\d{3,})(?![\d.])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const nextCh = text[m.index + m[0].length] || '';
      if (/^(19|20)\d{2}$/.test(m[0]) && nextCh === '年') continue;
      cands.push({ term: m[0], key: 'numbers', prio: 10, start: m.index, end: m.index + m[0].length });
    }
  }

  return cands;
}

function dedupe(cands) {
  cands.sort((a, b) => b.prio - a.prio || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken = [];
  const accepted = [];
  for (const c of cands) {
    if (accepted.length >= MAX_ITEMS) break;
    if (taken.every((t) => c.start >= t.end || c.end <= t.start)) {
      accepted.push(c);
      taken.push(c);
    }
  }
  return accepted;
}

// persisted: 可选 Map(term -> entry)，会话/文档级持久对照（同一实体全程同码）
function encode(text, cfg, persisted) {
  const conf = { ...DEFAULT_CFG, ...(cfg || {}) };
  if (conf.enabled === 0 || conf.enabled === false) {
    return { skipped: true, reason: '脱敏总开关处于关闭状态' };
  }
  const map = persisted instanceof Map ? persisted : new Map();
  const accepted = dedupe(extractCandidates(String(text), conf));

  // B 风格序号续接：从已有编码里恢复各标签计数
  const used = new Set([...map.values()].map((e) => e.code));
  const counters = {};
  if (conf.code_style === 'B') {
    for (const e of map.values()) {
      const mm = /^(.*?[一-龥A-Za-z])(\d+)$/.exec(e.code);
      if (mm) counters[mm[1]] = Math.max(counters[mm[1]] || 0, Number(mm[2]));
    }
  }

  let added = 0;
  for (const c of accepted) {
    if (map.has(c.term)) continue;
    if (c.customCode) {
      const entry = { term: c.term, code: c.customCode, key: 'fixed', cat: 'ent', style: 'C' };
      map.set(c.term, entry);
      used.add(entry.code);
      added++;
      continue;
    }
    const rule = c.key === 'fixed' ? { zh: '关键词', en: 'KW', cat: 'ent' } : (RULE_BY_KEY[c.key] || { zh: '数值', en: 'NUM', cat: 'ent' });
    const entry = { term: c.term, code: makeCode(conf.code_style, rule, used, counters), key: c.key, cat: rule.cat, style: conf.code_style };
    map.set(c.term, entry);
    added++;
  }

  const entries = accepted.map((c) => map.get(c.term)).filter(Boolean);
  const byTerm = new Map(entries.map((e) => [e.term, e]));
  const sorted = [...entries].sort((a, b) => b.term.length - a.term.length);
  let masked = String(text);
  if (sorted.length) {
    const re = new RegExp(sorted.map((e) => esc(e.term)).join('|'), 'g');
    masked = String(text).replace(re, (m) => wrap(byTerm.get(m)));
  }
  return { masked, mapping: [...map.values()], count: entries.length, added };
}

// ---------------------------------------------------------------------------
// 复原与复核
// ---------------------------------------------------------------------------
function fwChar(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 0x21 && c <= 0x7a) return String.fromCharCode(c + 0xfee0);
  return ch;
}
const fwStr = (s) => [...s].map(fwChar).join('');

function codeForms(entry) {
  if (entry.style === 'C') {
    return [entry.code, fwStr(entry.code)];
  }
  const c = entry.code;
  // 宽松变体：AI 偶尔回写全角或书名号包裹
  return [`[${c}]`, `[${fwStr(c)}]`, `［${fwStr(c)}］`, `【${c}】`];
}

function decode(text, mapping, opts = {}) {
  const loose = opts.loose !== false;
  const arr = [...mapping].sort((a, b) => b.code.length - a.code.length);
  let out = String(text);
  const usedCodes = new Set();
  for (const e of arr) {
    const forms = loose ? codeForms(e) : [e.style === 'C' ? e.code : `[${e.code}]`];
    for (const f of forms) {
      if (out.includes(f)) {
        usedCodes.add(e.code);
        out = out.split(f).join(e.term);
      }
    }
  }
  return { restored: out, usedCodes: [...usedCodes] };
}

function residueRe(style) {
  if (style === 'C') return /\b[A-Z]{2,6}-[A-Z0-9]{5}\b/g;
  if (style === 'B') return /\[[^\[\]\n]{1,8}\d{1,3}\]/g;
  return /\[[^\[\]\n]{1,8}[0-9A-Z]{2}\]/g;
}

// 二次复核：残留代码 / 对照表中未被引用的条目 / 结论
function review(text, mapping) {
  const d = decode(text, mapping);
  const style = mapping.length ? (mapping[0].style || 'A') : 'A';
  const residual = [...new Set(d.restored.match(residueRe(style)) || [])];
  const used = new Set(d.usedCodes);
  const unused = mapping.filter((e) => !used.has(e.code)).map((e) => e.term);
  return {
    restored: d.restored,
    restoredCount: mapping.length - unused.length,
    residual,
    unused,
    verdict: residual.length === 0 ? 'complete' : 'incomplete',
  };
}

// 前端规则目录（规则配置页用）
function catalog() {
  const cats = { pii: { zh: '个人隐私信息', rules: [] }, ent: { zh: '企业业务敏感信息', rules: [] }, tech: { zh: '技术/系统敏感信息', rules: [] }, meta: { zh: '文档隐藏元数据', rules: [] } };
  for (const r of RULES) {
    cats[r.cat].rules.push({ key: r.key, zh: r.zh, method: r.method, prio: r.prio, hint: r.hint || '' });
  }
  return cats;
}

module.exports = { RULES, DEFAULT_CFG, encode, decode, review, catalog, residueRe, ALPHABET };
