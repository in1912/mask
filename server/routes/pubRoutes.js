'use strict';
// 面具 mask — 公开页与回文通道（免登录，token 即凭证）
//   GET  /s/:token         分享页（文档=码文+回文框；Agent=引导语+回文框）
//   POST /api/pub/write/:token  回文写入（Agent 主 token 或 文档 pair_token）
// 红线：页面与接口永远只输出码文/引导语；解码只发生在主人登录后的接口里
const express = require('express');
const { db } = require('../db');
const engine = require('../engine');
const { shareGuide, agentGuide } = require('./shareUtil');

const MAX_WRITE = 2 * 1024 * 1024; // 2MB 文本
const DEDUP_MS = 10 * 1000;       // 同链接同内容 10s 内去重
const lastWrite = new Map();      // linkId -> {content, at}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function findLink(token) {
  return db.prepare('SELECT * FROM links WHERE token = ? OR pair_token = ?').get(String(token), String(token));
}
function linkState(l, nowStr) {
  if (l.revoked) return 'revoked';
  if (l.expires_at && l.expires_at < nowStr) return 'expired';
  return 'ok';
}
function nowLocal() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

// ---- 回文写入 ----
const router = express.Router();
router.post('/pub/write/:token', (req, res) => {
  const l = findLink(req.params.token);
  if (!l) return res.status(404).json({ error: '回文地址不存在' });
  const st = linkState(l, nowLocal());
  if (st !== 'ok') return res.status(410).json({ error: st === 'expired' ? '链接已过期' : '链接已被撤销' });

  // 文档主 token 是只读分享页，不接受回文
  if (l.kind === 'doc' && l.token === String(req.params.token)) {
    return res.status(400).json({ error: '这是分享页地址；回文请使用成对的回文地址' });
  }
  const content = String((req.body || {}).content ?? '');
  if (!content.trim()) return res.status(400).json({ error: '内容为空' });
  if (content.length > MAX_WRITE) return res.status(400).json({ error: '内容超过 2MB 上限' });

  const prev = lastWrite.get(l.id);
  if (prev && prev.content === content && Date.now() - prev.at < DEDUP_MS) {
    return res.status(409).json({ error: '相同内容刚刚已提交过，请勿重复' });
  }
  lastWrite.set(l.id, { content, at: Date.now() });
  const word_count = content.replace(/\s/g, '').length;

  if (l.kind === 'agent') {
    db.prepare('INSERT INTO link_writes (link_id, content, word_count, ua) VALUES (?, ?, ?, ?)')
      .run(l.id, content, word_count, String(req.headers['user-agent'] || '').slice(0, 200));
    return res.json({ ok: true, word_count });
  }
  // 文档回文：按文档对照表复原入库（复原结果绝不回显给匿名提交方）
  const map = new Map();
  for (const row of db.prepare("SELECT * FROM mappings WHERE scope_type = 'doc' AND scope_id = ?").all(l.doc_id)) {
    map.set(row.term, { term: row.term, code: row.code, key: row.rule_key, cat: row.category, style: row.style || 'A' });
  }
  const entries = [...map.values()];
  const dec = engine.decode(content, entries);
  const review = entries.length ? engine.review(content, entries) : null;
  db.prepare('INSERT INTO ai_replies (doc_id, source, raw_return, restored_text, review_json) VALUES (?, ?, ?, ?, ?)')
    .run(l.doc_id, 'share', content, dec.restored, review ? JSON.stringify({ ...review, restored: undefined }) : null);
  res.json({ ok: true, word_count });
});

// ---- 分享页（/s/:token，非 /api 路径 → 免登录）----
function pageHtml(l, st, req) {
  const css = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f5f7;color:#1d1d1f}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px 64px}
.card{background:#fff;border:1px solid #e5e5ea;border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#86868b;font-size:12px}
pre{white-space:pre-wrap;word-break:break-all;background:#f5f5f7;border-radius:8px;padding:14px;max-height:60vh;overflow:auto;font:13px/1.6 Consolas,monospace}
textarea{width:100%;box-sizing:border-box;min-height:120px;border:1px solid #d8d8dc;border-radius:8px;padding:10px;font:inherit}
button{margin-top:10px;background:#0a84ff;color:#fff;border:0;border-radius:8px;padding:10px 26px;font-size:15px;cursor:pointer}
button[disabled]{opacity:.5}
.mut{color:#86868b;font-size:13px}
.gone{font-size:40px;text-align:center}
</style>`;
  const shell = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${css}<title>${esc(title)}</title></head><body><div class="wrap">${body}</div></body></html>`;

  if (st !== 'ok') {
    const why = st === 'expired' ? '链接已过期' : (st === 'missing' ? '链接不存在（请核对地址）' : '链接已被主人撤销');
    return shell('链接已失效', `<div class="card"><div class="gone">⏳</div><p style="text-align:center">${esc(why)}</p><p class="mut" style="text-align:center">如有需要请联系链接主人重新生成。</p></div>`);
  }

  const writeBox = (postUrl) => `
  <div class="card">
    <h1>回文</h1>
    <p class="sub">把 AI 的回复（保留占位码原样）粘贴到下面提交</p>
    <textarea id="c" placeholder="在此粘贴要回传的内容…"></textarea>
    <button id="go" onclick="go()">提交回文</button>
    <p id="msg" class="mut"></p>
    <p class="mut">程序化调用：<code>POST ${esc(postUrl)}</code>（JSON：<code>{"content":"…"}</code>）</p>
  </div>
  <script>
  async function go(){
    const b=document.getElementById('go'),m=document.getElementById('msg'),c=document.getElementById('c');
    b.disabled=true;m.textContent='提交中…';
    try{
      const r=await fetch(${JSON.stringify(postUrl)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:c.value})});
      const j=await r.json().catch(()=>({}));
      m.textContent=r.ok?('已提交（'+(j.word_count||0)+' 字），感谢配合'):(j.error||('提交失败 '+r.status));
      if(r.ok)c.value='';
    }catch(e){m.textContent='网络错误：'+e;}
    b.disabled=false;
  }
  </script>`;

  if (l.kind === 'agent') {
    return shell('Agent 回文通道', `<div class="card"><h1>Agent 回文通道</h1><p>${esc(agentGuide())}</p></div>` + writeBox('/api/pub/write/' + l.token));
  }
  // 文档分享页（主 token）：只显示码文；回文页（pair token）：只显示回文框
  const doc = db.prepare('SELECT filename, masked_text FROM documents WHERE id = ?').get(l.doc_id);
  if (l.token === String(req.params.token)) {
    return shell('脱敏文档分享', `
    <div class="card">
      <h1>脱敏文档分享</h1>
      <p class="sub">${esc(doc ? doc.filename : '')}</p>
      <p>${esc(shareGuide())}</p>
    </div>
    <div class="card"><p class="sub">文档正文（码文）</p><pre>${esc(doc ? doc.masked_text || '（尚未脱敏）' : '（文档已删除）')}</pre></div>
    <div class="card"><p class="sub">回文地址（也可直接发给外部 AI）</p><p><code>${esc('/s/' + l.pair_token)}</code></p></div>`
      + writeBox('/api/pub/write/' + l.pair_token));
  }
  return shell('文档回文', `<div class="card"><h1>文档回文</h1><p class="sub">${esc(doc ? doc.filename : '')}</p><p>${esc(shareGuide())}</p></div>` + writeBox('/api/pub/write/' + l.pair_token));
}

function sharePage(req, res) {
  const l = findLink(req.params.token);
  if (!l) return res.status(404).type('html').send(pageHtml(null, 'missing', req)); // 404 也给体面页
  res.status(200).type('html').send(pageHtml(l, linkState(l, nowLocal()), req));
}

module.exports = { router, sharePage };
