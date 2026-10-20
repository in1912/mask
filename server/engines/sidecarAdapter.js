'use strict';
// 边车适配器：python/sidecar.py 在本机起的 HTTP 服务承载 Presidio / GLiNER-PII / argus-redact。
// 协议（均为 JSON）：
//   GET  /probe?engine=<id>            → {ok:bool, error?:string, detail?:object}
//   POST /detect {engine, text, lang}  → {ok:bool, entities?:[{term,start,end,type}], error?:string}
// 只连配置里的 sidecar_url（默认本机 9812），绝不外网。
// 探测会真 import 引擎：GLiNER/OPF 首次 import 要拉 torch 和模型代码，8 秒不够
const PROBE_TIMEOUT = 30000;
// 首次调用要加载 1~3GB 模型（CPU），30 秒会误判为失败；加载完常驻内存，之后毫秒级
const DETECT_TIMEOUT = 180000;

async function sidecarCall(base, path, init, timeoutMs) {
  const url = String(base || '').replace(/\/+$/, '') + path;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`边车连不上（${url}）：${e.cause?.code || e.message}——先启动 python/sidecar.py（默认 http://127.0.0.1:9812）`);
  }
  let text = '';
  try { text = await res.text(); } catch { /* 读不到按空处理 */ }
  let body = null;
  if (text.trim()) { try { body = JSON.parse(text); } catch { body = null; } }
  clearTimeout(timer);
  return { status: res.status, body, text: text.trim(), contentType: res.headers.get('content-type') || '' };
}

// 地址填成了别的 HTTP 服务（最常见：填成本系统自己的 9909，回的是 SPA 首页 HTML）
function nonJsonError(r, base) {
  const looksHtml = /text\/html/i.test(r.contentType) || /^<(?:!doctype|html)/i.test(r.text);
  if (looksHtml) {
    return new Error(
      `边车地址返回的是网页（HTTP ${r.status}），不是边车的 JSON——你填的 ${base} 很可能是本系统自己的地址`
      + `（本系统默认端口 9909）；边车是独立的 Python 进程 python/sidecar.py，默认 http://127.0.0.1:9812`
    );
  }
  return new Error(
    `边车响应不是 JSON（HTTP ${r.status}${r.contentType ? '，' + r.contentType : ''}）——`
    + `确认地址指向 python/sidecar.py（默认 http://127.0.0.1:9812），而不是别的网页服务`
  );
}

async function sidecarProbe(base, id) {
  const r = await sidecarCall(base, `/probe?engine=${encodeURIComponent(id)}`, { method: 'GET' }, PROBE_TIMEOUT);
  if (!r.body || typeof r.body !== 'object') throw nonJsonError(r, base);
  if (r.status === 404) throw new Error(`边车不认识引擎 ${id}（边车版本不一致？）`);
  if (typeof r.body.ok !== 'boolean') {
    throw new Error(`边车响应异常（HTTP ${r.status}）${r.body.error ? '：' + r.body.error : '：JSON 里没有 ok 字段'}——确认地址是 python/sidecar.py（默认 9812）`);
  }
  return r.body;
}

async function sidecarDetect(base, id, text, lang) {
  const r = await sidecarCall(base, '/detect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: id, text: String(text || ''), lang: lang || '' }),
  }, DETECT_TIMEOUT);
  if (!r.body || typeof r.body !== 'object') throw nonJsonError(r, base);
  if (r.status !== 200 || r.body.ok !== true) {
    throw new Error((r.body && r.body.error) || `边车 detect 失败（HTTP ${r.status}）——确认地址是 python/sidecar.py（默认 9812）`);
  }
  return { entities: Array.isArray(r.body.entities) ? r.body.entities : [] };
}

module.exports = { sidecarProbe, sidecarDetect };
