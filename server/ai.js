'use strict';
// 面具 mask — OpenAI 兼容 AI 通道（承工作台 aiService 语义：容忍整条 URL 或裸 base）
function chatEndpoint(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/chat\/completions$/, '');
  return b + '/chat/completions';
}

// 非流式：返回 {content, model, usage}
async function chatOnce({ base_url, api_key, model, messages, max_tokens = 1024, temperature = 0.7, timeout_ms = 150000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout_ms);
  try {
    const r = await fetch(chatEndpoint(base_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
      body: JSON.stringify({ model, messages, max_tokens, temperature, stream: false }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`上游 ${r.status}：${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const c = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.message?.reasoning_content ?? '';
    return { content: c, model: j.model || model, usage: j.usage || null };
  } finally { clearTimeout(timer); }
}

// 流式：onDelta(textChunk)；返回完整拼接文本
async function chatStream({ base_url, api_key, model, messages, max_tokens = 4096, temperature = 0.7, timeout_ms = 240000, onDelta }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout_ms);
  let full = '';
  try {
    const r = await fetch(chatEndpoint(base_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
      body: JSON.stringify({ model, messages, max_tokens, temperature, stream: true }),
      signal: ctl.signal,
    });
    if (!r.ok || !r.body) throw new Error(`上游 ${r.status}：${(await r.text()).slice(0, 300)}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const t = j.choices?.[0]?.delta?.content || '';
          if (t) { full += t; onDelta && onDelta(t); }
        } catch { /* 忽略残缺行 */ }
      }
    }
    return full;
  } finally { clearTimeout(timer); }
}

module.exports = { chatEndpoint, chatOnce, chatStream };
