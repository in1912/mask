#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面具 mask — 模型预取（幂等）。

把两个模型的权重落到 python/models/ 下，之后边车完全离线加载：
  * GLiNER-PII   urchade/gliner_multi_pii-v1      （~1.1GB）
  * OpenAI Privacy Filter  openai/privacy-filter  （~2.8GB，仓库里在 original/ 子目录）

国内网络通过 HF_ENDPOINT=https://hf-mirror.com 走镜像；xet 传输常超时，关掉。
由 scripts/engines-setup.mjs 调用，也可单独运行：
    python python/fetch_models.py
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 依赖是用 pip --target 装在 python/vendor 里的，不在系统 site-packages：
# 不显式加进 sys.path，`import huggingface_hub` 必然 ModuleNotFoundError
# （生产 v0.4.8 就是这么炸的——本机因为有模型、ensureModels 直接跳过，一直没走到这里）
_VENDOR = str(HERE / "vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)
MODELS = Path(os.environ.get("MASK_MODELS_DIR") or (HERE / "models"))
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HOME", str(MODELS / "hf"))

from huggingface_hub import hf_hub_download, snapshot_download  # noqa: E402  (必须先设环境变量)

if "--check-deps" in sys.argv:  # 自检用：只验证依赖能导入，不下载任何东西
    import huggingface_hub
    print(f"[models] huggingface_hub {huggingface_hub.__version__} @ {_VENDOR}")
    raise SystemExit(0)


def ensure_gliner() -> bool:
    target = MODELS / "gliner_multi_pii-v1"
    tokenizer_cfg = target / "tokenizer_config.json"
    ready = ((target / "pytorch_model.bin").is_file() and tokenizer_cfg.is_file()
             and (MODELS / "hf" / "hub" / "models--microsoft--mdeberta-v3-base").is_dir())
    if ready:
        try:
            import json
            ready = bool(json.loads(tokenizer_cfg.read_text(encoding="utf-8")).get("tokenizer_class"))
        except Exception:
            ready = False
    if ready:
        print(f"[models] GLiNER 已就绪：{target}", flush=True)
        return True
    print(f"[models] 下载 GLiNER-PII → {target}", flush=True)
    snapshot_download("urchade/gliner_multi_pii-v1", local_dir=str(target))
    # 仓库本身不带分词器：GLiNER 会回退到基座 mDeBERTa 的分词器，离线前先抓齐
    if not (target / "spm.model").is_file() or not (target / "config.json").is_file():
        snapshot_download(
            "microsoft/mdeberta-v3-base",
            local_dir=str(target),
            allow_patterns=["config.json", "tokenizer*", "*.model", "special_tokens_map.json", "sentencepiece*"],
        )
    # mDeBERTa 的 tokenizer_config 只有 do_lower_case/vocab_type，没有 tokenizer_class。
    # transformers 5.x 猜不出类名时只试 fast tokenizer，仓库又没有 tokenizer.json，
    # 于是报「Couldn't instantiate the backend tokenizer」。显式指明慢速类即可（已实测）。
    import json
    cfg = json.loads(tokenizer_cfg.read_text(encoding="utf-8")) if tokenizer_cfg.is_file() else {}
    cfg.setdefault("do_lower_case", False)
    cfg["tokenizer_class"] = "DebertaV2Tokenizer"
    cfg["vocab_file"] = "spm.model"
    tokenizer_cfg.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    # gliner_config.json 没写 encoder_config，GLiNER 会用 `model_name`（microsoft/mdeberta-v3-base）
    # 去 hub 取 AutoConfig；离线加载要求它在 HF 缓存里，所以显式预取一份。
    hf_hub_download("microsoft/mdeberta-v3-base", "config.json")
    return True


def ensure_opf() -> bool:
    target = MODELS / "opf"
    if (target / "config.json").is_file() and any(target.glob("*.safetensors")):
        print(f"[models] OpenAI Privacy Filter 已就绪：{target}", flush=True)
        return True
    print(f"[models] 下载 OpenAI Privacy Filter → {target}（约 2.8GB）", flush=True)
    snapshot_download("openai/privacy-filter", local_dir=str(target), allow_patterns=["original/*"])
    original = target / "original"
    if not original.is_dir():
        raise RuntimeError(f"下载结果缺少 original/ 子目录：{target}")
    for p in original.iterdir():
        dest = target / p.name
        if p.is_dir():
            import shutil
            shutil.copytree(p, dest, dirs_exist_ok=True)
        elif not dest.exists():
            p.replace(dest)
    return True


def main() -> int:
    MODELS.mkdir(parents=True, exist_ok=True)
    try:
        ensure_gliner()
        ensure_opf()
    except Exception as e:
        print(f"[models] 失败：{type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return 1
    print("[models] 全部就绪。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
