'use strict';
// 面具 mask — 分享/回文共用：令牌生成、地址基座、对外引导语
const crypto = require('crypto');

const newToken = () => crypto.randomBytes(12).toString('hex'); // 24 位

// 从请求推断分享地址基座（同机访问即同机地址；经反代时取 Host 头）
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// 文档分享页引导语：写给外部 AI/人看
const shareGuide = () => '这份文档已经过脱敏处理：敏感信息（公司名、手机号、金额等）被替换成形如 [公司A7] 的占位码。'
  + '请基于码文内容进行分析或处理，回复中原样保留这些占位码、不要展开猜测。'
  + 'AI 的回复请粘贴到本页底部的回文框提交（或用回文地址），系统会按对照表自动复原给文档主人。';

// Agent 只写链接引导语
const agentGuide = () => '这个地址由「面具 AI 脱敏系统」的用户提供给你（外部 AI / 协作者）。'
  + '请把要返回的内容（码文或普通文本）粘贴到下方提交；内容会被原样记录，只有链接主人可以看到。'
  + '请注意不要在这里粘贴任何未脱敏的敏感信息。';

module.exports = { newToken, baseUrl, shareGuide, agentGuide };
