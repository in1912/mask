'use strict';
// 边车适配器：python/sidecar.py 在本机起的 HTTP 服务承载 Presidio / GLiNER-PII / argus-redact。
// 协议（均为 JSON）：
//   GET  /probe?engine=<id>            → {ok:bool, error?:string, detail?:object}
//   POST /detect {engine, text, lang}  → {ok:bool, entities?:[{term,start,end,type}], error?:string}
// 只连配置里的 sidecar_url（默认本机 9812），绝不外网。
const PROBE_TIMEOUT = 8000;
const DETECT_TIMEOUT = 30000; // GLiNER 首次调用要加载模型，给足

async function sidecarCall(base, path, init, timeoutMs) {
  const url = String(base || '').replace(/\/+$/, '') + path;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`边车连不上（${url}）：${e.cause?.code || e.message}——先启动 python/sidecar.py`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 按空处理 */ }
  clearTimeout(timer);
  return { status: res.status, body };
}

async function sidecarProbe(base, id) {
  const r = await sidecarCall(base, `/probe?engine=${encodeURIComponent(id)}`, { method: 'GET' }, PROBE_TIMEOUT);
  if (r.status === 404) throw new Error(`边车不认识引擎 ${id}（版本不一致？）`);
  if (!r.body || typeof r.body.ok !== 'boolean') throw new Error(`边车响应异常（HTTP ${r.status}）`);
  return r.body;
}

async function sidecarDetect(base, id, text, lang) {
  const r = await sidecarCall(base, '/detect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: id, text: String(text || ''), lang: lang || '' }),
  }, DETECT_TIMEOUT);
  if (r.status !== 200 || !r.body || r.body.ok !== true) {
    throw new Error((r.body && r.body.error) || `边车 detect 失败（HTTP ${r.status}）`);
  }
  return { entities: Array.isArray(r.body.entities) ? r.body.entities : [] };
}

module.exports = { sidecarProbe, sidecarDetect };
