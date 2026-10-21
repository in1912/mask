'use strict';
// 面具 mask — 脱敏引擎自检（纯函数，不起服务、不碰真实库）
// 运行：npm run check:engine
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../server/engine.js');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra)?.slice(0, 400) : ''); }
}

const codeOf = (mapping, term) => mapping.find((e) => e.term === term)?.code;

console.log('A. 结构化正则');
{
  const s = '身份证号 11010519491231002X，手机 13812345678，邮箱 test@example.com，备用 138-1234-5678';
  const r = E.encode(s, {});
  t('A1 身份证被编码', /\[身份证[0-9A-Z]{2}\]/.test(r.masked), r.masked);
  t('A2 手机号被编码', /\[手机号[0-9A-Z]{2}\]/.test(r.masked), r.masked);
  t('A3 邮箱被编码', /\[邮箱[0-9A-Z]{2}\]/.test(r.masked), r.masked);
  t('A4 原文敏感值不再出现', !r.masked.includes('13812345678') && !r.masked.includes('11010519491231002X') && !r.masked.includes('test@example.com'), r.masked);
}
{
  const r = E.encode('卡号 4111111111111111 与 4111111111111112 对比', {});
  t('A5 Luhn 有效的卡被编码', r.masked.includes('[银行卡') && r.masked.includes('4111111111111112'), r.masked);
}
{
  const r = E.encode('服务器 192.168.1.100 宕机，备用 10.0.0.2，异常 999.1.1.1', {});
  t('A6 合法 IP 编码+非法 IP 放行', r.masked.includes('[IP') && !r.masked.includes('192.168.1.100') && r.masked.includes('999.1.1.1'), r.masked);
}
{
  const r = E.encode('网卡 MAC AA:BB:CC:11:22:33 绑定', {});
  t('A7 MAC 编码', r.masked.includes('[MAC') && !r.masked.includes('AA:BB:CC'), r.masked);
}
{
  const r = E.encode('key 是 sk-abc123def456ghi789jkl，头是 Bearer eyJhbGciOi.1234567890', {});
  t('A8 sk- 密钥编码', r.masked.includes('sk-') === false, r.masked);
  t('A9 Bearer 编码', !r.masked.includes('eyJhbGciOi'), r.masked);
}
{
  const r = E.encode('接口 https://in.example.com/api/v1/users 出错，配置在 C:\\Users\\wpq\\secret.txt', {});
  t('A10 内部接口地址编码', r.masked.includes('[接口') || r.masked.includes('[域名'), r.masked);
  t('A11 内网路径编码', r.masked.includes('[路径'), r.masked);
}

console.log('B. 对照表持久（同一实体同码）');
{
  const p = new Map();
  const r1 = E.encode('联系人张三的手机是 13812345678', {}, p);
  const r2 = E.encode('再次提到 13812345678', {}, p);
  t('B1 跨轮同码', codeOf(r1.mapping, '13812345678') === codeOf(r2.mapping, '13812345678'), [r1.mapping.filter(e=>e.term==='13812345678'), r2.mapping.filter(e=>e.term==='13812345678')]);
  t('B2 第二轮零新增', r2.added === 0, r2.added);
  const r3 = E.encode('新的邮箱 new@example.com 出现', {}, p);
  t('B3 新实体有新码', r3.added === 1 && codeOf(r3.mapping, 'new@example.com') !== codeOf(r3.mapping, '13812345678'), r3.added);
}

console.log('C. 人名/公司/部门启发式');
{
  const s = '“张三丰”与“张三”都在场，还有 王总 和 联系人：王建国';
  const r = E.encode(s, {});
  const c1 = codeOf(r.mapping, '张三丰'), c2 = codeOf(r.mapping, '张三');
  t('C1 长词不被短词吃掉（两个独立码）', c1 && c2 && c1 !== c2, r.mapping.map(e=>e.term));
  t('C2 称谓人名编码（王总）', r.masked.includes('王总') === false, r.masked);
  t('C3 联系人锚定（王建国）', r.masked.includes('王建国') === false, r.masked);
}
{
  const r = E.encode('客户是杭州云梯智造有限公司的三号仓库，苏州精益机械有限公司供货', {});
  t('C4 公司后缀锚定+左侧截断', r.masked.includes('客户是[公司') && !r.masked.includes('杭州云梯智造'), r.masked);
  t('C5 两家公司两个码', new Set(r.mapping.filter(e => e.key === 'org').map(e => e.code)).size === 2, r.mapping);
}
{
  const r = E.encode('技术事业部和财务部门都在群里', {});
  t('C6 部门后缀锚定', r.masked.includes('[部门'), r.masked);
  t('C7 泛称不误伤（很多部门）', E.encode('很多部门都参加了', {}).masked.includes('很多部门'), '');
}

console.log('D. 锚定取值不吞后半句');
{
  const r = E.encode('密码是 hunter2xyz。下一句还在', {});
  t('D1 密码值编码且句号后保留', r.masked.startsWith('密码是 [密码') && r.masked.includes('。下一句还在'), r.masked);
}
{
  const r = E.encode('账号：ops_admin_01 已锁定，微信号 wxid_9k2Mz，QQ号 987654321', {});
  t('D2 账号/微信/QQ 锚定', !r.masked.includes('ops_admin_01') && !r.masked.includes('wxid_9k2Mz') && !r.masked.includes('987654321'), r.masked);
}
{
  const r = E.encode('住在浙江省杭州市西湖区文三路100号，生日 1990年6月15日', {});
  t('D3 地址启发式', r.masked.includes('文三路100号') === false, r.masked);
  t('D4 生日锚定', r.masked.includes('1990年6月15日') === false, r.masked);
}

console.log('E. 数值与金额语义');
{
  const off = E.encode('一共300个包裹，2024年年底交付', {});
  t('E1 数值开关默认关', off.masked.includes('300个') && off.masked.includes('2024年'), off.masked);
  const on = E.encode('一共300个包裹，2024年年底交付', { mask_numbers: 1 });
  t('E2 开启后裸数字编码', !on.masked.includes('300') && on.masked.includes('2024年'), on.masked);
}
{
  const r = E.encode('合同金额为1,200,000元，报价 85万元，月薪 25000元', {});
  t('E3 语境金额默认脱（不受数值开关影响）', !r.masked.includes('1,200,000') && !r.masked.includes('85万元') && !r.masked.includes('25000'), r.masked);
  const off = E.encode('合同金额为1,200,000元', { amount_on: 0 });
  t('E4 amount_on=0 时金额放行', off.masked.includes('1,200,000'), off.masked);
}

console.log('F. 三套编码风格');
{
  const r = E.encode('杭州云梯智造有限公司报价 100万元', { code_style: 'A' });
  t('F1 A 风格 [公司XX]', /\[公司[0-9A-Z]{2}\]/.test(r.masked), r.masked);
  const rb = E.encode('杭州云梯智造有限公司与苏州精益机械有限公司', { code_style: 'B' });
  t('F2 B 风格顺序编号', rb.masked.includes('[公司1]') && rb.masked.includes('[公司2]'), rb.masked);
  const rc = E.encode('杭州云梯智造有限公司', { code_style: 'C' });
  t('F3 C 风格工作台兼容', /ORG-[0-9A-Z]{5}/.test(rc.masked), rc.masked);
}

console.log('G. 配置开关');
{
  const r = E.encode('邮箱 a@b.com 手机 13812345678', { types: { email: false } });
  t('G1 单类关闭生效', r.masked.includes('a@b.com') && !r.masked.includes('13812345678'), r.masked);
  const f = E.encode('老板说今天开会', { fixed: [{ term: '老板', code: 'KW-BOSS' }] });
  t('G2 固定关键词自定义代码', f.masked.includes('KW-BOSS'), f.masked);
  const s = E.encode('手机 13812345678', { enabled: 0 });
  t('G3 总开关关闭如实跳过', s.skipped === true && s.masked === undefined, s);
}

console.log('H. 复原与复核');
{
  const orig = '客户是杭州云梯智造有限公司，联系人王建国，手机 13812345678，合同金额为1,200,000元';
  const r = E.encode(orig, {});
  const back = E.decode(r.masked, r.mapping);
  t('H1 编码→复原逐字一致', back.restored === orig, back.restored);
  const ai = `好的，[公司${'A1'}] 的方案我看了。`; // 构造：AI 原样回带码文本
  const aiEcho = r.masked; // AI 原样回脱敏文本
  const d2 = E.decode(aiEcho, r.mapping);
  t('H2 AI 回文复原', d2.restored === orig, d2.restored);
}
{
  const r = E.encode('杭州云梯智造有限公司与苏州精益机械有限公司', {});
  const ent = r.mapping.find((e) => e.term.includes('云梯'));
  const fw = (s) => [...s].map((c) => { const x = c.charCodeAt(0); return (x >= 0x21 && x <= 0x7a) ? String.fromCharCode(x + 0xfee0) : c; }).join('');
  const loose = `［${fw(ent.code)}］`;
  const d = E.decode(loose, [ent]);
  t('H3 全角宽松复原', d.restored === ent.term, { loose, code: ent.code, got: d.restored });
}
{
  const r = E.encode('杭州云梯智造有限公司', {});
  const ent = r.mapping[0];
  const rv = E.review(`结论引用了 [公司Z9] 这个未知代码`, r.mapping);
  t('H4 未知残留代码被复核抓出', rv.verdict === 'incomplete' && rv.residual.includes('[公司Z9]'), rv);
  const rv2 = E.review(`仅提到 [${ent.code}]`, r.mapping);
  t('H5 未引用对照项列入 unused', rv2.verdict === 'complete' && rv2.unused.length === 0, rv2);
  const r2 = E.encode('杭州云梯智造有限公司与苏州精益机械有限公司', {});
  const rv3 = E.review(`只提到 [${r2.mapping[0].code}]`, r2.mapping);
  t('H6 复核报告未出现条目', rv3.unused.length === 1, rv3);
}

console.log('I. 目录与边界');
{
  const cat = E.catalog();
  t('I1 四大类齐全', Object.keys(cat).length === 4 && cat.pii.rules.length >= 15 && cat.tech.rules.length >= 10 && cat.meta.rules.length >= 3, Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, v.rules.length])));
  t('I2 空文本不崩', E.encode('', {}).masked === '');
  t('I3 无命中返回原文', E.encode('今天天气不错', {}).masked === '今天天气不错');
}

console.log('J. 人名四路识别（v0.3.0：起因=例会纪要人名全漏 + 上周工作误报成周工）');
{
  // 真实例会纪要片段（脱敏过的用户文档，2026-10-20 报障）
  const minutes = '参会人员：\n温培泉、刘立伟、刘艺彬(请假)\n主 持 人：\n温培泉\n会议记录：\n刘立伟\n会议主题：\n上周工作\n本周工作\n会议内容：\n1、\nOA搭建测试服务器\n温培泉、刘立伟\n7、\n解决8月份数据渠道存在空的数据\n刘艺彬\n10、\n泛微及金蝶接口费用开始走付款流程\n';
  const r = E.encode(minutes, {});
  const persons = r.mapping.filter((e) => e.key === 'person').map((e) => e.term);
  t('J1 顿号姓名列表全识别（含括注与扩姓「温」）', ['温培泉', '刘立伟', '刘艺彬'].every((n) => persons.includes(n)), persons);
  t('J2 参会人员行脱敏后只剩码（括注保留在码外）', r.masked.includes('温培泉') === false && /\[人名[0-9A-Z]+\]、\[人名[0-9A-Z]+\]、\[人名[0-9A-Z]+\]\(请假\)/.test(r.masked), r.masked.split('\n')[1]);
  t('J3 排版空格锚定（主 持 人：）识别', r.masked.includes('主 持 人') === true && r.masked.split('主 持 人：')[1].trim().startsWith('['), r.masked.split('主 持 人：')[1]);
  t('J4 表格独行责任人被全篇传播覆盖', r.masked.includes('刘艺彬') === false, r.masked);
  t('J5 上周工作/本周工作不再误报成「周工」', r.mapping.some((e) => e.term === '周工') === false && /[上本]周工作/.test(r.masked), r.mapping.filter((e) => e.term === '周工'));
  t('J6 金蝶（品牌）不进人名', r.mapping.some((e) => e.key === 'person' && e.term.includes('金蝶')) === false, r.mapping.filter((e) => e.term.includes('金蝶')));
  // 产品列表陷阱：金蝶，金蝶法报，用友数据导出 —— 顿号/逗号分隔但不是姓名
  const brands = E.encode('导出：金蝶，金蝶法报，用友数据导出（财务）', {});
  t('J7 产品逗号列表不咬成人名', brands.mapping.some((e) => e.key === 'person') === false, brands.mapping);
  // 真「周工」称谓仍要识别（姓氏+称谓路没被误伤）
  const realTitle = E.encode('这个问题请周工评审，王总也会参加', {});
  t('J8 真称谓（周工/王总）仍识别', realTitle.masked.includes('周工') === false && realTitle.masked.includes('王总') === false, realTitle.masked);
  // 普通顿号词组不误报：测试、开发、运维（首字非姓氏 → 列表正则天然不匹配）
  const words = E.encode('本轮迭代涉及：测试、开发、运维、上线', {});
  t('J9 普通词组列表零命中', words.mapping.some((e) => e.key === 'person') === false, words.mapping);
  // 「关于工资/张总共/李总部」称谓路防误报
  const trap = E.encode('关于工资的说明：张总共三期发放，李总部已审批', {});
  t('J10 工资/总共/总部陷阱不误报', trap.mapping.some((e) => e.key === 'person' && ['于工', '张总', '李总'].includes(e.term)) === false, trap.mapping.filter((e) => e.key === 'person'));
}

console.log('K. 合同落款与账号（v1.01：起因=用户报「代表签字/帐号/纳税人识别号」整段没脱）');
{
  // 用户 2026-10-21 报障原文（结构原样保留：锚点里的排版空格、账号里的分组空格）
  const contract = '代表签字：陈毅\n代表签字： 冯春民     \n帐    号：756082624210001\n帐   号： 4884 7065 5042\n纳税人识别号：91330201758898651N\n纳税人识别号：91320505MA1MK13C82';
  const r = E.encode(contract, {});
  const lines = r.masked.split('\n');
  t('K1 代表签字后的人名被脱敏',
    /^代表签字：\[人名[0-9A-Z]+\]$/.test(lines[0])
    && /^代表签字： \[人名[0-9A-Z]+\] *$/.test(lines[1])
    && !r.masked.includes('陈毅') && !r.masked.includes('冯春民'), lines.slice(0, 2));
  t('K2 15 位账号被脱敏', /^帐    号：\[银行账号[0-9A-Z]+\]$/.test(lines[2]), lines[2]);
  t('K3 带分组空格的账号整段脱敏（不留数字碎片）', /^帐   号： \[银行账号[0-9A-Z]+\]$/.test(lines[3]) && !/\d/.test(lines[3]), lines[3]);
  t('K4 两个 18 位统一社会信用代码都被脱敏', lines.slice(4).every((l) => /^纳税人识别号：\[(信用代码|税号)[0-9A-Z]+\]$/.test(l)), lines.slice(4));
  t('K5 解码还原原文逐字节一致', E.decode(r.masked, r.mapping).restored === contract);
  // 校验位不过的 18 位数字不误报（同长度、无非字母，Luhn 也不成立）
  t('K6 校验位不过的 18 位编号不误报', E.encode('合同附件编号 123456789012345672 已归档', {}).masked === '合同附件编号 123456789012345672 已归档');
  // 旧 15 位税务登记号走锚点
  t('K7 旧 15 位税号按锚点脱敏', /^税号：\[税号[0-9A-Z]+\]$/.test(E.encode('税号：350101123456789', {}).masked), E.encode('税号：350101123456789', {}).masked);
  // 落款人名确认后全篇传播（甲乙方签署页常把名字再写一次）
  t('K8 落款人名全篇传播', E.encode('代表签字：陈毅\n陈毅 身份证见附件', {}).masked.includes('陈毅') === false);
}

console.log(`\n结果：${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
