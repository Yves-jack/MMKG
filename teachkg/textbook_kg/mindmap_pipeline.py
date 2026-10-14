"""讲次导图流水线（四步）：

1. 讲次图谱 → 规则初稿 → LLM 整理
2. 子树章节匹配（根可为任意节点）→ 增加章节层并裁剪到讲次导图 → LLM 微调
3. 融合各讲次的章节部分 → LLM 简单拼接合并
4. 合并各章为整课导图，并按目录增加分部层
"""

from __future__ import annotations

import json
import logging
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from teachkg.textbook_kg.mindmap_tree import MindmapResult, TreeNode, build_mindmap_tree
from teachkg.textbook_kg.propagate_importance import propagate_importance_to_parents
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)

PROMPT_TIDY = "stage1/mindmap_tidy_lecture.txt"
PROMPT_ASSIGN = "stage1/mindmap_assign_chapters.txt"
PROMPT_TUNE_LECTURE = "stage1/mindmap_tune_lecture_chapters.txt"
PROMPT_MERGE_CHAPTER = "stage1/mindmap_merge_chapter.txt"


def chapter_file_slug(chapter: str) -> str:
    bare = re.sub(r"^第\s*\d+\s*章\s*", "", str(chapter or "")).strip()
    base = bare or str(chapter or "chapter")
    for ch in '<>:"|?*':
        base = base.replace(ch, "_")
    return base.replace("/", "_").replace("\\", "_").replace(" ", "_")[:80]


def _with_graph_propagation(kg: dict[str, Any], importance: dict[str, float]) -> dict[str, float]:
    entities = kg.get("entities") or []
    node_ids = [
        str(e.get("id") or e.get("name") or "").strip()
        for e in entities
        if str(e.get("id") or e.get("name") or "").strip()
    ]
    return propagate_importance_to_parents(
        importance, kg.get("edges") or [], node_ids=node_ids or None
    )


def load_classroom_importance(
    root: Path, course: str, lecture_id: str | None = None
) -> dict[str, float]:
    """优先课堂归一化分（by_context / classroom），与课堂图谱一致。"""
    path = root / "data/kg" / course / "entity_importance_feedback.json"
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    classroom: dict[str, float] = {}
    if lecture_id and lecture_id != "course":
        ctx = (raw.get("by_context") or {}).get(f"lecture:{lecture_id}") or {}
        if isinstance(ctx.get("classroom"), dict):
            for k, v in ctx["classroom"].items():
                try:
                    classroom[str(k)] = float(v)
                except (TypeError, ValueError):
                    pass
        for name, rec in (ctx.get("entities") or {}).items():
            if not isinstance(rec, dict):
                continue
            cn = rec.get("classroom_norm")
            if cn is None:
                continue
            try:
                classroom[str(name)] = float(cn)
            except (TypeError, ValueError):
                pass
        if classroom:
            return classroom
    if isinstance(raw.get("classroom"), dict):
        for k, v in raw["classroom"].items():
            try:
                classroom[str(k)] = float(v)
            except (TypeError, ValueError):
                pass
        if classroom:
            return classroom
    scores = raw.get("scores") or {}
    out: dict[str, float] = {}
    for k, v in scores.items():
        try:
            out[str(k)] = float(v)
        except (TypeError, ValueError):
            pass
    return out


def _prune_tree_node(
    node: TreeNode,
    *,
    depth: int,
    max_depth: int,
    max_children: int,
    budget: list[int],
) -> TreeNode | None:
    if budget[0] <= 0:
        return None
    budget[0] -= 1
    kids_src = sorted(node.children, key=lambda c: -c.importance)[: max(0, max_children)]
    kids: list[TreeNode] = []
    for child in kids_src:
        if depth + 1 >= max_depth:
            continue
        pruned = _prune_tree_node(
            child,
            depth=depth + 1,
            max_depth=max_depth,
            max_children=max_children,
            budget=budget,
        )
        if pruned is not None:
            kids.append(pruned)
    return TreeNode(
        id=node.id,
        zh=node.zh,
        importance=node.importance,
        relation=node.relation,
        children=kids,
        related=list(node.related),
        copy=node.copy,
    )


def _recompute_result_stats(result: MindmapResult) -> MindmapResult:
    trees = result.roots or ([result.root] if result.root else [])
    kept: set[str] = set()

    def collect(n: TreeNode) -> None:
        kept.add(n.id)
        for c in n.children:
            collect(c)

    for t in trees:
        collect(t)

    def depth_of_node(n: TreeNode) -> int:
        if not n.children:
            return 1
        return 1 + max(depth_of_node(c) for c in n.children)

    max_d = max((depth_of_node(t) for t in trees), default=1)
    result.n_nodes = len(kept)
    result.max_depth = max_d
    if trees:
        result.root = trees[0]
    return result


def build_lecture_draft(
    kg: dict[str, Any],
    *,
    importance: dict[str, float] | None = None,
    chapter: str | None = None,
    max_nodes: int = 80,
    max_depth: int = 5,
    max_children: int = 10,
) -> MindmapResult:
    imp = _with_graph_propagation(kg, dict(importance or {}))
    result = build_mindmap_tree(
        kg,
        importance=imp,
        chapter=chapter,
        max_nodes=max_nodes,
        max_depth=max_depth,
        max_children=max_children,
    )
    trees = result.roots or ([result.root] if result.root else [])
    budget = [max(1, max_nodes)]
    pruned: list[TreeNode] = []
    for t in trees:
        if budget[0] <= 0:
            break
        p = _prune_tree_node(
            t,
            depth=0,
            max_depth=max_depth,
            max_children=max_children,
            budget=budget,
        )
        if p is not None:
            pruned.append(p)
    if pruned:
        result.roots = pruned
        result = _recompute_result_stats(result)
    meta = dict(result.meta or {})
    meta["pipeline"] = "rule_draft"
    meta["source"] = "kg"
    result.meta = meta
    return result


def node_to_dict(node: TreeNode | dict[str, Any]) -> dict[str, Any]:
    if isinstance(node, TreeNode):
        return node.to_dict()
    if isinstance(node, dict):
        return deepcopy(node)
    raise TypeError(f"expected TreeNode or dict, got {type(node)!r}")


def result_to_doc(result: MindmapResult) -> dict[str, Any]:
    doc = result.to_dict()
    meta = dict(doc.get("meta") or {})
    meta.setdefault("pipeline", "rule_draft")
    meta.setdefault("source", "kg")
    doc["meta"] = meta
    return doc


def collect_node_map(trees: list[Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}

    def walk(n: Any) -> None:
        d = node_to_dict(n)
        nid = str(d.get("id") or "")
        if nid:
            out[nid] = d
        for c in d.get("children") or []:
            walk(c)

    for t in trees:
        walk(t)
    return out


def count_nodes(n: TreeNode | dict[str, Any]) -> int:
    d = node_to_dict(n)
    return 1 + sum(count_nodes(c) for c in d.get("children") or [])


def depth_of(n: TreeNode | dict[str, Any], d: int = 0) -> int:
    node = node_to_dict(n)
    kids = node.get("children") or []
    if not kids:
        return d
    return max(depth_of(c, d + 1) for c in kids)


def forest_stats(trees: list[Any]) -> tuple[int, int]:
    if not trees:
        return 0, 0
    total = sum(count_nodes(t) for t in trees)
    max_d = max(depth_of(t) for t in trees)
    return total, max_d


def compact_for_llm(trees: list[Any], *, max_depth: int = 4) -> list[dict[str, Any]]:
    def compact(n: Any, depth: int) -> dict[str, Any]:
        d = node_to_dict(n)
        out: dict[str, Any] = {
            "id": d.get("id"),
            "zh": d.get("zh"),
        }
        if depth < max_depth:
            children = d.get("children") or []
            if children:
                out["children"] = [compact(c, depth + 1) for c in children[:12]]
        return out

    return [compact(t, 0) for t in trees]


def extract_json_obj(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    text = text.replace("｛", "{").replace("｝", "}").replace("：", ":")
    parsed = LLMClient.parse_json_response(text)
    if isinstance(parsed, dict) and parsed:
        return parsed
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {}
    blob = m.group(0)
    for variant in (blob, re.sub(r",\s*}", "}", blob), re.sub(r",\s*]", "]", blob)):
        try:
            obj = json.loads(variant)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return {}


def _hydrate_from_draft(
    llm_node: dict[str, Any],
    draft_map: dict[str, dict[str, Any]],
    *,
    seen: set[str],
) -> dict[str, Any] | None:
    nid = str(llm_node.get("id") or "")
    if not nid:
        return None
    draft = draft_map.get(nid)
    if draft is None:
        return None
    is_dup = nid in seen
    seen.add(nid)
    out: dict[str, Any] = {
        "id": nid,
        "zh": llm_node.get("zh") or draft.get("zh") or nid,
        "importance": float(draft.get("importance") or 0.0),
        "relation": draft.get("relation"),
        "related": list(draft.get("related") or []),
        "children": [],
    }
    if draft.get("copy"):
        out["copy"] = True
    if is_dup:
        out["copy"] = True
        return out
    for ch in llm_node.get("children") or []:
        if not isinstance(ch, dict):
            continue
        hydrated = _hydrate_from_draft(ch, draft_map, seen=seen)
        if hydrated is not None:
            out["children"].append(hydrated)
    return out


def _parse_merges(payload: dict[str, Any]) -> dict[str, str]:
    raw = payload.get("merges")
    out: dict[str, str] = {}
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        src = str(item.get("from") or item.get("source") or "").strip()
        dst = str(item.get("to") or item.get("target") or "").strip()
        if src and dst and src != dst:
            out[src] = dst
    return out


def _existing_id_redirects(doc: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    meta = doc.get("meta") if isinstance(doc.get("meta"), dict) else {}
    for blob in (meta.get("id_redirects"), doc.get("id_redirects")):
        if not isinstance(blob, dict):
            continue
        for k, v in blob.items():
            src, dst = str(k or "").strip(), str(v or "").strip()
            if src and dst:
                out[src] = dst
    return out


def canonicalize_id_redirects(
    existing: dict[str, str] | None,
    merges: dict[str, str] | None,
    kept: set[str],
) -> dict[str, str]:
    """旧 id → 树上仍在的规范 id；源若仍在树中则不作重定向。"""
    combined: dict[str, str] = {}
    for blob in (existing, merges):
        if not blob:
            continue
        for k, v in blob.items():
            src, dst = str(k or "").strip(), str(v or "").strip()
            if src and dst and src != dst:
                combined[src] = dst
    resolved: dict[str, str] = {}
    for src in combined:
        if not src or src.startswith("__") or src in kept:
            continue
        seen = {src}
        cur = str(combined.get(src) or "").strip()
        while cur and cur in combined and cur not in seen and cur not in kept:
            seen.add(cur)
            cur = str(combined[cur]).strip()
        if cur in kept and cur != src:
            resolved[src] = cur
    return resolved


def resolve_concept_id(node_id: str, redirects: dict[str, str] | None) -> str:
    cur = str(node_id or "").strip()
    if not cur or not redirects:
        return cur
    seen: set[str] = set()
    for _ in range(16):
        nxt = str(redirects.get(cur) or "").strip()
        if not nxt or nxt == cur or cur in seen:
            break
        seen.add(cur)
        cur = nxt
    return cur


def _rewrite_concept_links(
    links: list[Any] | None, redirects: dict[str, str]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not isinstance(links, list):
        return out
    seen: set[tuple[str, str, str]] = set()
    for item in links:
        if not isinstance(item, dict):
            continue
        cid = resolve_concept_id(
            str(item.get("concept_id") or item.get("conceptId") or ""),
            redirects,
        )
        kind = str(item.get("target_kind") or item.get("targetKind") or "").strip()
        tid = str(item.get("target_id") or item.get("targetId") or "").strip()
        if not cid or not kind or not tid:
            continue
        key = (cid, kind, tid)
        if key in seen:
            continue
        seen.add(key)
        rec = dict(item)
        rec["concept_id"] = cid
        rec["target_kind"] = kind
        rec["target_id"] = tid
        out.append(rec)
    return out


def apply_llm_tidy(
    draft_doc: dict[str, Any],
    llm_payload: dict[str, Any],
    *,
    min_keep_ratio: float = 0.35,
) -> dict[str, Any]:
    draft_trees = draft_doc.get("roots") or (
        [draft_doc["root"]] if draft_doc.get("root") else []
    )
    draft_count = sum(count_nodes(t) for t in draft_trees)
    draft_map = collect_node_map(draft_trees)
    llm_roots = llm_payload.get("roots") or []
    if not llm_roots:
        return deepcopy(draft_doc)

    seen: set[str] = set()
    new_roots: list[dict[str, Any]] = []
    for r in llm_roots:
        if not isinstance(r, dict):
            continue
        h = _hydrate_from_draft(r, draft_map, seen=seen)
        if h is not None:
            new_roots.append(h)
    if not new_roots:
        return deepcopy(draft_doc)

    new_count = sum(count_nodes(t) for t in new_roots)
    if draft_count > 0 and new_count / draft_count < min_keep_ratio:
        logger.warning(
            "LLM tidy kept too few nodes (%d/%d); fallback to draft",
            new_count,
            draft_count,
        )
        return deepcopy(draft_doc)

    out = deepcopy(draft_doc)
    out["roots"] = new_roots
    out["root"] = new_roots[0]
    out["n_nodes"] = new_count
    out["max_depth"] = max(depth_of(t) for t in new_roots)
    meta = dict(out.get("meta") or {})
    meta["pipeline"] = "llm_tidy"
    notes = llm_payload.get("notes")
    if notes:
        meta["llm_tidy_notes"] = str(notes)
    kept = collect_all_ids(new_roots)
    redirects = canonicalize_id_redirects(
        _existing_id_redirects(draft_doc),
        _parse_merges(llm_payload),
        kept,
    )
    meta["id_redirects"] = redirects
    out["id_redirects"] = redirects
    links = draft_doc.get("concept_links")
    if links is None:
        links = (draft_doc.get("meta") or {}).get("concept_links")
    rewritten = _rewrite_concept_links(links if isinstance(links, list) else [], redirects)
    if rewritten:
        out["concept_links"] = rewritten
        meta["concept_links"] = rewritten
    out["meta"] = meta
    return out


def _skeleton_roots(draft_doc: dict[str, Any]) -> list[dict[str, Any]]:
    trees = draft_doc.get("roots") or ([draft_doc["root"]] if draft_doc.get("root") else [])

    def sk(n: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": n.get("id"),
            "zh": n.get("zh"),
            "children": [sk(c) for c in n.get("children") or [] if isinstance(c, dict)],
        }

    return [sk(node_to_dict(t)) for t in trees]


def tidy_lecture_mindmap_with_llm(
    draft_doc: dict[str, Any],
    *,
    course_id: str,
    lecture_id: str,
    chapter_hint: str = "",
    client: LLMClient | None = None,
    llm_cfg: dict[str, Any] | None = None,
    temperature: float = 0.2,
    mock: bool = False,
) -> dict[str, Any]:
    if mock:
        return apply_llm_tidy(draft_doc, {"roots": _skeleton_roots(draft_doc), "notes": "mock"})

    settings = llm_settings_from_config(llm_cfg)
    llm = client or LLMClient(**{k: v for k, v in settings.items() if k in {
        "api_key", "base_url", "model", "max_retry", "retry_pause_sec"
    }})
    compact = compact_for_llm(
        draft_doc.get("roots") or ([draft_doc["root"]] if draft_doc.get("root") else []),
        max_depth=6,
    )
    prompt = format_prompt(
        PROMPT_TIDY,
        course_id=course_id,
        lecture_id=str(lecture_id),
        chapter_hint=chapter_hint or "（无）",
        draft_json=json.dumps(compact, ensure_ascii=False, indent=2),
    )
    raw = llm.chat(prompt, temperature=temperature)
    payload = extract_json_obj(raw)
    return apply_llm_tidy(draft_doc, payload)


def summarize_top_level(trees: list[Any], *, child_limit: int = 6, depth: int = 2) -> str:
    """树结构摘要：默认两层，便于任意深度子树匹配。"""
    lines: list[str] = []

    def walk(n: Any, indent: int, remaining: int) -> None:
        d = node_to_dict(n)
        nid = d.get("id")
        zh = d.get("zh")
        imp = float(d.get("importance") or 0.0)
        prefix = "  " * indent + ("- " if indent == 0 else "· ")
        lines.append(f"{prefix}[{nid}] {zh} (importance={imp:.3f})")
        if remaining <= 0:
            return
        kids = d.get("children") or []
        for c in kids[:child_limit]:
            walk(c, indent + 1, remaining - 1)
        extra = len(kids) - child_limit
        if extra > 0:
            lines.append("  " * (indent + 1) + f"· … +{extra} 个子节点")

    for t in trees:
        walk(t, 0, depth)
    return "\n".join(lines)


def collect_all_ids(trees: list[Any]) -> set[str]:
    out: set[str] = set()

    def walk(n: Any) -> None:
        d = node_to_dict(n)
        nid = str(d.get("id") or "")
        if nid:
            out.add(nid)
        for c in d.get("children") or []:
            walk(c)

    for t in trees:
        walk(t)
    return out


def _is_ancestor_of(trees: list[Any], ancestor_id: str, descendant_id: str) -> bool:
    """ancestor_id 是否为 descendant_id 的真祖先。"""
    if not ancestor_id or not descendant_id or ancestor_id == descendant_id:
        return False

    def path_to(n: Any, target: str, path: list[str]) -> list[str] | None:
        d = node_to_dict(n)
        nid = str(d.get("id") or "")
        cur = path + [nid]
        if nid == target:
            return cur
        for c in d.get("children") or []:
            hit = path_to(c, target, cur)
            if hit is not None:
                return hit
        return None

    for t in trees:
        path = path_to(t, descendant_id, [])
        if path and ancestor_id in path[:-1]:
            return True
    return False


def dedupe_nested_assignments(
    assignments: list[dict[str, Any]],
    trees: list[Any],
) -> list[dict[str, Any]]:
    """去掉嵌套子树：若父已匹配，丢弃其子匹配，避免重复裁剪。"""
    ids = [str(a.get("subtree_root_id") or "") for a in assignments]
    drop: set[str] = set()
    for i, a_id in enumerate(ids):
        if not a_id:
            drop.add(a_id)
            continue
        for j, b_id in enumerate(ids):
            if i == j or not b_id:
                continue
            if _is_ancestor_of(trees, a_id, b_id):
                drop.add(b_id)
    out = [a for a in assignments if str(a.get("subtree_root_id") or "") not in drop]
    if len(out) < len(assignments):
        logger.info(
            "dropped %d nested chapter assignments",
            len(assignments) - len(out),
        )
    return out


def remove_subtrees(trees: list[dict[str, Any]], root_ids: set[str]) -> list[dict[str, Any]]:
    """从森林中裁掉指定子树根（及其子孙），返回剩余顶层节点。"""
    targets = {str(x) for x in root_ids if x}

    def strip(n: dict[str, Any]) -> dict[str, Any] | None:
        nid = str(n.get("id") or "")
        if nid in targets:
            return None
        kids: list[dict[str, Any]] = []
        for c in n.get("children") or []:
            if not isinstance(c, dict):
                continue
            kept = strip(c)
            if kept is not None:
                kids.append(kept)
        out = deepcopy(n)
        out["children"] = kids
        return out

    remaining: list[dict[str, Any]] = []
    for t in trees:
        d = node_to_dict(t)
        kept = strip(d)
        if kept is not None:
            remaining.append(kept)
    return remaining


def _chapter_bare(name: str) -> str:
    return re.sub(r"^第\s*\d+\s*章\s*", "", str(name or "")).strip() or str(name or "")


def _iter_catalog_chapters(catalog: Any) -> list[str]:
    names: list[str] = []
    if catalog is None:
        return names
    if isinstance(catalog, list):
        for item in catalog:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict):
                # 章对象：优先 name
                if isinstance(item.get("name"), str) and item.get("name").strip():
                    names.append(str(item["name"]).strip())
                    continue
                chs = item.get("chapters")
                if isinstance(chs, list):
                    names.extend(_iter_catalog_chapters(chs))
    elif isinstance(catalog, dict):
        if isinstance(catalog.get("chapter_order"), list):
            names.extend(str(x) for x in catalog["chapter_order"] if x)
        for key in ("parts", "volumes", "sections"):
            if isinstance(catalog.get(key), list):
                names.extend(_iter_catalog_chapters(catalog[key]))
        # 单章对象
        if isinstance(catalog.get("name"), str) and catalog.get("name").strip():
            names.append(str(catalog["name"]).strip())
    return list(dict.fromkeys(n for n in names if n))


def format_chapter_catalog(catalog: Any) -> str:
    lines: list[str] = []

    def _ch_label(ch: Any) -> str:
        if isinstance(ch, str):
            return ch
        if isinstance(ch, dict):
            name = str(ch.get("name") or ch.get("title") or "")
            secs = ch.get("sections") or []
            if name and secs:
                return f"{name}（{'；'.join(str(s) for s in secs[:8])}）"
            return name or str(ch)
        return str(ch)

    if isinstance(catalog, list):
        for item in catalog:
            if isinstance(item, str):
                lines.append(f"- {item}")
            elif isinstance(item, dict):
                title = item.get("title") or item.get("name") or item.get("id") or "分册"
                lines.append(f"## {title}")
                for ch in item.get("chapters") or []:
                    label = _ch_label(ch)
                    if label:
                        lines.append(f"  - {label}")
    elif isinstance(catalog, dict):
        parts = catalog.get("parts")
        if isinstance(parts, list) and parts:
            return format_chapter_catalog(parts)
        for ch in catalog.get("chapter_order") or []:
            lines.append(f"- {ch}")
    else:
        lines.append(str(catalog))
    return "\n".join(lines) if lines else "（无目录）"


def _resolve_chapter_name(
    raw: str,
    *,
    candidate_chapters: list[str],
    catalog: Any,
) -> str:
    pool: list[str] = []
    pool.extend(candidate_chapters or [])
    pool.extend(_iter_catalog_chapters(catalog))
    pool = list(dict.fromkeys(p for p in pool if p))
    if not pool:
        return raw
    target = str(raw or "").strip()
    if not target:
        return pool[0]
    bare_t = _chapter_bare(target)
    for p in pool:
        if p == target:
            return p
        if _chapter_bare(p) == bare_t:
            return p
    for p in pool:
        bare_p = _chapter_bare(p)
        if bare_t and bare_p and (bare_t in bare_p or bare_p in bare_t):
            return p
    return pool[0]


def assign_subtrees_with_llm(
    lecture_doc: dict[str, Any],
    *,
    course_id: str,
    lecture_id: str,
    candidate_chapters: list[str],
    catalog: Any,
    client: LLMClient | None = None,
    llm_cfg: dict[str, Any] | None = None,
    temperature: float = 0.1,
    mock: bool = False,
) -> list[dict[str, Any]]:
    """步骤2前半：匹配内容子树到章节（子树根可为任意深度节点）。"""
    trees = lecture_doc.get("roots") or (
        [lecture_doc["root"]] if lecture_doc.get("root") else []
    )
    all_ids = collect_all_ids(trees)
    top_ids = {str(node_to_dict(t).get("id") or "") for t in trees}
    top_ids.discard("")
    fallback = (candidate_chapters or _iter_catalog_chapters(catalog) or [""])[0]

    if mock:
        out: list[dict[str, Any]] = []
        for t in trees:
            d = node_to_dict(t)
            nid = str(d.get("id") or "")
            if not nid or nid.startswith("__"):
                continue
            out.append(
                {
                    "subtree_root_id": nid,
                    "chapter": _resolve_chapter_name(
                        fallback,
                        candidate_chapters=candidate_chapters,
                        catalog=catalog,
                    ),
                    "confidence": 1.0,
                    "reason": "mock",
                }
            )
        return out

    settings = llm_settings_from_config(llm_cfg)
    llm = client or LLMClient(**{k: v for k, v in settings.items() if k in {
        "api_key", "base_url", "model", "max_retry", "retry_pause_sec"
    }})
    prompt = format_prompt(
        PROMPT_ASSIGN,
        course_id=course_id,
        lecture_id=str(lecture_id),
        candidate_chapters="\n".join(f"- {c}" for c in (candidate_chapters or [])) or "（无）",
        chapter_catalog=format_chapter_catalog(catalog),
        tree_summary=summarize_top_level(trees, depth=2),
    )
    raw = llm.chat(prompt, temperature=temperature)
    payload = extract_json_obj(raw)
    assignments = payload.get("assignments") or []
    if not isinstance(assignments, list):
        assignments = []

    validated: list[dict[str, Any]] = []
    seen_roots: set[str] = set()
    for item in assignments:
        if not isinstance(item, dict):
            continue
        rid = str(item.get("subtree_root_id") or "")
        if not rid or rid not in all_ids or rid.startswith("__"):
            logger.warning("drop assignment with unknown subtree_root_id=%r", rid)
            continue
        if rid in seen_roots:
            continue
        ch_raw = str(item.get("chapter") or fallback)
        ch = _resolve_chapter_name(
            ch_raw,
            candidate_chapters=candidate_chapters,
            catalog=catalog,
        )
        if not ch:
            ch = fallback
        seen_roots.add(rid)
        validated.append(
            {
                "subtree_root_id": rid,
                "chapter": ch,
                "confidence": float(item.get("confidence") or 0.0),
                "reason": str(item.get("reason") or ""),
            }
        )

    validated = dedupe_nested_assignments(validated, trees)
    covered = {str(a.get("subtree_root_id") or "") for a in validated}

    # 未被任何已匹配子树覆盖的顶层主题 → 回落到候选章
    remaining = remove_subtrees(
        [node_to_dict(t) for t in trees],
        covered,
    )
    for t in remaining:
        nid = str(t.get("id") or "")
        if not nid or nid.startswith("__") or nid in covered:
            continue
        # 顶层已被抽空子树时仍可能残留壳节点；无 children 且原是虚拟则跳过
        validated.append(
            {
                "subtree_root_id": nid,
                "chapter": _resolve_chapter_name(
                    fallback,
                    candidate_chapters=candidate_chapters,
                    catalog=catalog,
                ),
                "confidence": 0.0,
                "reason": "fallback_unassigned",
            }
        )
    return dedupe_nested_assignments(validated, trees)


def wrap_lecture_by_assignments(
    lecture_doc: dict[str, Any],
    *,
    lecture_id: str,
    assignments: list[dict[str, Any]],
    chapter_hint: str | None = None,
    chapter_order: list[str] | None = None,
) -> dict[str, Any]:
    """步骤2中：按匹配结果裁剪并增加章节层 → 讲 → 章 → 内容子树。"""
    trees = lecture_doc.get("roots") or (
        [lecture_doc["root"]] if lecture_doc.get("root") else []
    )
    trees_d = [node_to_dict(t) for t in trees]
    # 已是讲→章结构则不再包一层
    if trees_d and str(trees_d[0].get("id") or "").startswith("__lecture__/"):
        return deepcopy(lecture_doc)

    clean = dedupe_nested_assignments(assignments or [], trees_d)
    buckets: dict[str, list[dict[str, Any]]] = {}
    seen_order: list[str] = []
    used_ids: set[str] = set()

    def push(chapter: str, node: dict[str, Any]) -> None:
        ch = (chapter or "").strip() or (chapter_hint or "").strip() or "本讲内容"
        if ch not in buckets:
            buckets[ch] = []
            seen_order.append(ch)
        lst = buckets[ch]
        nid = str(node.get("id") or "")
        if nid and any(str(x.get("id") or "") == nid for x in lst):
            return
        lst.append(deepcopy(node))

    for a in clean:
        rid = str(a.get("subtree_root_id") or "")
        st = extract_subtree(trees_d, rid)
        if not st:
            continue
        used_ids.add(rid)
        push(str(a.get("chapter") or ""), st)

    leftover = remove_subtrees(trees_d, used_ids)
    for t in leftover:
        nid = str(t.get("id") or "")
        if not nid or nid.startswith("__"):
            continue
        # 空壳（子树已被抽走）跳过
        if not (t.get("children") or []) and nid in used_ids:
            continue
        push(chapter_hint or "本讲内容", t)

    preferred = [
        *(chapter_order or []),
        *(str(a.get("chapter") or "") for a in clean),
        *([chapter_hint] if chapter_hint else []),
    ]
    preferred = [p for p in preferred if p]

    def ch_num(name: str) -> int:
        m = re.search(r"第\s*(\d+)\s*章", name or "")
        return int(m.group(1)) if m else 10**9

    chapter_names = sorted(
        buckets.keys(),
        key=lambda c: (
            preferred.index(c) if c in preferred else 9999,
            ch_num(c),
            c,
        ),
    )

    chapter_nodes: list[dict[str, Any]] = []
    for ch in chapter_names:
        kids = sorted(
            buckets.get(ch) or [],
            key=lambda n: -float(n.get("importance") or 0.0),
        )
        bare = _chapter_bare(ch)
        chapter_nodes.append(
            {
                "id": f"__chapter__/{bare or ch}",
                "zh": ch,
                "importance": max(
                    [0.45] + [float(k.get("importance") or 0.0) for k in kids]
                ),
                "relation": "toc_chapter",
                "related": [],
                "children": kids,
            }
        )

    root = {
        "id": f"__lecture__/{lecture_id}",
        "zh": f"第 {lecture_id} 讲",
        "importance": 0.9,
        "relation": None,
        "related": [],
        "children": chapter_nodes,
    }
    n_nodes, max_d = forest_stats([root])
    out = deepcopy(lecture_doc)
    out["lecture_id"] = str(lecture_id)
    out["root"] = root
    out["roots"] = [root]
    out["n_nodes"] = n_nodes
    out["max_depth"] = max_d
    meta = dict(out.get("meta") or {})
    meta.update(
        {
            "scope": "lecture",
            "root_zh": f"第 {lecture_id} 讲",
            "virtual_root": True,
            "n_trees": 1,
            "pipeline": "lecture_chapter_wrap",
            "chapter": chapter_names[0] if chapter_names else (chapter_hint or meta.get("chapter")),
            "chapters": chapter_names,
        }
    )
    out["meta"] = meta
    return out


def tune_lecture_chapters_with_llm(
    wrapped_doc: dict[str, Any],
    *,
    course_id: str,
    lecture_id: str,
    client: LLMClient | None = None,
    llm_cfg: dict[str, Any] | None = None,
    temperature: float = 0.15,
    mock: bool = False,
) -> dict[str, Any]:
    """步骤2后半：对讲→章→子树结构做轻量 LLM 微调。"""
    if mock:
        return apply_llm_tidy(
            wrapped_doc,
            {"roots": _skeleton_roots(wrapped_doc), "notes": "mock_tune"},
            min_keep_ratio=0.5,
        )

    settings = llm_settings_from_config(llm_cfg)
    llm = client or LLMClient(**{k: v for k, v in settings.items() if k in {
        "api_key", "base_url", "model", "max_retry", "retry_pause_sec"
    }})
    compact = compact_for_llm(
        wrapped_doc.get("roots") or ([wrapped_doc["root"]] if wrapped_doc.get("root") else [])
    )
    prompt = format_prompt(
        PROMPT_TUNE_LECTURE,
        course_id=course_id,
        lecture_id=str(lecture_id),
        draft_json=json.dumps(compact, ensure_ascii=False, indent=2),
    )
    raw = llm.chat(prompt, temperature=temperature)
    payload = extract_json_obj(raw)
    out = apply_llm_tidy(wrapped_doc, payload, min_keep_ratio=0.5)
    meta = dict(out.get("meta") or {})
    meta["pipeline"] = "lecture_chapter_tune"
    notes = payload.get("notes")
    if notes:
        meta["llm_tune_notes"] = str(notes)
    out["meta"] = meta
    return out


def merge_chapter_with_llm(
    chapter_doc: dict[str, Any],
    *,
    course_id: str,
    chapter: str,
    client: LLMClient | None = None,
    llm_cfg: dict[str, Any] | None = None,
    temperature: float = 0.1,
    mock: bool = False,
) -> dict[str, Any]:
    """步骤3：对各讲汇入后的章图做简单拼接合并整理。"""
    if mock:
        return apply_llm_tidy(
            chapter_doc,
            {"roots": _skeleton_roots(chapter_doc), "notes": "mock_merge"},
            min_keep_ratio=0.5,
        )

    settings = llm_settings_from_config(llm_cfg)
    llm = client or LLMClient(**{k: v for k, v in settings.items() if k in {
        "api_key", "base_url", "model", "max_retry", "retry_pause_sec"
    }})
    compact = compact_for_llm(
        chapter_doc.get("roots") or ([chapter_doc["root"]] if chapter_doc.get("root") else [])
    )
    prompt = format_prompt(
        PROMPT_MERGE_CHAPTER,
        course_id=course_id,
        chapter=chapter,
        draft_json=json.dumps(compact, ensure_ascii=False, indent=2),
    )
    raw = llm.chat(prompt, temperature=temperature)
    payload = extract_json_obj(raw)
    out = apply_llm_tidy(chapter_doc, payload, min_keep_ratio=0.35)
    meta = dict(out.get("meta") or {})
    meta["pipeline"] = "lecture_assign_merge"
    meta["llm_merge"] = True
    notes = payload.get("notes")
    if notes:
        meta["llm_merge_notes"] = str(notes)
    out["meta"] = meta
    return out


def extract_subtree(trees: list[Any], root_id: str) -> dict[str, Any] | None:
    target = str(root_id or "")

    def find(n: Any) -> dict[str, Any] | None:
        d = node_to_dict(n)
        if str(d.get("id") or "") == target:
            return deepcopy(d)
        for c in d.get("children") or []:
            hit = find(c)
            if hit is not None:
                return hit
        return None

    for t in trees:
        hit = find(t)
        if hit is not None:
            return hit
    return None


def _merge_lecture_ids(node: dict[str, Any], lecture_id: str) -> None:
    lids = node.get("_lecture_ids")
    if not isinstance(lids, list):
        lids = []
    s = {str(x) for x in lids}
    s.add(str(lecture_id))
    node["_lecture_ids"] = sorted(s)


def _stamp_subtree_lecture_ids(node: dict[str, Any], lecture_id: str) -> None:
    _merge_lecture_ids(node, lecture_id)
    for c in node.get("children") or []:
        if isinstance(c, dict):
            _stamp_subtree_lecture_ids(c, lecture_id)


def merge_subtree_into(
    existing: dict[str, Any],
    incoming: dict[str, Any],
    *,
    lecture_id: str,
) -> dict[str, Any]:
    ex = deepcopy(existing)
    inc = deepcopy(incoming)
    if str(ex.get("id") or "") != str(inc.get("id") or ""):
        _stamp_subtree_lecture_ids(inc, lecture_id)
        return inc

    ex["importance"] = max(float(ex.get("importance") or 0.0), float(inc.get("importance") or 0.0))
    if inc.get("zh"):
        ex["zh"] = inc["zh"]
    if inc.get("relation") is not None and ex.get("relation") is None:
        ex["relation"] = inc.get("relation")
    rel_a = set(ex.get("related") or [])
    rel_b = set(inc.get("related") or [])
    ex["related"] = sorted(rel_a | rel_b)
    _merge_lecture_ids(ex, lecture_id)

    by_id: dict[str, dict[str, Any]] = {}
    for c in ex.get("children") or []:
        if isinstance(c, dict) and c.get("id"):
            by_id[str(c["id"])] = c
    for ic in inc.get("children") or []:
        if not isinstance(ic, dict):
            continue
        cid = str(ic.get("id") or "")
        if not cid:
            continue
        if cid in by_id:
            by_id[cid] = merge_subtree_into(by_id[cid], ic, lecture_id=lecture_id)
        else:
            ic2 = deepcopy(ic)
            _stamp_subtree_lecture_ids(ic2, lecture_id)
            by_id[cid] = ic2
    ex["children"] = sorted(
        by_id.values(),
        key=lambda n: -float(n.get("importance") or 0.0),
    )
    return ex


def strip_internal_fields(n: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(n)
    out.pop("_lecture_ids", None)

    def walk(node: dict[str, Any]) -> None:
        node.pop("_lecture_ids", None)
        for c in node.get("children") or []:
            if isinstance(c, dict):
                walk(c)

    walk(out)
    return out


def unwrap_lecture_to_topic_forest(lecture_doc: dict[str, Any]) -> list[dict[str, Any]]:
    """剥掉讲/章虚根，露出主题森林。"""
    roots = lecture_doc.get("roots") or (
        [lecture_doc["root"]] if lecture_doc.get("root") else []
    )
    out: list[dict[str, Any]] = []
    for t in roots:
        d = node_to_dict(t)
        nid = str(d.get("id") or "")
        if nid.startswith("__lecture__/"):
            for ch in d.get("children") or []:
                if not isinstance(ch, dict):
                    continue
                cid = str(ch.get("id") or "")
                if cid.startswith("__chapter__/"):
                    out.extend(
                        deepcopy(c)
                        for c in (ch.get("children") or [])
                        if isinstance(c, dict)
                    )
                else:
                    out.append(deepcopy(ch))
            continue
        if nid.startswith("__chapter__/"):
            out.extend(
                deepcopy(c) for c in (d.get("children") or []) if isinstance(c, dict)
            )
            continue
        out.append(deepcopy(d))
    return out


def iter_chapter_slices_from_lecture(
    lecture_doc: dict[str, Any],
) -> list[tuple[str, list[dict[str, Any]]]]:
    """从步骤2后的「讲→章→子树」中取出各章内容（章下直接孩子）。"""
    root = lecture_doc.get("root")
    roots = lecture_doc.get("roots") or ([root] if root else [])
    if not roots:
        return []
    top = node_to_dict(roots[0])
    out: list[tuple[str, list[dict[str, Any]]]] = []
    if str(top.get("id") or "").startswith("__lecture__/"):
        for ch in top.get("children") or []:
            if not isinstance(ch, dict):
                continue
            cid = str(ch.get("id") or "")
            if not cid.startswith("__chapter__/"):
                continue
            title = str(ch.get("zh") or "").strip() or cid.split("/", 1)[-1]
            kids = [deepcopy(c) for c in (ch.get("children") or []) if isinstance(c, dict)]
            if kids:
                out.append((title, kids))
        return out
    # 未包章：整棵森林视作未分章，调用方应先 wrap
    return []


def _find_node_by_id(root: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    target = str(node_id or "")
    if not target:
        return None

    def walk(n: dict[str, Any]) -> dict[str, Any] | None:
        if str(n.get("id") or "") == target:
            return n
        for c in n.get("children") or []:
            if isinstance(c, dict):
                hit = walk(c)
                if hit is not None:
                    return hit
        return None

    return walk(root)


def _replace_child(parent: dict[str, Any], child_id: str, new_child: dict[str, Any]) -> bool:
    kids = parent.get("children") or []
    for i, c in enumerate(kids):
        if isinstance(c, dict) and str(c.get("id") or "") == child_id:
            kids[i] = new_child
            parent["children"] = kids
            return True
        if isinstance(c, dict) and _replace_child(c, child_id, new_child):
            return True
    return False


def _flatten_legacy_lecture_branches(root: dict[str, Any]) -> dict[str, Any]:
    """若章下误留了 `__lecture__/N`，展开为内容子树再按 id 合并。"""
    kids = [c for c in (root.get("children") or []) if isinstance(c, dict)]
    if not any(str(c.get("id") or "").startswith("__lecture__/") for c in kids):
        return root
    flat: dict[str, dict[str, Any]] = {}
    for br in kids:
        bid = str(br.get("id") or "")
        if bid.startswith("__lecture__/"):
            lid = bid.split("/", 1)[-1] or "0"
            for gc in br.get("children") or []:
                if not isinstance(gc, dict) or not gc.get("id"):
                    continue
                gid = str(gc["id"])
                if gid in flat:
                    flat[gid] = merge_subtree_into(flat[gid], gc, lecture_id=lid)
                else:
                    g2 = deepcopy(gc)
                    _stamp_subtree_lecture_ids(g2, lid)
                    flat[gid] = g2
        else:
            gid = str(br.get("id") or "")
            if not gid:
                continue
            if gid in flat:
                flat[gid] = merge_subtree_into(flat[gid], br, lecture_id="0")
            else:
                flat[gid] = deepcopy(br)
    root = deepcopy(root)
    root["children"] = sorted(
        flat.values(),
        key=lambda n: -float(n.get("importance") or 0.0),
    )
    return root


def build_or_update_chapter_doc(
    chapter: str,
    *,
    existing: dict[str, Any] | None,
    subtrees: list[dict[str, Any]],
    lecture_id: str,
    lecture_ids: list[str] | None = None,
) -> dict[str, Any]:
    """步骤3规则拼接：各讲「章节部分」并入章根下（无讲次层），同 id 深合并。

    - 若某子树根 id 已在章树任意位置出现，则挂接到该处合并（避免重复顶层）
    - 否则作为章根的直接孩子
    """
    bare = _chapter_bare(chapter)
    ch_root_id = f"__chapter__/{bare}"
    if existing:
        root = deepcopy(existing.get("root") or {})
        doc = deepcopy(existing)
    else:
        root = {
            "id": ch_root_id,
            "zh": chapter,
            "importance": 0.7,
            "relation": None,
            "related": [],
            "children": [],
            "_lecture_ids": [],
        }
        doc = {}

    if str(root.get("id") or "") != ch_root_id:
        root = {
            "id": ch_root_id,
            "zh": chapter,
            "importance": float(root.get("importance") or 0.7),
            "relation": root.get("relation"),
            "related": list(root.get("related") or []),
            "children": list(root.get("children") or []),
            "_lecture_ids": list(root.get("_lecture_ids") or []),
        }

    root = _flatten_legacy_lecture_branches(root)
    root["zh"] = chapter

    for st in subtrees:
        if not isinstance(st, dict) or not st.get("id"):
            continue
        st2 = deepcopy(st)
        # 不把讲次虚根带进章图
        if str(st2.get("id") or "").startswith("__lecture__/"):
            for gc in st2.get("children") or []:
                if isinstance(gc, dict) and gc.get("id"):
                    _stamp_subtree_lecture_ids(gc, lecture_id)
                    _merge_one_subtree_into_chapter(root, gc, lecture_id=lecture_id)
            continue
        _stamp_subtree_lecture_ids(st2, lecture_id)
        _merge_one_subtree_into_chapter(root, st2, lecture_id=lecture_id)

    _merge_lecture_ids(root, lecture_id)
    root["children"] = sorted(
        [c for c in (root.get("children") or []) if isinstance(c, dict)],
        key=lambda n: -float(n.get("importance") or 0.0),
    )

    lids = sorted(
        {
            *(str(x) for x in (lecture_ids or [])),
            *(str(x) for x in ((existing or {}).get("meta") or {}).get("lecture_ids") or []),
            str(lecture_id),
        },
        key=lambda x: (0, int(x)) if str(x).isdigit() else (1, str(x)),
    )
    n_nodes, max_d = forest_stats([root])
    doc.update(
        {
            "lecture_id": f"chapter:{chapter}",
            "root": root,
            "roots": [root],
            "n_nodes": n_nodes,
            "max_depth": max_d,
            "orphan_count": int(doc.get("orphan_count") or 0),
            "meta": {
                **dict(doc.get("meta") or {}),
                "chapter": chapter,
                "root_zh": bare or chapter,
                "virtual_root": True,
                "scope": "chapter",
                "lecture_ids": lids,
                "pipeline": "lecture_assign_merge",
                "stitch": "entity_merge",
                "source": "kg",
                "n_trees": 1,
            },
        }
    )
    return doc


def _merge_one_subtree_into_chapter(
    root: dict[str, Any],
    incoming: dict[str, Any],
    *,
    lecture_id: str,
) -> None:
    """把一棵内容子树并入章树：已有同 id 则就地合并，否则挂到章根下。"""
    iid = str(incoming.get("id") or "")
    if not iid or iid.startswith("__chapter__/"):
        return
    hit = _find_node_by_id(root, iid)
    if hit is None:
        kids = list(root.get("children") or [])
        kids.append(incoming)
        root["children"] = kids
        return
    # 就地深合并，写回原位置
    merged = merge_subtree_into(hit, incoming, lecture_id=lecture_id)
    if hit is root:
        root.clear()
        root.update(merged)
        return
    if not _replace_child(root, iid, merged):
        # 命中即根的直接孩子但 replace 失败时直接替换列表项
        kids = root.get("children") or []
        for i, c in enumerate(kids):
            if isinstance(c, dict) and str(c.get("id") or "") == iid:
                kids[i] = merged
                root["children"] = kids
                return
        root.setdefault("children", []).append(merged)


def _truncate_chapter_root(node: dict[str, Any], depth: int, max_depth: int) -> dict[str, Any]:
    n = strip_internal_fields(node)
    if depth >= max_depth:
        n["children"] = []
        return n
    kids = []
    for c in n.get("children") or []:
        if isinstance(c, dict):
            kids.append(_truncate_chapter_root(c, depth + 1, max_depth))
    n["children"] = kids
    return n


def _flatten_chapter_lecture_branches(chapter_root: dict[str, Any]) -> dict[str, Any]:
    """课总图用：把章下 `__lecture__/N` 展开为内容子树，跨讲同 id 后现者收成叶。"""
    root = strip_internal_fields(deepcopy(chapter_root))
    flat: list[dict[str, Any]] = []
    seen: set[str] = set()
    for c in root.get("children") or []:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or "")
        if cid.startswith("__lecture__/"):
            for gc in c.get("children") or []:
                if not isinstance(gc, dict):
                    continue
                gid = str(gc.get("id") or "")
                node = deepcopy(gc)
                if gid and gid in seen and not gid.startswith("__"):
                    node["children"] = []
                elif gid and not gid.startswith("__"):
                    seen.add(gid)
                flat.append(node)
        else:
            if cid and cid in seen and not cid.startswith("__"):
                c2 = deepcopy(c)
                c2["children"] = []
                flat.append(c2)
            else:
                if cid and not cid.startswith("__"):
                    seen.add(cid)
                flat.append(deepcopy(c))
    root["children"] = flat
    return root


def build_course_from_chapters(
    course_title: str,
    chapter_docs: list[tuple[str, dict[str, Any]]],
    *,
    catalog: Any = None,
    max_chapter_depth: int = 2,
) -> dict[str, Any]:
    by_chapter = {name: doc for name, doc in chapter_docs}
    course_root_id = f"__course__/{course_title}"
    children: list[dict[str, Any]] = []
    n_chapters = 0

    def _empty_chapter_node(ch_name: str) -> dict[str, Any]:
        bare = _chapter_bare(ch_name)
        return {
            "id": f"__chapter__/{bare or ch_name}",
            "zh": ch_name,
            "importance": 0.45,
            "relation": "toc_chapter",
            "related": [],
            "children": [],
        }

    def _chapter_for_course(ch_name: str, doc: dict[str, Any] | None) -> dict[str, Any]:
        if not doc or not doc.get("root"):
            return _empty_chapter_node(ch_name)
        root = doc.get("root") or {}
        flat = _flatten_chapter_lecture_branches(root)
        # 保证章节点显示完整章名
        out = _truncate_chapter_root(flat, 0, max_chapter_depth)
        out["zh"] = ch_name
        if not str(out.get("id") or "").startswith("__chapter__/"):
            bare = _chapter_bare(ch_name)
            out = {
                "id": f"__chapter__/{bare}",
                "zh": ch_name,
                "importance": float(out.get("importance") or 0.5),
                "relation": "toc_chapter",
                "related": [],
                "children": out.get("children") or [],
            }
        return out

    if catalog:
        parts = catalog if isinstance(catalog, list) else catalog.get("parts") or []
        for part in parts:
            if isinstance(part, str):
                ch_name = part
                children.append(_chapter_for_course(ch_name, by_chapter.get(ch_name)))
                n_chapters += 1
                continue
            if not isinstance(part, dict):
                continue
            pid = str(part.get("id") or part.get("title") or part.get("name") or "part")
            ptitle = str(part.get("title") or part.get("name") or pid)
            part_children: list[dict[str, Any]] = []
            for ch_entry in part.get("chapters") or []:
                if isinstance(ch_entry, dict):
                    ch_name = str(ch_entry.get("name") or ch_entry.get("title") or "")
                else:
                    ch_name = str(ch_entry or "")
                if not ch_name:
                    continue
                part_children.append(
                    _chapter_for_course(ch_name, by_chapter.get(ch_name))
                )
                n_chapters += 1
            if not part_children:
                continue
            # 顶层是分册，不是章——显示名加前缀以免误认
            children.append(
                {
                    "id": f"__part__/{pid}",
                    "zh": ptitle if str(ptitle).startswith("分册") else f"分册 · {ptitle}",
                    "importance": 0.55,
                    "relation": "toc_part",
                    "related": [],
                    "children": part_children,
                }
            )
    else:
        for ch_name, doc in chapter_docs:
            children.append(_chapter_for_course(ch_name, doc))
            n_chapters += 1

    root = {
        "id": course_root_id,
        "zh": course_title,
        "importance": 1.0,
        "relation": None,
        "related": [],
        "children": children,
    }
    n_nodes, max_d = forest_stats([root])
    return {
        "lecture_id": "course",
        "root": root,
        "roots": [root],
        "n_nodes": n_nodes,
        "max_depth": max_d,
        "orphan_count": 0,
        "meta": {
            "scope": "course",
            "course_title": course_title,
            "root_zh": course_title,
            "virtual_root": True,
            "composed_from": "chapters",
            "pipeline": "course_from_chapters",
            "n_trees": 1,
            "n_parts": len(children) if catalog else 0,
            "n_chapters": n_chapters,
            "source": "kg",
        },
    }


def _index_sort_key(item: dict[str, Any]) -> tuple[int, str]:
    scope = item.get("scope")
    lid = str(item.get("lecture_id") or "")
    if scope == "course" or lid == "course":
        rank = 0
    elif scope == "chapter" or lid.startswith("chapter:"):
        rank = 1
    else:
        rank = 2
    return rank, lid


def update_mindmap_index(
    index_path: str | Path,
    *,
    course_id: str,
    items_upsert: list[dict[str, Any]],
) -> dict[str, Any]:
    path = Path(index_path)
    if path.is_file():
        index = json.loads(path.read_text(encoding="utf-8"))
    else:
        index = {"courseId": course_id, "title": "思维导图", "items": []}

    index["courseId"] = course_id
    items: list[dict[str, Any]] = list(index.get("items") or [])
    by_lid: dict[str, int] = {}
    for i, it in enumerate(items):
        by_lid[str(it.get("lecture_id") or "")] = i

    for it in items_upsert:
        lid = str(it.get("lecture_id") or "")
        if not lid:
            continue
        if lid in by_lid:
            merged = {**items[by_lid[lid]], **it}
            items[by_lid[lid]] = merged
        else:
            by_lid[lid] = len(items)
            items.append(dict(it))

    items.sort(key=_index_sort_key)
    index["items"] = items
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return index
