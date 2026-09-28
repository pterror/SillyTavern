#!/usr/bin/env python3
"""Write one reference-id fixture per tokenizer file, using the vendors' own tools.

Usage:
    python generate.py MANIFEST.json SAMPLES.json OUT_DIR

For this directory's fixtures:
    python tests/fixtures/tokenizer-reference/generate.py manifest.json \
        tests/fixtures/tokenizer-reference/samples.json tests/fixtures/tokenizer-reference

Needs the reference tools each format is checked against: pip install tokenizers sentencepiece
mistral-common transformers tiktoken. Their versions are recorded in each fixture.

MANIFEST.json is a JSON array of {"path": <local file>, "format": <format>, "file": <descriptor>}:
- "format" is a registry format: "hf-json", "sentencepiece", "tekken" or "tiktoken".
- "path" is the tokenizer file on this machine. For "tiktoken" (Kimi) it is the directory holding
  the repo revision's tiktoken.model, tokenization_kimi.py and tokenizer_config.json.
- "llamaModels" (Meta's tiktoken files: Llama 3.x original/tokenizer.model, Llama 4 tokenizer.model)
  reads the file with Meta's own code instead: {"dir": <a checkout of github.com/meta-llama/llama-models
  holding models/>, "commit": <its full commit>, "module": "models.llama3.tokenizer" or
  "models.llama4.tokenizer"}. "path" is then the tokenizer file itself.
- "file" is copied into the fixture and tells src/tokenizer-exactness.test.js where SillyTavern
  keeps the file: {"bundled": "src/tokenizers/<name>"}, {"download": <url>, "cacheName": <name in
  DATA_ROOT/_cache>}, {"registry": <TOKENIZER_SOURCES id>} or {"sameContentAs": <sha256 of the
  fixture of the file SillyTavern reads>, "repo": <repo>, "revision": <full commit>, "path": <path in
  the repo>} for a file with the same content as that one. A file on a host without revisions has
  {"sameContentAs": <sha256>, "url": <its URL>} instead.

Each fixture is written as OUT_DIR/<sha256>.json.
"""
import hashlib
import json
import os
import platform
import sys
from importlib.metadata import version as pkg_version

CALLS = {
    "hf-json": ("tokenizers", "Tokenizer.from_file(p).encode(text, add_special_tokens=False).ids"),
    "sentencepiece": ("sentencepiece", "SentencePieceProcessor(model_file=p).encode(text)"),
    "tekken": ("mistral-common", "Tekkenizer.from_file(p).encode(text, bos=False, eos=False)"),
    "tiktoken": (
        "transformers",
        "AutoTokenizer.from_pretrained(d, trust_remote_code=True).encode(text)"
        " (HF_HUB_OFFLINE=1; d = local dir with the revision's tiktoken.model, tokenization_kimi.py, tokenizer_config.json)",
    ),
}


def load_meta_encoder(path, llama_models):
    import importlib
    from pathlib import Path
    sys.path.insert(0, llama_models["dir"])
    t = importlib.import_module(llama_models["module"]).Tokenizer(Path(path))
    return lambda text: t.encode(text, bos=False, eos=False)


def meta_call(llama_models):
    return (
        f"{llama_models['module']}.Tokenizer(Path(p)).encode(text, bos=False, eos=False)"
        f" (meta-llama/llama-models @ {llama_models['commit']})"
    )


def load_encoder(fmt, path):
    if fmt == "hf-json":
        from tokenizers import Tokenizer
        tok = Tokenizer.from_file(path)
        return lambda text: tok.encode(text, add_special_tokens=False).ids
    if fmt == "sentencepiece":
        from sentencepiece import SentencePieceProcessor
        sp = SentencePieceProcessor(model_file=path)
        return lambda text: sp.encode(text)
    if fmt == "tekken":
        from mistral_common.tokens.tokenizers.tekken import Tekkenizer
        tk = Tekkenizer.from_file(path)
        return lambda text: tk.encode(text, bos=False, eos=False)
    if fmt == "tiktoken":
        os.environ["HF_HUB_OFFLINE"] = "1"
        from transformers import AutoTokenizer
        t = AutoTokenizer.from_pretrained(path, trust_remote_code=True)
        return lambda text: t.encode(text)
    raise ValueError(f"unknown format {fmt}")


def data_file(fmt, path, llama_models):
    return os.path.join(path, "tiktoken.model") if fmt == "tiktoken" and not llama_models else path


def main():
    manifest_path, samples_path, out_dir = sys.argv[1:4]
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    with open(samples_path, encoding="utf-8") as f:
        samples = json.load(f)
    os.makedirs(out_dir, exist_ok=True)
    for entry in manifest:
        fmt, path, llama_models = entry["format"], entry["path"], entry.get("llamaModels")
        with open(data_file(fmt, path, llama_models), "rb") as f:
            blob = f.read()
        sha = hashlib.sha256(blob).hexdigest()
        if llama_models:
            tool, call = "tiktoken", meta_call(llama_models)
            enc = load_meta_encoder(path, llama_models)
        else:
            tool, call = CALLS[fmt]
            enc = load_encoder(fmt, path)
        rows = [{"text": s, "ids": [int(i) for i in enc(s)]} for s in samples]
        head = {
            "sha256": sha,
            "bytes": len(blob),
            "format": fmt,
            "file": entry["file"],
            "reference": {"tool": tool, "version": pkg_version(tool), "call": call, "python": platform.python_version()},
        }
        head_json = json.dumps(head, ensure_ascii=False)
        lines = ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows)
        with open(os.path.join(out_dir, f"{sha}.json"), "w", encoding="utf-8") as f:
            f.write(head_json[:-1] + ', "samples": [\n' + lines + "\n]}\n")
        print(sha, fmt, json.dumps(entry["file"]))


if __name__ == "__main__":
    main()
