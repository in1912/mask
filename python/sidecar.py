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

# 项目内依赖目录（pip --target 安装）/ 模型目录：首次启动由 scripts/engines-setup.mjs 铺好
_HERE = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_HERE, "vendor")
_MODELS = os.path.join(_HERE, "models")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HOME", os.path.join(_MODELS, "hf"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("OPF_CHECKPOINT", os.path.join(_MODELS, "opf"))
os.environ.setdefault("MASK_GLINER_MODEL", os.path.join(_MODELS, "gliner_multi_pii-v1"))

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
        # NoOpNlpEngine：不需要下载 spaCy 模型；Presidio 的规则识别器本来就不依赖 NER。
        # 中文结构化类型（手机号/身份证/银行卡）用自定义正则识别器补上。
        from presidio_analyzer import AnalyzerEngine, RecognizerRegistry, Pattern, PatternRecognizer  # noqa: 惰性导入
        from presidio_analyzer.nlp_engine import NoOpNlpEngine

        nlp = NoOpNlpEngine([{"lang_code": "zh", "model_name": "noop"}, {"lang_code": "en", "model_name": "noop"}])
        registry = RecognizerRegistry(supported_languages=["zh", "en"])
        registry.load_predefined_recognizers(languages=["en"])
        # NoOpNlpEngine 不能和依赖 NLP 的识别器共存；预置列表里的 SpacyRecognizer 必须摘掉，
        # 否则 AnalyzerEngine 构造直接 ValueError（其余规则识别器不受影响）。
        for rec in list(registry.recognizers):
            if rec.__class__.__name__ in ("SpacyRecognizer", "StanzaRecognizer"):
                try:
                    registry.remove_recognizer(rec.name)
                except Exception:
                    registry.recognizers.remove(rec)
        for name, regex, entity, score in (
            ("cn_mobile", r"(?<!\d)1[3-9]\d{9}(?!\d)", "CN_PHONE", 0.85),
            ("cn_id_card", r"(?<!\d)\d{17}[\dXx](?!\d)", "CN_ID_CARD", 0.85),
            ("cn_bank_card", r"(?<!\d)\d{16,19}(?!\d)", "CN_BANK_CARD", 0.55),
        ):
            registry.add_recognizer(PatternRecognizer(
                supported_entity=entity, name=name, supported_language="zh",
                patterns=[Pattern(name=name, regex=regex, score=score)],
            ))
        eng = AnalyzerEngine(registry=registry, nlp_engine=nlp, supported_languages=["zh", "en"])
        _loaded["presidio"] = eng
        return eng


# Presidio 的类型名 → 主进程 TYPE_MAP 认识的名字
_PRESIDIO_TYPES = {
    "CN_PHONE": "PHONE", "CN_ID_CARD": "ID_CARD", "CN_BANK_CARD": "BANK_ACCOUNT",
    "EMAIL_ADDRESS": "EMAIL", "PHONE_NUMBER": "PHONE", "CREDIT_CARD": "BANK_ACCOUNT",
    "IP_ADDRESS": "IP", "URL": "URL", "IBAN_CODE": "BANK_ACCOUNT",
    "PERSON": "PERSON", "LOCATION": "ADDRESS", "ORG": "ORGANIZATION",
}


def _presidio_entities(text, lang):
    analyzer = _presidio_engine()
    # 中英文识别器各跑一遍再合并：中文文本里的邮箱/URL 也能被英文规则吃到，
    # 中英混排时也不用赌语言判定（宁多跑一遍，不漏手机号/身份证）。
    langs = ["zh", "en"]
    seen, out = set(), []
    for lg in langs:
        for r in analyzer.analyze(text=text, language=lg, score_threshold=0.4):
            key = (r.start, r.end, r.entity_type)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "term": text[r.start:r.end], "start": r.start, "end": r.end,
                "type": _PRESIDIO_TYPES.get(r.entity_type, r.entity_type),
            })
    return out


# ---------------------------------------------------------------- GLiNER-PII
GLINER_LABELS = [
    "person", "organization", "phone number", "address", "passport number",
    "email", "credit card number", "social security number", "iban",
    "ip address", "date of birth", "national id", "drivers license",
]


class _CjkWordsSplitter:
    """GLiNER 默认按空白切词——中文整句会变成一个「词」，实体边界全丢。
    这里把中日韩字符逐个切开，英文/数字/邮箱/网址仍按整段切。"""
    _RE = re.compile(r"[㐀-䶿一-鿿]|[A-Za-z0-9_@.+%:/\\-]+|\S")

    def __call__(self, text):
        for m in self._RE.finditer(text):
            yield (m.group(0), m.start(), m.end())


def _gliner_engine():
    with _lock("gliner"):
        if "gliner" in _loaded:
            return _loaded["gliner"]
        from gliner import GLiNER  # noqa: 惰性导入
        model_id = os.environ.get("MASK_GLINER_MODEL", "urchade/gliner_multi_pii-v1")
        if os.path.isdir(model_id):
            model = GLiNER.from_pretrained(model_id, local_files_only=True)
        else:
            model = GLiNER.from_pretrained(model_id)
        # from_pretrained 会把额外 kwargs 同时传给模型构造器（那里不认 words_splitter），
        # 所以加载完再替换数据处理器里的切词器。
        model.data_processor.words_splitter = _CjkWordsSplitter()
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
# argus_redact.redact(text, report=True) → RedactReport，其中 entities 是
# 带 original/start/end/type 的字典元组（0.8.x 实测形态）。默认 fast 档只跑
# 正则+本地词表，不联网；ner/auto 档才会碰外部模型，面具不启用。
def _argus_entities(text, lang):
    try:
        import argus_redact  # noqa: 惰性导入
    except ImportError as e:
        raise RuntimeError("未安装：pip install argus-redact（%s）" % e)
    language = lang or ("zh" if _cjk_ratio(text) > 0.05 else "en")
    try:
        rep = argus_redact.redact(text, lang=language, mode="fast", report=True)
    except TypeError:
        # 老版本没有 report/mode 参数，退回默认返回值并如实说明拿不到实体
        raise RuntimeError("argus-redact 版本过旧：需要支持 report=True 的版本（>=0.8）")
    except Exception as e:
        raise RuntimeError("argus-redact 调用失败：%s" % e)
    out = []
    for it in getattr(rep, "entities", ()) or ():
        term = (it.get("original") or "") if isinstance(it, dict) else ""
        if not term:
            continue
        out.append({
            "term": term,
            "start": int(it.get("start", 0)),
            "end": int(it.get("end", 0)),
            "type": str(it.get("type") or "ARGUS"),
        })
    return out


# ---------------------------------------------------------------- scrubadub
def _scrubadub_engine():
    with _lock("scrubadub"):
        if "scrubadub" in _loaded:
            return _loaded["scrubadub"]
        import scrubadub  # noqa: 惰性导入
        scrubber = scrubadub.Scrubber()
        _loaded["scrubadub"] = scrubber
        return scrubber


def _scrubadub_entities(text, lang):
    scrubber = _scrubadub_engine()
    out = []
    for f in scrubber.iter_filth(text):
        beg, end = getattr(f, "beg", None), getattr(f, "end", None)
        term = getattr(f, "text", "") or ""
        if beg is None or end is None or not term:
            continue
        out.append({"term": term, "start": beg, "end": end,
                    "type": str(getattr(f, "type", "") or "PII").upper()})
    return out


# ---------------------------------------------------------------- OpenAI Privacy Filter
# 1.5B MoE token 分类模型，纯本地 CPU 推理；模型目录由 scripts/engines-setup.mjs 预先下载。
def _opf_engine():
    with _lock("opf"):
        if "opf" in _loaded:
            return _loaded["opf"]
        from opf import OPF  # noqa: 惰性导入
        eng = OPF(model=os.environ.get("OPF_CHECKPOINT") or None, device="cpu")
        _loaded["opf"] = eng
        return eng


_OPF_TYPES = {
    "private_person": "PERSON", "other_person": "PERSON",
    "personal_name": "PERSON", "personal_handle": "NICKNAME",
    "private_email": "EMAIL", "personal_email": "EMAIL", "other_email": "EMAIL",
    "private_phone": "PHONE", "personal_phone": "PHONE", "other_phone": "PHONE",
    "private_address": "ADDRESS", "personal_location": "ADDRESS", "other_location": "ADDRESS",
    "private_date": "DATE_TIME", "personal_date": "DATE_TIME", "other_date": "DATE_TIME",
    "private_url": "URL", "personal_url": "URL", "other_url": "URL", "secret_url": "URL",
    "account_number": "BANK_ACCOUNT", "personal_fin_id": "BANK_ACCOUNT",
    "personal_gov_id": "ID_CARD", "personal_health_id": "ID_CARD",
    "personal_org": "ORGANIZATION", "secret": "SECRET",
}


def _opf_entities(text, lang):
    eng = _opf_engine()
    res = eng.redact(text)
    out = []
    for sp in getattr(res, "detected_spans", ()) or ():
        term = getattr(sp, "text", "") or ""
        if not term:
            continue
        out.append({
            "term": term, "start": int(getattr(sp, "start", 0)), "end": int(getattr(sp, "end", 0)),
            "type": _OPF_TYPES.get(getattr(sp, "label", ""), getattr(sp, "label", "")),
        })
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
        "pip": "pip install presidio-analyzer presidio-anonymizer spacy",
        "detect": lambda text, lang: _presidio_entities(text, lang),
        "note": "Microsoft Presidio 分析器（NoOp NLP + 中文结构化规则，无需 spaCy 模型）",
    },
    "scrubadub": {
        "module": "scrubadub",
        "pip": "pip install scrubadub",
        "detect": lambda text, lang: _scrubadub_entities(text, lang),
        "note": "LeapBeyond/scrubadub（邮箱/电话/URL/信用卡等规则识别）",
    },
    "opf": {
        "module": "opf",
        "pip": "pip install <本地 privacy-filter>（模型由 scripts/engines-setup.mjs 下载）",
        "detect": lambda text, lang: _opf_entities(text, lang),
        "note": "OpenAI Privacy Filter（1.5B MoE，本地 CPU 推理）",
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
        "detect": lambda text, lang: _argus_entities(text, lang),
        "note": "PyPI argus-redact（fast 档：本地正则+词表，不联网）",
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
