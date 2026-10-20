#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
面具 mask — 本地引擎边车（Python 侧）。

承载 Presidio / GLiNER-PII / argus-redact 三个 Python 引擎 + 一个无依赖的自检引擎，
以本机 HTTP 服务形式给 Node 主进程调用（协议见 server/engines/sidecarAdapter.js）。

设计原则：
  * 纯标准库起服务；第三方引擎惰性 import——没装 pip 包就如实报「未安装」，绝不含糊。
  * 只监听本机回环地址，不对外；主进程传来的原文不出本机。
  * 大模型（GLiNER）首次调用才加载并常驻内存，之后毫秒级。

用法：
  python sidecar.py [--port 9812] [--host 127.0.0.1]

依赖（按需，不装也能起服务）：
  pip install presidio-analyzer presidio-anonymizer spacy && python -m spacy download en_core_web_md
  pip install gliner                       # 模型默认 knowledgator/gliner-pii，首次调用自动下载
  pip install argus-redact
"""
import argparse
import importlib
import importlib.util
import io
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:  # Windows 控制台 UTF-8 输出，避免中文日志乱码
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MAX_TEXT = 2 * 1024 * 1024  # 2MB 文本上限
_locks = {}
_loaded = {}  # 引擎单例缓存


def _lock(name):
    if name not in _locks:
        _locks[name] = threading.Lock()
    return _locks[name]


def _installed(module):
    try:
        return importlib.util.find_spec(module) is not None
    except Exception:
        return False


# ---------------------------------------------------------------- 自检引擎
# 无第三方依赖。故意把 start/end 写错（返回 0/1），考验主进程的按内容重定位能力。
def _selftest_entities(text):
    out = []
    for m in re.finditer(r"1[3-9]\d{9}", text):
        out.append({"term": m.group(0), "start": 0, "end": 1, "type": "PHONE"})
    for m in re.finditer(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text):
        out.append({"term": m.group(0), "start": 0, "end": 1, "type": "EMAIL"})
    # 一个内置正则天然吃不到的类型，验证 EXT 码通路
    if "打卡机" in text:
        out.append({"term": "打卡机", "start": 0, "end": 1, "type": "DEVICE_XYZ"})
    return out


# ---------------------------------------------------------------- Presidio
def _presidio_engine():
    with _lock("presidio"):
        if "presidio" in _loaded:
            return _loaded["presidio"]
        from presidio_analyzer import AnalyzerEngine  # noqa: 惰性导入
        eng = AnalyzerEngine()
        _loaded["presidio"] = eng
        return eng


def _presidio_entities(text, lang):
    analyzer = _presidio_engine()
    language = lang or ("zh" if _cjk_ratio(text) > 0.3 else "en")
    results = analyzer.analyze(text=text, language=language, score_threshold=0.4)
    return [
        {"term": text[r.start:r.end], "start": r.start, "end": r.end, "type": r.entity_type}
        for r in results
    ]


# ---------------------------------------------------------------- GLiNER-PII
GLINER_LABELS = [
    "person", "organization", "phone number", "address", "passport number",
    "email", "credit card number", "social security number", "iban",
    "ip address", "date of birth", "national id", "drivers license",
]


def _gliner_engine():
    with _lock("gliner"):
        if "gliner" in _loaded:
            return _loaded["gliner"]
        from gliner import GLiNER  # noqa: 惰性导入
        model_id = os.environ.get("MASK_GLINER_MODEL", "knowledgator/gliner-pii")
        model = GLiNER.from_pretrained(model_id)
        _loaded["gliner"] = model
        return model


def _gliner_entities(text):
    model = _gliner_engine()
    threshold = float(os.environ.get("MASK_GLINER_THRESHOLD", "0.4"))
    ents = model.predict_entities(text, GLINER_LABELS, threshold=threshold)
    return [
        {"term": e.get("text", ""), "start": e.get("start", 0), "end": e.get("end", 0), "type": e.get("label", "")}
        for e in ents
        if e.get("text")
    ]


# ---------------------------------------------------------------- argus-redact
# PyPI 包，公开 API 形态没有跨版本稳定承诺：这里尝试常见入口，都失败就如实报错，
# 提示用户在 sidecar.py 里补一小段适配（函数就一个，改起来十分钟）。
def _argus_entities(text):
    try:
        import argus_redact  # noqa: 惰性导入
    except ImportError as e:
        raise RuntimeError("未安装：pip install argus-redact（%s）" % e)
    cands = []
    for fn_name in ("redact", "redact_text", "find_pii", "extract_pii", "scan"):
        fn = getattr(argus_redact, fn_name, None)
        if callable(fn):
            cands.append(fn_name)
    if not cands:
        raise RuntimeError(
            "argus-redact 已安装但没找到可用入口（试过 %s）。请在 python/sidecar.py 的 _argus_entities 里按其文档补适配"
            % ", ".join(cands or ["-"])
        )
    # 先试最常见形态：fn(text) → 带偏移的结果列表
    fn = getattr(argus_redact, cands[0])
    try:
        raw = fn(text)
    except Exception as e:
        raise RuntimeError("argus-redact 调用失败：%s" % e)
    out = []
    for it in raw or []:
        if isinstance(it, dict):
            term = it.get("text") or it.get("term") or it.get("match") or ""
            s = it.get("start", 0)
            e_ = it.get("end", 0)
            typ = it.get("type") or it.get("label") or "ARGUS"
            if term:
                out.append({"term": term, "start": s, "end": e_, "type": typ})
        elif isinstance(it, (tuple, list)) and len(it) >= 3:
            s, e_, term = it[0], it[1], it[2]
            out.append({"term": term, "start": s, "end": e_, "type": "ARGUS"})
    return out


# ---------------------------------------------------------------- 引擎分派
ENGINES = {
    "selftest": {
        "module": None,
        "detect": lambda text, lang: _selftest_entities(text),
        "note": "无依赖自检引擎（固定回手机号/邮箱，坐标故意写错以验证重定位）",
    },
    "presidio": {
        "module": "presidio_analyzer",
        "pip": "pip install presidio-analyzer presidio-anonymizer spacy && python -m spacy download en_core_web_md",
        "detect": lambda text, lang: _presidio_entities(text, lang),
        "note": "Microsoft Presidio 分析器",
    },
    "gliner": {
        "module": "gliner",
        "pip": "pip install gliner",
        "detect": lambda text, lang: _gliner_entities(text),
        "note": "knowledgator/gliner-pii 零样本 PII 抽取（模型 MASK_GLINER_MODEL，阈值 MASK_GLINER_THRESHOLD）",
    },
    "argus": {
        "module": "argus_redact",
        "pip": "pip install argus-redact",
        "detect": lambda text, lang: _argus_entities(text),
        "note": "PyPI argus-redact（API 兼容性自适配备尽力）",
    },
}


def _cjk_ratio(s):
    if not s:
        return 0.0
    cjk = sum(1 for ch in s if "一" <= ch <= "鿿")
    return cjk / len(s)


def probe(engine_id):
    spec = ENGINES.get(engine_id)
    if not spec:
        return {"ok": False, "error": "边车没有这个引擎：%s" % engine_id}
    if spec["module"] is None:
        return {"ok": True, "detail": spec["note"]}
    if not _installed(spec["module"]):
        return {"ok": False, "error": "未安装 %s：%s" % (spec["module"], spec["pip"])}
    try:  # 装了就真 import 一遍，import 半成功（缺子依赖）也能当场暴露
        importlib.import_module(spec["module"])
        return {"ok": True, "detail": spec["note"]}
    except Exception as e:
        return {"ok": False, "error": "导入失败（依赖不完整？）：%s" % e}


def detect(engine_id, text, lang):
    spec = ENGINES.get(engine_id)
    if not spec:
        raise RuntimeError("边车没有这个引擎：%s" % engine_id)
    if len(text) > MAX_TEXT:
        raise RuntimeError("文本超边车上限（%d 字节）" % MAX_TEXT)
    return spec["detect"](text, lang)


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 精简日志：只记方法/路径/耗时，绝不记文本
        sys.stderr.write("[sidecar] %s %s\n" % (self.command, self.path.split("?")[0]))

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/health":
            engines = {
                eid: (True if s["module"] is None else _installed(s["module"]))
                for eid, s in ENGINES.items()
            }
            return self._json(200, {"ok": True, "engines": engines})
        if path == "/probe":
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            eid = (q.get("engine") or [""])[0]
            return self._json(200, probe(eid))
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/detect":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_TEXT + 65536:
                return self._json(413, {"ok": False, "error": "请求体过大"})
            req = json.loads(self.rfile.read(n).decode("utf-8"))
            eid = req.get("engine", "")
            text = req.get("text", "")
            lang = req.get("lang", "")
            entities = detect(eid, text, lang)
            return self._json(200, {"ok": True, "entities": entities})
        except RuntimeError as e:  # 引擎侧如实报错（未安装/超限/不兼容）
            return self._json(200, {"ok": False, "error": str(e)})
        except Exception as e:  # 协议/解析异常
            return self._json(200, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def main():
    ap = argparse.ArgumentParser(description="面具本地引擎边车")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9812)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("[sidecar] listening on http://%s:%d" % (args.host, args.port), flush=True)
    for eid, s in ENGINES.items():
        state = "内置" if s["module"] is None else ("已装" if _installed(s["module"]) else "未装")
        print("[sidecar]   %-10s %s — %s" % (eid, state, s["note"]), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
