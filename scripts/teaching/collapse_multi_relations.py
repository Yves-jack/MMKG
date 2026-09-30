#!/usr/bin/env python3
"""对课堂 KG 中「两端点多关系」调用 LLM 收成单条，写出裁决 JSON 供前端加载。

用法:
  python -m scripts.teaching.collapse_multi_relations --lecture 1
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.utils.env import load_project_env  # noqa: E402
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config  # noqa: E402

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore


def _load_llm_cfg() -> dict:
    path = ROOT / "configs" / "teaching.yaml"
    if yaml is None or not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return data.get("llm") or {}


PROMPT_PATH = ROOT / "prompts" / "stage1" / "multi_relation_collapse.txt"
DEFAULT_PIPELINE = (
    ROOT
    / "web"
    / "teachkg-showcase"
    / "public"
    / "data"
    / "pipeline"
    / "pipeline_build_lecture_{lecture}.json"
)
DEFAULT_OUT = (
    ROOT
    / "web"
    / "teachkg-showcase"
    / "public"
    / "data"
    / "pipeline"
    / "multi_rel_collapse_lecture_{lecture}.json"
)

ALLOWED = {"belong_to", "part_of", "depend_on", "synonym_of", "related_with"}


def _rel(e: dict[str, Any]) -> str:
    return str(e.get("relation") or e.get("label") or "").strip()


def _pair_key(a: str, b: str) -> str:
    return "\t".join(sorted([a, b]))


def _primary_zh(name: str) -> str:
    return (name or "").split("/", 1)[0].strip()


def load_merge_edges(pipeline_path: Path) -> list[dict[str, Any]]:
    raw = json.loads(pipeline_path.read_text(encoding="utf-8"))
    edges: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw.get("items") or []:
        stages = item.get("stages") or {}
        st: dict[str, Any] = {}
        if isinstance(stages, dict):
            st = stages.get("7") or stages.get(7) or {}
        elif isinstance(stages, list):
            for cand in stages:
                if not isinstance(cand, dict):
                    continue
                sid = str(cand.get("id") or "")
                if sid in ("7", "merge", "fused") or "融合" in str(cand.get("title") or ""):
                    st = cand
                    break
            if not st and stages:
                # 常见：下标 7 为 merge
                if len(stages) > 7 and isinstance(stages[7], dict):
                    st = stages[7]
                else:
                    st = stages[-1] if isinstance(stages[-1], dict) else {}
        for e in st.get("edges") or []:
            if not e.get("from") or not e.get("to"):
                continue
            key = f"{e['from']}\t{_rel(e)}\t{e['to']}\t{e.get('source') or ''}"
            if key in seen:
                continue
            seen.add(key)
            edges.append(e)
    return edges


def collect_multi_rel_groups(edges: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """跳过 property_of 后，收集无向端点对上关系种类>1 的组。"""
    groups: dict[str, list[dict[str, Any]]] = {}
    for e in edges:
        if _rel(e) == "property_of":
            continue
        a, b = str(e["from"]), str(e["to"])
        if a == b:
            continue
        k = _pair_key(a, b)
        groups.setdefault(k, []).append(e)
    return {
        k: g
        for k, g in groups.items()
        if len({_rel(x) for x in g}) > 1
    }


def _extract_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            raise
        return json.loads(m.group(0))


def collapse_one(
    client: LLMClient,
    template: str,
    entity_a: str,
    entity_b: str,
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    payload = []
    for e in candidates:
        payload.append(
            {
                "from": e.get("from"),
                "to": e.get("to"),
                "relation": _rel(e),
                "concrete": e.get("concrete") or e.get("concrete_relation") or "",
                "source": e.get("source") or "",
                "context": (e.get("context") or "")[:180],
            }
        )
    prompt = (
        template.replace("{{entity_a}}", entity_a)
        .replace("{{entity_b}}", entity_b)
        .replace("{{candidates_json}}", json.dumps(payload, ensure_ascii=False, indent=2))
    )
    raw = client.chat(prompt, temperature=0.1)
    data = _extract_json(raw)
    frm = str(data.get("from") or "").strip()
    to = str(data.get("to") or "").strip()
    rel = str(data.get("relation") or "").strip()
    if frm not in (entity_a, entity_b) or to not in (entity_a, entity_b) or frm == to:
        raise ValueError(f"invalid endpoints in LLM output: {data}")
    if rel not in ALLOWED:
        raise ValueError(f"invalid relation {rel}")
    return {
        "from": frm,
        "to": to,
        "relation": rel,
        "concrete": str(data.get("concrete") or "").strip(),
        "reason": str(data.get("reason") or "").strip(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lecture", default="1")
    ap.add_argument("--pipeline", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    lecture = str(args.lecture)
    pipeline_path = Path(
        args.pipeline or str(DEFAULT_PIPELINE).format(lecture=lecture)
    )
    out_path = Path(args.out or str(DEFAULT_OUT).format(lecture=lecture))
    if not pipeline_path.is_file():
        print(f"missing pipeline: {pipeline_path}", file=sys.stderr)
        return 1
    if not PROMPT_PATH.is_file():
        print(f"missing prompt: {PROMPT_PATH}", file=sys.stderr)
        return 1

    edges = load_merge_edges(pipeline_path)
    groups = collect_multi_rel_groups(edges)
    print(f"lecture={lecture} merge_edges={len(edges)} multi_rel_pairs={len(groups)}")
    for k, g in groups.items():
        rels = sorted({_rel(x) for x in g})
        print(f"  {_primary_zh(k.split(chr(9))[0])} ~ {_primary_zh(k.split(chr(9))[1])}: {', '.join(rels)}")

    if args.dry_run:
        return 0

    load_project_env()  # 读取项目根 .env 中的 DASHSCOPE_API_KEY
    cfg = _load_llm_cfg()
    client = LLMClient(**llm_settings_from_config(cfg))
    if not client.api_key:
        print(
            "LLM API key missing after loading .env "
            "(expect DASHSCOPE_API_KEY / LLM_API_KEY in project root .env)",
            file=sys.stderr,
        )
        return 1
    template = PROMPT_PATH.read_text(encoding="utf-8")

    decisions: dict[str, Any] = {}
    for key, cands in groups.items():
        a, b = key.split("\t", 1)
        try:
            dec = collapse_one(client, template, a, b, cands)
            decisions[key] = dec
            print(f"OK { _primary_zh(a) }/{ _primary_zh(b) } -> {dec['relation']} ({dec.get('reason','')[:40]})")
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL {a} | {b}: {exc}", file=sys.stderr)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "lecture_id": lecture,
        "prompt": str(PROMPT_PATH.relative_to(ROOT)).replace("\\", "/"),
        "pair_count": len(groups),
        "decided": len(decisions),
        "decisions": decisions,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out_path} ({len(decisions)} decisions)")
    return 0 if len(decisions) == len(groups) else 2


if __name__ == "__main__":
    raise SystemExit(main())
