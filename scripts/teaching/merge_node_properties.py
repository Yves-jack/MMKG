#!/usr/bin/env python3
"""对 kg_processed 中节点 properties 调用 LLM 适当合并，写回产物。

用法:
  python -m scripts.teaching.merge_node_properties --scope course
  python -m scripts.teaching.merge_node_properties --scope lecture --lecture 1
  python -m scripts.teaching.merge_node_properties --scope all-lectures --workers 6
  python -m scripts.teaching.merge_node_properties --scope course --dry-run
  python -m scripts.teaching.merge_node_properties --scope course --apply-only

层级：
  - lecture：单课（讲次）图谱特性
  - course：整课图谱特性（与重要性同理，两套独立产物）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
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

PROMPT_PATH = ROOT / "prompts" / "stage3" / "node_property_merge.txt"
DEFAULT_COURSE = "离散数学(图论+数理逻辑与集合论)"


def _load_llm_cfg(*, prefer_sjtu: bool = True) -> dict:
    """默认用 SJTU（teaching_lisan.yaml: deepseek-chat）；否则 teaching.yaml。"""
    names = (
        ("teaching_lisan.yaml", "teaching.yaml")
        if prefer_sjtu
        else ("teaching.yaml", "teaching_lisan.yaml")
    )
    for name in names:
        path = ROOT / "configs" / name
        if yaml is None or not path.is_file():
            continue
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        cfg = dict(data.get("llm") or {})
        if cfg:
            cfg["_config_file"] = name
            return cfg
    return {}


def _primary_zh(name: str) -> str:
    return (name or "").split("/", 1)[0].strip()


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


def _normalize_props(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for x in raw:
        t = str(x or "").strip()
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def resolve_paths(course: str, scope: str, lecture: str) -> tuple[Path, Path, Path]:
    """返回 (public_kg_processed, viz_kg_processed, decisions_out)。"""
    if scope == "course":
        stem = "kg_processed_course"
        dec_name = "property_merge_course.json"
    else:
        stem = f"kg_processed_lecture_{lecture}"
        dec_name = f"property_merge_lecture_{lecture}.json"
    public = (
        ROOT
        / "web"
        / "teachkg-showcase"
        / "public"
        / "data"
        / "courses"
        / course
        / "pipeline"
        / f"{stem}.json"
    )
    viz = ROOT / "data" / "viz" / course / f"{stem}.json"
    decisions = public.parent / dec_name
    return public, viz, decisions


def list_lecture_ids(course: str) -> list[str]:
    public_dir = (
        ROOT
        / "web"
        / "teachkg-showcase"
        / "public"
        / "data"
        / "courses"
        / course
        / "pipeline"
    )
    viz_dir = ROOT / "data" / "viz" / course
    ids: set[str] = set()
    for d in (public_dir, viz_dir):
        if not d.is_dir():
            continue
        for p in d.glob("kg_processed_lecture_*.json"):
            m = re.match(r"kg_processed_lecture_(\d+)\.json$", p.name)
            if m:
                ids.add(m.group(1))
    return sorted(ids, key=lambda x: int(x))


def collect_candidates(
    nodes: list[dict[str, Any]], *, min_props: int
) -> list[dict[str, Any]]:
    cands: list[dict[str, Any]] = []
    for n in nodes:
        eid = str(n.get("id") or "").strip()
        props = _normalize_props(n.get("properties"))
        if not eid or len(props) < min_props:
            continue
        cands.append({"id": eid, "zh": _primary_zh(eid), "properties": props})
    return cands


def merge_one(
    client: LLMClient,
    template: str,
    entity_id: str,
    entity_zh: str,
    properties: list[str],
) -> dict[str, Any]:
    prompt = (
        template.replace("{{entity_id}}", entity_id)
        .replace("{{entity_zh}}", entity_zh or _primary_zh(entity_id))
        .replace(
            "{{properties_json}}",
            json.dumps(properties, ensure_ascii=False, indent=2),
        )
    )
    raw = client.chat(prompt, temperature=0.2)
    data = _extract_json(raw)
    merged = _normalize_props(data.get("properties"))
    if not merged:
        raise ValueError("empty properties from LLM")
    if len(merged) > len(properties):
        # 不允许变多；截断到原长度（极少见）
        merged = merged[: len(properties)]
    return {
        "properties": merged,
        "reason": str(data.get("reason") or "").strip(),
        "before_count": len(properties),
        "after_count": len(merged),
    }


def apply_decisions(
    nodes: list[dict[str, Any]], decisions: dict[str, Any]
) -> tuple[list[dict[str, Any]], int]:
    changed = 0
    out: list[dict[str, Any]] = []
    for n in nodes:
        eid = str(n.get("id") or "").strip()
        dec = decisions.get(eid) if eid else None
        if not isinstance(dec, dict):
            out.append(n)
            continue
        merged = _normalize_props(dec.get("properties"))
        if not merged:
            out.append(n)
            continue
        prev = _normalize_props(n.get("properties"))
        if prev == merged:
            out.append(n)
            continue
        out.append({**n, "properties": merged})
        changed += 1
    return out, changed


def main() -> int:
    ap = argparse.ArgumentParser(description="LLM 合并节点特性")
    ap.add_argument("--course", default=DEFAULT_COURSE)
    ap.add_argument(
        "--scope",
        choices=("course", "lecture", "all-lectures"),
        default="course",
        help="course=整课；lecture=单讲；all-lectures=批量所有 kg_processed_lecture_*",
    )
    ap.add_argument("--lecture", default="1")
    ap.add_argument(
        "--lectures",
        default="",
        help="逗号分隔讲次（配合 --scope lecture 或限定 all-lectures）",
    )
    ap.add_argument("--min-props", type=int, default=2, help="至少几条特性才调用 LLM")
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少个节点（0=不限）")
    ap.add_argument("--dry-run", action="store_true", help="只统计候选，不调 LLM")
    ap.add_argument(
        "--apply-only",
        action="store_true",
        help="不调 LLM，仅把已有 property_merge_*.json 写回 kg_processed",
    )
    ap.add_argument("--input", default="", help="覆盖 kg_processed 路径")
    ap.add_argument(
        "--model",
        default="",
        help="覆盖模型名；默认 SJTU deepseek-chat（teaching_lisan.yaml）",
    )
    ap.add_argument(
        "--dashscope",
        action="store_true",
        help="改用 teaching.yaml / DashScope（默认走 SJTU）",
    )
    ap.add_argument(
        "--workers",
        type=int,
        default=6,
        help="并发请求数（默认 6；过大易触发限流）",
    )
    ap.add_argument(
        "--skip-existing",
        action="store_true",
        help="跳过已有裁决的节点（增量重跑）",
    )
    args = ap.parse_args()

    if not PROMPT_PATH.is_file():
        print(f"missing prompt: {PROMPT_PATH}", file=sys.stderr)
        return 1

    # —— 批量单课 ——
    if args.scope == "all-lectures":
        lids = list_lecture_ids(args.course)
        if args.lectures.strip():
            want = {x.strip() for x in args.lectures.split(",") if x.strip()}
            lids = [x for x in lids if x in want]
        if not lids:
            print("no kg_processed_lecture_*.json found", file=sys.stderr)
            return 1
        print(f"all-lectures: {len(lids)} files → {', '.join(lids)}", flush=True)
        # 预创建一次 LLM，各讲复用
        client: LLMClient | None = None
        template = ""
        if not args.dry_run and not args.apply_only:
            load_project_env()
            cfg = _load_llm_cfg(prefer_sjtu=not args.dashscope)
            model = (args.model or "").strip() or None
            client = LLMClient(**llm_settings_from_config(cfg, model=model))
            print(
                f"llm config={cfg.get('_config_file') or '?'} "
                f"model={client.model} base={client.base_url}",
                flush=True,
            )
            if not client.api_key:
                print(
                    "LLM API key missing "
                    "(expect SJTU_LLM_API_KEY / LLM_API_KEY)",
                    file=sys.stderr,
                )
                return 1
            template = PROMPT_PATH.read_text(encoding="utf-8")
            try:
                sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass

        rc = 0
        for lid in lids:
            print(f"\n======== lecture {lid} ========", flush=True)
            code = run_one(
                course=args.course,
                scope="lecture",
                lecture=lid,
                min_props=args.min_props,
                limit=args.limit,
                dry_run=args.dry_run,
                apply_only=args.apply_only,
                input_path=args.input,
                workers=args.workers,
                skip_existing=args.skip_existing,
                client=client,
                template=template,
            )
            if code != 0:
                rc = code
        return rc

    return run_one(
        course=args.course,
        scope=args.scope,
        lecture=str(args.lecture),
        min_props=args.min_props,
        limit=args.limit,
        dry_run=args.dry_run,
        apply_only=args.apply_only,
        input_path=args.input,
        workers=args.workers,
        skip_existing=args.skip_existing,
        dashscope=args.dashscope,
        model=args.model,
    )


def run_one(
    *,
    course: str,
    scope: str,
    lecture: str,
    min_props: int = 2,
    limit: int = 0,
    dry_run: bool = False,
    apply_only: bool = False,
    input_path: str = "",
    workers: int = 6,
    skip_existing: bool = False,
    dashscope: bool = False,
    model: str = "",
    client: LLMClient | None = None,
    template: str = "",
) -> int:
    public_path, viz_path, decisions_path = resolve_paths(
        course, scope, lecture
    )
    src = Path(input_path) if input_path else public_path
    if not src.is_file() and viz_path.is_file():
        src = viz_path
    if not src.is_file():
        print(f"missing kg_processed: {src}", file=sys.stderr)
        print("请先运行: npm run export-kg-processed", file=sys.stderr)
        return 1

    doc = json.loads(src.read_text(encoding="utf-8"))
    nodes = list(doc.get("nodes") or [])
    cands = collect_candidates(nodes, min_props=max(2, min_props))
    if limit and limit > 0:
        cands = cands[:limit]

    print(
        f"scope={scope} lecture={lecture} "
        f"nodes={len(nodes)} candidates={len(cands)} min_props={min_props}",
        flush=True,
    )
    for c in cands[:8]:
        print(f"  {c['zh']} · {len(c['properties'])} 条", flush=True)
    if len(cands) > 8:
        print(f"  … 另有 {len(cands) - 8} 个节点", flush=True)

    if dry_run:
        return 0

    decisions: dict[str, Any] = {}
    if apply_only:
        if not decisions_path.is_file():
            print(f"missing decisions: {decisions_path}", file=sys.stderr)
            return 1
        payload = json.loads(decisions_path.read_text(encoding="utf-8"))
        decisions = payload.get("decisions") or {}
        print(f"apply-only decisions={len(decisions)} from {decisions_path}")
    else:
        if client is None:
            load_project_env()
            cfg = _load_llm_cfg(prefer_sjtu=not dashscope)
            model_override = (model or "").strip() or None
            client = LLMClient(
                **llm_settings_from_config(cfg, model=model_override)
            )
            print(
                f"llm config={cfg.get('_config_file') or '?'} "
                f"model={client.model} base={client.base_url}",
                flush=True,
            )
            if not client.api_key:
                print(
                    "LLM API key missing "
                    "(expect SJTU_LLM_API_KEY / LLM_API_KEY)",
                    file=sys.stderr,
                )
                return 1
            template = PROMPT_PATH.read_text(encoding="utf-8")
            try:
                sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
        if not template:
            template = PROMPT_PATH.read_text(encoding="utf-8")

        if decisions_path.is_file():
            try:
                old = json.loads(decisions_path.read_text(encoding="utf-8"))
                decisions.update(old.get("decisions") or {})
            except Exception:  # noqa: BLE001
                pass

        todo = cands
        if skip_existing and decisions:
            todo = [c for c in cands if c["id"] not in decisions]
            print(
                f"skip-existing: {len(cands) - len(todo)} done, "
                f"{len(todo)} remaining",
                flush=True,
            )

        n_workers = max(1, int(workers or 1))
        print(f"workers={n_workers} todo={len(todo)}", flush=True)

        lock = threading.Lock()
        ok = 0
        fail = 0
        done = 0
        total = len(todo)
        assert client is not None

        def _checkpoint() -> None:
            decisions_path.parent.mkdir(parents=True, exist_ok=True)
            out_dec = {
                "course_id": course,
                "scope": scope,
                "lecture_id": "course" if scope == "course" else lecture,
                "prompt": str(PROMPT_PATH.relative_to(ROOT)).replace("\\", "/"),
                "candidate_count": len(cands),
                "decided": ok,
                "failed": fail,
                "workers": n_workers,
                "decisions": decisions,
            }
            text = json.dumps(out_dec, ensure_ascii=False, indent=2)
            decisions_path.write_text(text, encoding="utf-8")
            viz_dec = ROOT / "data" / "viz" / course / decisions_path.name
            viz_dec.parent.mkdir(parents=True, exist_ok=True)
            viz_dec.write_text(text, encoding="utf-8")

        def _job(c: dict[str, Any]) -> tuple[str, str, dict[str, Any] | None, str]:
            eid = c["id"]
            try:
                dec = merge_one(
                    client, template, eid, c["zh"], c["properties"]
                )
                return eid, c["zh"], dec, ""
            except Exception as exc:  # noqa: BLE001
                return eid, c["zh"], None, str(exc)

        if total == 0:
            print("nothing to merge", flush=True)
        elif n_workers == 1:
            for c in todo:
                eid, zh, dec, err = _job(c)
                done += 1
                if dec is not None:
                    decisions[eid] = dec
                    ok += 1
                    print(
                        f"[{done}/{total}] OK {zh}: "
                        f"{dec['before_count']}→{dec['after_count']} "
                        f"({(dec.get('reason') or '')[:48]})",
                        flush=True,
                    )
                else:
                    fail += 1
                    print(
                        f"[{done}/{total}] FAIL {zh}: {err}",
                        file=sys.stderr,
                        flush=True,
                    )
                if done % 10 == 0:
                    _checkpoint()
        else:
            with ThreadPoolExecutor(max_workers=n_workers) as pool:
                futures = {pool.submit(_job, c): c for c in todo}
                for fut in as_completed(futures):
                    eid, zh, dec, err = fut.result()
                    with lock:
                        done += 1
                        cur = done
                        if dec is not None:
                            decisions[eid] = dec
                            ok += 1
                            print(
                                f"[{cur}/{total}] OK {zh}: "
                                f"{dec['before_count']}→{dec['after_count']} "
                                f"({(dec.get('reason') or '')[:48]})",
                                flush=True,
                            )
                        else:
                            fail += 1
                            print(
                                f"[{cur}/{total}] FAIL {zh}: {err}",
                                file=sys.stderr,
                                flush=True,
                            )
                        if cur % 10 == 0 or cur == total:
                            _checkpoint()

        _checkpoint()
        print(f"wrote {decisions_path} ({ok} ok, {fail} fail)", flush=True)

    new_nodes, changed = apply_decisions(nodes, decisions)
    doc["nodes"] = new_nodes
    doc["property_merge"] = {
        "applied": changed,
        "decisions_file": decisions_path.name,
        "scope": scope,
    }
    text = json.dumps(doc, ensure_ascii=False)
    for dest in {src.resolve(), public_path.resolve(), viz_path.resolve()}:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
        print(f"updated {dest} (nodes with properties changed: {changed})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
