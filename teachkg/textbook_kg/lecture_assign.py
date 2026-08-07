"""讲次级教材边去重：先建讲次子图，再分配到各 cue。"""

from __future__ import annotations

from dataclasses import dataclass

from teachkg.stage1_alignment.triplet_extract import Triplet
from teachkg.textbook_kg.alias import clean_text, extract_entities_from_text
from teachkg.textbook_kg.loader import TextbookRelation
from teachkg.textbook_kg.subgraph import TextbookSubgraphRetriever


@dataclass
class CueAssignMeta:
    text: str
    duration_sec: float = 0.0
    ppt_page_index: int | None = None


def max_edges_for_cue(duration_sec: float) -> int:
    """按 cue 时长限制可挂教材边数，避免短过渡段堆积过多边。"""
    if duration_sec < 45:
        return 4
    if duration_sec < 120:
        return 10
    if duration_sec < 300:
        return 15
    return 20


def _triplet_cue_score(
    triplet: Triplet,
    meta: CueAssignMeta,
    seed_entities: set[str],
) -> float:
    cue_clean = clean_text(meta.text)
    score = 0.0
    for part in (triplet.subject, triplet.object, triplet.context, triplet.description):
        part_clean = clean_text(part)
        if part_clean and part_clean in cue_clean:
            score += 3.0
    if triplet.subject in seed_entities:
        score += 2.0
    if triplet.object in seed_entities:
        score += 2.0
    if meta.duration_sec >= 120:
        score += min(meta.duration_sec / 600.0, 0.5)
    elif meta.duration_sec < 45:
        score -= 1.0
    if meta.ppt_page_index is not None:
        page_token = f"第{meta.ppt_page_index}页"
        page_token2 = f"page {meta.ppt_page_index}"
        ctx = f"{triplet.context} {triplet.description}".lower()
        if page_token in ctx or page_token2 in ctx:
            score += 2.0
    return score


def _cue_max_score(
    triplets: list[Triplet],
    cid: str,
    cue_meta: dict[str, CueAssignMeta],
    cue_seeds: dict[str, set[str]],
) -> float:
    if not triplets:
        return -1.0
    return max(_triplet_cue_score(t, cue_meta[cid], cue_seeds[cid]) for t in triplets)


def assign_textbook_triplets_to_cues(
    triplets: list[Triplet],
    cue_meta: dict[str, CueAssignMeta],
    *,
    retriever: TextbookSubgraphRetriever,
    min_edges_per_cue: int = 1,
) -> dict[str, list[Triplet]]:
    """每条教材三元组只分配给最相关 cue；先保证每 cue 至少 min_edges_per_cue 条。"""
    if not triplets:
        return {cid: [] for cid in cue_meta}
    if not cue_meta:
        return {}

    cue_seeds = {
        cid: retriever._find_seed_entities(meta.text)  # noqa: SLF001
        for cid, meta in cue_meta.items()
    }
    assignment: dict[str, list[Triplet]] = {cid: [] for cid in cue_meta}
    caps = {cid: max_edges_for_cue(meta.duration_sec) for cid, meta in cue_meta.items()}
    counts = {cid: 0 for cid in cue_meta}
    used_keys: set[tuple[str, str, str, str]] = set()

    def available() -> list[Triplet]:
        return [t for t in triplets if t.dedupe_key not in used_keys]

    def assign_to(cid: str, triplet: Triplet) -> bool:
        if counts[cid] >= caps[cid] or triplet.dedupe_key in used_keys:
            return False
        assignment[cid].append(triplet)
        counts[cid] += 1
        used_keys.add(triplet.dedupe_key)
        return True

    # Phase 1：最缺边的 cue 优先，各补至少 min_edges_per_cue 条
    needy_order = sorted(
        cue_meta,
        key=lambda cid: _cue_max_score(available(), cid, cue_meta, cue_seeds),
    )
    for cid in needy_order:
        while counts[cid] < min(min_edges_per_cue, caps[cid]):
            pool = available()
            if not pool:
                break
            best_t: Triplet | None = None
            best_score = -1.0
            for triplet in pool:
                score = _triplet_cue_score(triplet, cue_meta[cid], cue_seeds[cid])
                if score > best_score:
                    best_score = score
                    best_t = triplet
            if best_t is None or best_score < 0:
                break
            assign_to(cid, best_t)

    # Phase 2：按全局相关度贪心填满
    scored: list[tuple[float, Triplet, str]] = []
    for triplet in available():
        best_cid = next(iter(cue_meta))
        best_score = -1.0
        for cid, meta in cue_meta.items():
            if counts[cid] >= caps[cid]:
                continue
            score = _triplet_cue_score(triplet, meta, cue_seeds[cid])
            if score > best_score:
                best_score = score
                best_cid = cid
        scored.append((best_score, triplet, best_cid))

    scored.sort(key=lambda item: item[0], reverse=True)
    for _score, triplet, preferred_cid in scored:
        if triplet.dedupe_key in used_keys:
            continue
        target = preferred_cid
        if counts[target] >= caps[target]:
            for cid in sorted(cue_meta, key=lambda c: caps[c] - counts[c], reverse=True):
                if counts[cid] < caps[cid]:
                    target = cid
                    break
            else:
                continue
        assign_to(target, triplet)

    return assignment


def supplement_textbook_for_cue(
    cue_meta: CueAssignMeta,
    *,
    pool: list[Triplet],
    exclude_keys: set[tuple[str, str, str, str]],
    retriever: TextbookSubgraphRetriever,
    max_edges: int = 5,
) -> list[Triplet]:
    """为零覆盖 cue 从边池补若干最相关教材边（仅使用尚未分配的边）。"""
    seeds = retriever._find_seed_entities(cue_meta.text)  # noqa: SLF001
    candidates = [t for t in pool if t.dedupe_key not in exclude_keys]
    if not candidates:
        return []
    ranked = sorted(
        candidates,
        key=lambda t: _triplet_cue_score(t, cue_meta, seeds),
        reverse=True,
    )
    out: list[Triplet] = []
    for triplet in ranked:
        if len(out) >= max_edges:
            break
        if _triplet_cue_score(triplet, cue_meta, seeds) < 0:
            break
        out.append(triplet)
    return out


def retrieve_lecture_subgraph(
    retriever: TextbookSubgraphRetriever,
    cue_texts: list[str],
) -> tuple[set[str], list[TextbookRelation]]:
    """合并多 cue 文本，检索讲次级教材子图（去重后统一边池）。"""
    texts = [t for t in cue_texts if t.strip()]
    combined = "\n\n".join(texts)
    if not combined.strip():
        return set(), []

    seeds: set[str] = set()
    candidate_pool: set[str] = set()
    alias_pool: set[str] = set()
    emb_pool: set[str] = set()
    for text in texts:
        expand_seeds, alias_seeds, embedding_seeds = retriever.resolve_seed_sets(text)
        seeds |= expand_seeds
        alias_pool |= alias_seeds
        emb_pool |= embedding_seeds
        candidate_pool |= alias_seeds | embedding_seeds
    if retriever.embedding_link_enabled:
        emb_min = (
            retriever.lecture_embedding_link_min_score
            if retriever.lecture_embedding_link_min_score is not None
            else retriever.embedding_link_min_score
        )
        extra_emb = retriever._embedding_link(  # noqa: SLF001
            combined,
            exclude=candidate_pool,
            min_score=emb_min,
        )
        emb_pool |= extra_emb
        candidate_pool |= extra_emb
        seeds |= extra_emb
    # 讲次合并后又补了向量种子时，再统一 LLM 筛选一次
    seeds = retriever.apply_seed_llm_filter(
        combined,
        seeds,
        alias_seeds=alias_pool,
        embedding_seeds=emb_pool,
    )
    if not seeds:
        return set(), []

    scored = retriever.expand_scored(
        seeds, combined, candidate_seed_pool=candidate_pool
    )
    if retriever.score_prune_edges:
        filtered = [
            rel
            for rel, score in scored
            if score >= retriever.lecture_min_relation_score
        ]
    else:
        filtered = [rel for rel, _score in scored]

    limit = retriever.max_edges_per_lecture
    if limit is not None and int(limit) > 0:
        if retriever.lecture_dynamic_cap and texts:
            dynamic = int(len(texts) * retriever.lecture_edges_per_cue_cap)
            limit = min(int(limit), max(dynamic, len(texts)))
        selected = filtered[: int(limit)]
    else:
        selected = filtered

    edge_filt = getattr(retriever, "edge_llm_filter", None)
    if edge_filt is not None and getattr(edge_filt, "enabled", False) and selected:
        selected = edge_filt.filter(
            combined,
            selected,
            expansion_seeds=seeds,
        )
    return seeds, selected
