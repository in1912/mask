'use strict';
// 边车适配器：python/sidecar.py 在本机起的 HTTP 服务承载 Presidio / GLiNER-PII / argus-redact。
// 协议（均为 JSON）：
//   GET  /probe?engine=<id>            → {ok:bool, error?:string, detail?:object}
//   POST /detect {engine, text, lang}  → {ok:bool, entities?:[{term,start,end,type}], error?:string}
// 只连配置里的 sidecar_url（默认本机 9812），绝不外网。
// 探测会真 import 引擎并加载模型：GLiNER/OPF 冷启动（首次 import + 1~3GB 权重）实测可超过 30 秒，
// 30 秒会把「正在加载」误判成失败（下一次再探又好，用户看到的是随机失败）
const PROBE_TIMEOUT = 120000;
// 首次调用要加载 1~3GB 模型（CPU），30 秒会误判为失败；加载完常驻内存，之后毫秒级
const DETECT_TIMEOUT = 180000;

async function fetchOnce(url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// v0.4.10：连不上时先看边车到底怎么了。
// 之前只抛一句 UND_ERR_SOCKET，用户不知道是没启动、启动后崩了、还是 MASK_NO_SIDECAR 挡着。
// 现在本机地址会再尝试拉起一次（20 秒上限），恢复就静默重试，不恢复就把进程状态和日志尾贴进错误。
async function sidecarCall(base, path, init, timeoutMs) {
  const url = String(base || '').replace(/\/+$/, '') + path;
  let res;
  try {
    res = await fetchOnce(url, init, timeoutMs);
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`边车请求超时（${url}，${Math.round(timeoutMs / 1000)} 秒）——引擎可能在加载模型，稍后重试`);
    }
    const first = e.cause?.code || e.message;
    let launcher = null;
    try { launcher = require('../sidecarLauncher'); } catch { /* 升级包缺文件时照旧报原错 */ }
    if (launcher) {
      const rec = await launcher.recover(base, Number(process.env.MASK_SIDECAR_RECOVER_MS || 20000));
      if (rec.remote) {
        throw new Error(`边车连不上（${url}）：${first}——${base} 不是本机地址，本服务不会替你拉起，请检查那台机器上的 python/sidecar.py`);
      }
      if (rec.ok) {
        try {
          res = await fetchOnce(url, init, timeoutMs);
        } catch (e2) {
          if (e2.name === 'AbortError') {
            throw new Error(`边车请求超时（${url}，${Math.round(timeoutMs / 1000)} 秒）——引擎可能在加载模型，稍后重试`);
          }
          throw new Error(`边车刚被重新拉起，但仍连不上（${url}）：${e2.cause?.code || e2.message}`
            + launcher.diagnose(base));
        }
      } else if (rec.skipped) {
        throw new Error(`边车连不上（${url}）：${first}——自动拉起已被 MASK_NO_SIDECAR=1 关闭`
          + launcher.diagnose(base));
      } else {
        throw new Error(`边车连不上（${url}）：${first}——本服务尝试自动拉起也没成功（日志 Logs/sidecar.log）`
          + launcher.diagnose(base));
      }
    } else {
      throw new Error(`边车连不上（${url}）：${first}——先启动 python/sidecar.py（默认 http://127.0.0.1:9812）`);
    }
  }
  let text = '';
  try { text = await res.text(); } catch { /* 读不到按空处理 */ }
  let body = null;
  if (text.trim()) { try { body = JSON.parse(text); } catch { body = null; } }
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
