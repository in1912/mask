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
// 扩充姓氏表：只喂给「姓名列表 / 角色锚定」这两条语境强的路（v0.3.0，起因=温培泉等漏报，温不在保守表里）。
// 「姓氏+称谓」仍只用保守 SUR——扩表会把那条弱信号路的误报面炸开（常/成/平/安 这类字开头的词太多）。
const SUR2 = SUR + '温鲁滕葛易常齐康伍涂颜宫宁栾厉蒲路祖班惠连茹艾容燕冀慎利越兰禄萧禹狄米贝明臧计伏成谈茅庞纪舒屈项祝阮解强柴华封窦井鲍岑费麻倪殷毕安元卜平穆湛祁卞皮桂简双杭包梅盛骆乐邬籍嵇';
// 列表/锚定 token 里出现这些词就整项拒绝：都是「姓+常用词」陷阱（周工作/成本/计划/上周…）
// 末尾是常与姓名同现的企业/软件品牌（金/用/泛/钉/飞/影/华/高/万/平 都是姓氏表里的字，
// 「金蝶，金蝶法报，用友数据导出」这种产品列表会被姓名列表正则咬中）
const NAME_STOP = ['工作', '公司', '部门', '系统', '平台', '项目', '会议', '数据', '服务', '汇报', '纪要', '流程', '功能', '成本', '预算', '计划', '方案', '进度', '需求', '问题', '风险', '客户', '产品', '运营', '管理', '研发', '测试', '环境', '版本', '接口', '服务器', '代码', '账号', '密码', '报表', '日报', '周报', '月报', '合同', '订单', '财务', '人事', '行政', '采购', '实施', '培训', '优化', '迁移', '搭建', '沟通', '处理', '解决', '准备', '整理', '打印', '订购', '报错', '切换', '修改', '安装', '拷贝', '建立', '整合', '运维', '机房', '网络', '安全', '权限', '架构', '数据库', '日志', '监控', '工单', '值班', '考勤', '绩效', '考核', '奖金', '报销', '差旅', '驻场', '售前', '售后', '商务', '法务', '合规', '审计', '税务', '发票', '回款', '付款', '转账', '对账', '结算', '上午', '下午', '晚上', '周一', '周二', '周三', '周四', '周五', '周六', '周日', '本周', '上周', '下周', '金蝶', '用友', '泛微', '钉钉', '飞书', '影刀', '华为', '高德', '万科', '平安'];
const TITLE = '(?:先生|女士|老师|教授|医生|工程师|经理|总监|主管|科长|部长|董事长|总经理|律师|会计师|分析师|设计师|总|工)';

// v1.03：外部引擎的人名结果也要过一道常识闸。起因=GLiNER 这类模型会把合同里的
// 「万店掌系」「方按年支」「伍拾捌万」当成 PERSON，码一打，整句语义就毁了。
// 规则：2~4 字；4 字只认复姓（欧阳/司马…）或带间隔号（少数民族音译）；
// 姓氏之后的字里出现虚词/动词/量词/财务大写数字等「几乎不会进名字」的字就拒绝。
// 宁可漏掉极少数生僻真名，也不把一句话拆成四段人名（用户 2026-10-21 明确取舍）。
const NAME_BAD_CHARS = new Set('的了和与及或按各类于向对为是在有就都也还很不没这那其之者所被把让给从由而且并但可需要应当须将已未等系移硬拾捌仟整省镜页诉门店铺甲乙方开具提行项确认收组织验承担协商售装时转履护测签章掌');
const COMPOUND_SUR = ['欧阳', '太史', '端木', '上官', '司马', '东方', '独孤', '南宫', '万俟', '闻人', '夏侯', '诸葛', '尉迟', '公羊', '赫连', '澹台', '皇甫', '宗政', '濮阳', '公冶', '太叔', '申屠', '公孙', '慕容', '仲孙', '钟离', '长孙', '宇文', '司徒', '鲜于', '司空', '闾丘', '子车', '亓官', '司寇', '巫马', '公西', '颛孙', '壤驷', '公良', '漆雕', '乐正', '宰父', '谷梁', '拓跋', '夹谷', '轩辕', '令狐', '段干', '百里', '呼延', '东郭', '南门', '羊舌', '微生', '梁丘', '左丘', '西门', '第五', '公乘', '即墨', '达奚'];
function plausiblePerson(term) {
  const s = String(term || '').trim();
  if (s.length < 2 || s.length > 4) return false;
  if (/[·•]/.test(s)) return true;
  if (s.length === 4 && !COMPOUND_SUR.some((p) => s.startsWith(p))) return false;
  for (const ch of s.slice(1)) if (NAME_BAD_CHARS.has(ch)) return false;
  return true;
}

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

// 统一社会信用代码（GB 32100-2015）校验位：字符集去 I/O/S/V/Z 共 31 个，模 31。
// 只认校验通过的 18 位，避免把普通 18 位单号当信用代码。
const USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
function usccOk(s) {
  const up = String(s).toUpperCase();
  if (up.length !== 18) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = USCC_CHARS.indexOf(up[i]);
    if (idx < 0) return false;
    sum += idx * USCC_WEIGHTS[i];
  }
  const c = 31 - (sum % 31);
  return USCC_CHARS[c === 31 ? 0 : c] === up[17];
}

// 锚定词内部允许排版空格：表单里常见「帐    号：」「纳 税 人 识 别 号：」。
// 只给纯文字关键词用；带正则语法的关键词仍走 anchorScan，免得把语法拆坏。
function spacedKw(kw) {
  return String(kw).split('').map(esc).join('[ \\t\\u3000]*');
}
function anchorWordsScan(words, valSource, flags = 'gi') {
  const kw = words.map(spacedKw).join('|');
  // 关键词后可带编号再跟冒号：「账  号2：」是合同里第二个账户栏的常见写法。
  // 编号必须带冒号才吃（lookahead），否则「账号 1234567」会被误当成「账号2 + 值」。
  const idx = '(?:[ \\t\\u3000]*[0-9]{1,2}(?=[ \\t\\u3000]*[:：]))?';
  return scanRe(`(?:${kw})${idx}[ \\t\\u3000]*(?:是|为|[:：])?[ \\t\\u3000]*(${valSource})`, flags, (m) => m[1]);
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
  // 银行账号：优先认「账号/帐号」锚点后的数字串（允许空格/短横分组，如 4884 7065 5042）；
  // 优先级高于通用 acct（75），否则只会把第一段 4 位数字换掉。
  { key: 'bankacct', zh: '银行账号', en: 'ACCT', cat: 'pii', prio: 78, method: 'anchor', scan: anchorWordsScan(['银行账号', '银行帐号', '对公账号', '对公帐号', '收款账号', '收款帐号', '账号', '帐号'], '\\d(?:[ \\t-]?\\d){6,29}(?!\\d)') },
  { key: 'person', zh: '人名', en: 'PER', cat: 'pii', prio: 20, method: 'heuristic', hint: '姓氏+称谓/引号/姓名列表/角色锚定启发式，可能漏或误', scan: (text) => {
    const out = [];
    const strong = new Set(); // 强语境（列表/锚定/引号）确认过的人名：全篇其余出现一并入码
    // 1) 姓氏 + 称谓（保守姓氏表）。排除字表补「作资期共额部」：上周工作→周工、关于工资→于工、
    //    张总共/王总额/李总部——称谓后紧跟这些字头时几乎都是普通词，不是在称呼人
    const reT = new RegExp(`[${SUR}][一-龥]{0,2}${TITLE}(?![结体归功能谋作资期共额部])`, 'g');
    let m;
    while ((m = reT.exec(text)) !== null) out.push({ term: m[0], start: m.index, end: m.index + m[0].length });
    // v1.03 删除两条「按姓氏拆字」的路：
    //   ①引号包裹：[姓氏字]+1~3 字，报价单里「万店掌」这种品牌一进引号就被当人名；
    //   ②顿号姓名列表：任意顿号分隔的 2~3 字词组，只要首字碰巧是姓氏就算名字，
    //     合同里的「伍拾捌万元整，陆拾元整」被拆成「万元整」「陆拾元」。
    // 汉字里能当姓氏的字太多，按字面拆必然伤语义。用户 2026-10-21 明确要求：
    // 没有可靠办法就宁可不用。现在只保留有明确语境的两条路：称谓 + 角色锚定。
    const NAME2 = `[${SUR2}][一-龥]{1,2}`;
    const PAREN = '(?:\\s*[（(][^）)\\n]{1,6}[）)])?';
    // 2) 角色锚定：主持人：/责任人：/参会人员： 后面紧跟的姓名，以及同一行顿号名单
    //    （锚点本身就是强语境——「参会人员：温培泉、刘立伟」可以整串认，不做全文扫）。
    //    锚定词允许排版空格（例会纪要里常被打散成「主 持 人：」）
    // v1.01 补：合同/协议落款最常见的「代表签字：陈毅」「法定代表人：张三」「授权代表：李四」
    const ANCHORS = ['参会人员', '与会人员', '出席人员', '列席人员', '出席者', '列席者', '与会者', '主持人', '会议记录', '记录人', '汇报人', '责任人', '经办人', '联系人', '对接人', '负责人', '发起人', '审批人', '创建人', '面试官', '主讲人',
      '代表签字', '签字代表', '签字人', '签字', '签名', '签署人', '姓名', '法定代表人', '法人代表', '授权代表', '委托代理人', '代理人', '开户人', '制表人', '审核人', '批准人'];
    const sp = (s) => s.split('').join('\\s*');
    const reA = new RegExp(`(?:${ANCHORS.map(sp).join('|')})\\s*[:：]\\s*(${NAME2}${PAREN}(?:[ \\t]*[、，,][ \\t]*${NAME2}${PAREN})*)`, 'g');
    const nameIn = new RegExp(NAME2, 'g');
    while ((m = reA.exec(text)) !== null) {
      const seg = m[1];
      const base = m.index + m[0].indexOf(seg);
      nameIn.lastIndex = 0;
      let n;
      while ((n = nameIn.exec(seg)) !== null) {
        if (NAME_STOP.some((w) => n[0].includes(w))) continue;
        out.push({ term: n[0], start: base + n.index, end: base + n.index + n[0].length });
        strong.add(n[0]);
      }
    }
    // 3) 确认后全篇传播：strong 里的人名在文档其余位置的出现（如表格里独占一行的责任人）
    //    一并标记。弱信号（姓氏+称谓）不参与——真「周工」不能把「上周工作」带进沟里
    for (const t of strong) {
      let i = 0;
      while ((i = text.indexOf(t, i)) !== -1) {
        out.push({ term: t, start: i, end: i + t.length });
        i += t.length;
      }
    }
    return out;
  } },
  { key: 'nickname', zh: '昵称', en: 'NICK', cat: 'pii', prio: 42, method: 'anchor', scan: anchorScan('(?:昵称|网名|花名)', `${V}{2,30}`) },
  { key: 'email', zh: '邮箱', en: 'MAIL', cat: 'pii', prio: 62, method: 'regex', scan: scanRe('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', 'g') },
  { key: 'wechat', zh: '微信', en: 'WX', cat: 'pii', prio: 50, method: 'anchor', scan: anchorScan('(?:微信号|微信ID)', '[A-Za-z][A-Za-z0-9_-]{5,19}') },
  { key: 'qq', zh: 'QQ', en: 'QQ', cat: 'pii', prio: 50, method: 'anchor', scan: anchorScan('(?:QQ|qq|扣扣)(?:号|群)?', '[1-9]\\d{4,10}(?!\\d)') },
  { key: 'address', zh: '地址', en: 'ADDR', cat: 'pii', prio: 44, method: 'heuristic', hint: '路/街/巷+门牌，或「地址：」锚点，启发式', scan: (text) => {
    const out = scanRe('[一-龥A-Za-z0-9]{2,20}(?:路|街|大道|巷|道)\\s?[0-9一二三四五六七八九十]{1,6}号(?:[0-9]{1,5}(?:栋|幢|室|单元|楼层))?', 'g')(text);
    // v1.03：小区/里/村这类地址不一定带「路」，有「地址：」锚点就直接取值；
    // 「无/见附件」这类占位词不脱，避免把「地址：见附件」打成码。
    for (const a of anchorWordsScan(['通讯地址', '联系地址', '注册地址', '办公地址', '收货地址', '家庭地址', '所在地址', '住址', '地址'], `${V}{4,60}`)(text)) {
      if (!/^(?:无|暂无|未知|待定|见附件|同上|略|面议)$/.test(a.term)) out.push(a);
    }
    return out;
  } },
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
  // 统一社会信用代码 / 纳税人识别号（v1.01 补：合同里的 18 位码一直漏脱）
  // ①无锚点也认：18 位、字符集符合 GB 32100 且校验位通过，几乎不会误报；
  // ②有「纳税人识别号/税号」等锚点时放宽到 15~20 位字母数字，兼容旧 15 位税务登记号。
  { key: 'creditcode', zh: '信用代码', en: 'USCC', cat: 'ent', prio: 64, method: 'luhn', scan: (text) => {
    const out = [];
    const re = /(?<![0-9A-Za-z])[0-9A-HJ-NPQRTUWXYa-hj-npqrtuwxy]{18}(?![0-9A-Za-z])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (usccOk(m[0])) out.push({ term: m[0], start: m.index, end: m.index + m[0].length });
    }
    return out;
  } },
  { key: 'taxid', zh: '税号', en: 'TAX', cat: 'ent', prio: 60, method: 'anchor', scan: anchorWordsScan(['纳税人识别号', '纳税人识别码', '纳税人编码', '统一社会信用代码', '社会信用代码', '信用代码', '税务登记号', '税号'], '[0-9A-Za-z]{15,20}(?![0-9A-Za-z])') },
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

function extractCandidates(text, cfg, extra) {
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
    if (cfg._extOnly) continue; // 主引擎=外部引擎：识别完全交给它（固定关键词不受影响）
    for (const hit of rule.scan(text)) {
      cands.push({ term: hit.term, key: rule.key, prio: rule.prio, start: hit.start, end: hit.end });
    }
  }

  // 裸数字（默认关）：≥3 位、非年份、非小数一部分
  if (cfg.mask_numbers && !cfg._extOnly) {
    const re = /(?<![\d.,])(\d{3,})(?![\d.])/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const nextCh = text[m.index + m[0].length] || '';
      if (/^(19|20)\d{2}$/.test(m[0]) && nextCh === '年') continue;
      cands.push({ term: m[0], key: 'numbers', prio: 10, start: m.index, end: m.index + m[0].length });
    }
  }

  // 外部引擎候选（v0.3.0 多引擎）：已由 engines/index.js 映射好 key/prio/坐标，
  // 这里只做形状校验——与内置规则汇入同一个 dedupe（重叠时优先级+跨度定胜负）
  for (const c of Array.isArray(extra) ? extra : []) {
    if (c && typeof c.term === 'string' && c.term && c.start >= 0 && c.end > c.start
      && text.slice(c.start, c.end) === c.term && on(c.key)) {
      cands.push(c);
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
// extra: 可选外部引擎候选（多引擎架构，见 server/engines/index.js）
function encode(text, cfg, persisted, extra) {
  const conf = { ...DEFAULT_CFG, ...(cfg || {}) };
  if (conf.enabled === 0 || conf.enabled === false) {
    return { skipped: true, reason: '脱敏总开关处于关闭状态' };
  }
  const map = persisted instanceof Map ? persisted : new Map();
  const accepted = dedupe(extractCandidates(String(text), conf, extra));

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
    const rule = c.key === 'fixed' ? { zh: '关键词', en: 'KW', cat: 'ent' }
      : c.key === 'ext' ? { zh: '外部', en: 'EXT', cat: 'pii' } // 外部引擎未映射类型
      : (RULE_BY_KEY[c.key] || { zh: '数值', en: 'NUM', cat: 'ent' });
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
  // mapping 是整张持久底账（decode 复原回复时可能需要引用历史实体）；
  // applied 才是本次真正在文本里替换掉的条目。历史快照/界面展示必须用 applied，
  // 否则换引擎或改规则前认错的旧条目（如「章页」「万店掌系」）会永远挂在对照表里。
  // 底账本身不删，同码不变。
  return { masked, mapping: [...map.values()], applied: entries, count: entries.length, added };
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

module.exports = { RULES, DEFAULT_CFG, encode, decode, review, catalog, residueRe, ALPHABET, plausiblePerson };
