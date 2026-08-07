"""新增实体分流：merge / drop / keep（规则通用，可选课程覆盖）。

设计原则
--------
1. **merge**：只在能链到教材注册表时生效（含保守改写后再查）。
2. **drop**：表层记号 / 属性口述 / 过程短语 / 元叙述 / 低支撑长中文。
3. **keep**：其余新实体保留进图；不做课程专名白名单。
4. 课程特有同义可走 ``synonym_pairs`` / ``merge_overrides`` 配置，不写死在代码里。
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable

from teachkg.textbook_kg.entity_registry import EntityRegistry, entity_primary

# 表层记号（跨课程偏稳）
_DEFAULT_NOTATION = re.compile(
    r"(字母|括号|符号|记号|下标|上标|空白|空格|标点|逗号|句号|原始符号)"
)
# 属性/约束口述
_DEFAULT_PHRASE = re.compile(
    r"(不能|没有|无需|转化为|翻译成|方式|条件|描述|表示|只能|独立于|未受|受量词)"
)
# 过程动作结尾
_DEFAULT_ACTION = re.compile(r"(转化为|形式化|实例化|约束化|展开|赋值|指派|解释)$")
_DEFAULT_VERBISH = re.compile(r"(化$|性$|性/|方式$|条件$|描述$)")
# 课堂元叙述 / 非术语噪声
_DEFAULT_META = re.compile(
    r"(自然语言|日常生活|英文|单词|粒度|确切意义|解决问题|"
    r"真假无法|数学中的推理|逻辑解决问题)"
)
# 过宽元概念（精确匹配；避免误伤「…系统」类教材术语）
_DEFAULT_BROAD = re.compile(r"^(推理语言|形式化逻辑系统)$")

# 「领域的X」前缀：剥掉后再查教材
_SCOPE_PREFIX = re.compile(
    r"^(?:命题逻辑|谓词逻辑|一阶逻辑|模态逻辑|集合论)的"
)
# 可剥后缀后再查
_STRIP_SUFFIXES = ("连接词",)
# n/N 元 → 多元（教材常用名）
_NARY = re.compile(r"^[nN]元")


@dataclass
class TriageDecision:
    entity: str
    zh: str
    decision: str  # merge | drop | keep | keep_under_parent
    merge_to: str = ""
    parent: str = ""
    reasons: list[str] = field(default_factory=list)
    degree: int = 0
    n_cues: int = 0
    preds: list[str] = field(default_factory=list)
    lecture_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TriageResult:
    decisions: list[TriageDecision]
    triplets: list[dict[str, Any]]
    stats: dict[str, Any] = field(default_factory=dict)

    def decision_map(self) -> dict[str, TriageDecision]:
        return {d.entity: d for d in self.decisions}


@dataclass
class EntityTriageConfig:
    enabled: bool = True
    apply_merge: bool = True
    apply_drop: bool = True
    inject_parent_edges: bool = True
    # (alias_zh, canonical_zh_or_full) — 仅作改写线索，最终仍须 registry 命中
    synonym_pairs: tuple[tuple[str, str], ...] = (
        ("变量", "变元"),
        ("常量", "常项"),
        ("真假", "真值"),
        ("变元", "变项"),
        ("出现", "变元"),  # 约束出现 → 约束变元
    )
    # 强制 merge：entity_zh → textbook full name（课程覆盖，慎用）
    merge_overrides: dict[str, str] = field(default_factory=dict)
    # 强制 drop 的中文主名
    drop_overrides: set[str] = field(default_factory=set)
    # 强制 keep
    keep_overrides: set[str] = field(default_factory=set)
    # 复合子类：匹配后挂 parent（parent 须已在图中或为 keep）
    compound_parent: tuple[tuple[str, str], ...] = (
        # (regex on zh, parent zh or full name)
        (r"^(全称|特称|存在)-(全称|特称|存在)", "重叠量词"),
    )
    notation_re: re.Pattern[str] = _DEFAULT_NOTATION
    phrase_re: re.Pattern[str] = _DEFAULT_PHRASE
    action_re: re.Pattern[str] = _DEFAULT_ACTION
    verbish_re: re.Pattern[str] = _DEFAULT_VERBISH
    meta_re: re.Pattern[str] = _DEFAULT_META

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> EntityTriageConfig:
        raw = raw or {}
        cfg = cls(
            enabled=bool(raw.get("enabled", True)),
            apply_merge=bool(raw.get("apply_merge", True)),
            apply_drop=bool(raw.get("apply_drop", True)),
            inject_parent_edges=bool(raw.get("inject_parent_edges", True)),
        )
        pairs = raw.get("synonym_pairs")
        if pairs:
            cfg.synonym_pairs = tuple((str(a), str(b)) for a, b in pairs)
        overrides = raw.get("merge_overrides") or {}
        cfg.merge_overrides = {str(k): str(v) for k, v in overrides.items()}
        cfg.drop_overrides = {str(x) for x in (raw.get("drop_overrides") or [])}
        cfg.keep_overrides = {str(x) for x in (raw.get("keep_overrides") or [])}
        compounds = raw.get("compound_parent")
        if compounds:
            cfg.compound_parent = tuple((str(p), str(parent)) for p, parent in compounds)
        for key, attr in (
            ("notation_pattern", "notation_re"),
            ("phrase_pattern", "phrase_re"),
            ("action_pattern", "action_re"),
            ("verbish_pattern", "verbish_re"),
            ("meta_pattern", "meta_re"),
        ):
            if raw.get(key):
                setattr(cfg, attr, re.compile(str(raw[key])))
        return cfg


def _variants(zh: str, synonym_pairs: Iterable[tuple[str, str]]) -> list[str]:
    """生成保守改写候选（含原串；更具体的在前）。"""
    out: list[str] = []
    seen: set[str] = set()

    def add(x: str) -> None:
        x = (x or "").strip()
        if x and x not in seen:
            seen.add(x)
            out.append(x)

    add(zh)
    # 真假/真假性 → 先暴露「真值」本体，避免「公式的真假性」误链到「公式」
    if "真假" in zh:
        add("真值")
        add(zh.replace("真假性", "真值").replace("真假", "真值"))
    # 同义替换（整词/子串一次）
    for a, b in synonym_pairs:
        if a in zh:
            add(zh.replace(a, b, 1))
        if b in zh:
            add(zh.replace(b, a, 1))
    # 剥领域前缀：先试「命题+余部」再试余部
    m = _SCOPE_PREFIX.match(zh)
    if m:
        rem = zh[m.end() :]
        if "命题" in m.group(0):
            add("命题" + rem)
        if "谓词" in m.group(0):
            add("谓词" + rem)
        add(rem)
    # 剥后缀（不含「的真假性」→头名词，那种会误链）
    for suf in _STRIP_SUFFIXES:
        if suf == "的真假性":
            continue
        if zh.endswith(suf) and len(zh) > len(suf):
            add(zh[: -len(suf)])
    # n元 → 多元
    if _NARY.match(zh):
        add(_NARY.sub("多元", zh, count=1))
    # 剥「变项/变元」后缀：函数变项 → 函数
    for suf in ("变项", "变元"):
        if zh.endswith(suf) and len(zh) > len(suf):
            add(zh[: -len(suf)])
    return out


def resolve_textbook_link(
    name: str,
    registry: EntityRegistry,
    *,
    synonym_pairs: Iterable[tuple[str, str]] = (),
    merge_overrides: dict[str, str] | None = None,
) -> str | None:
    """若能链到教材实体则返回 canonical 全名（多名命中时取中文主名更长者）。"""
    zh = entity_primary(name)
    overrides = merge_overrides or {}
    if zh in overrides:
        target = overrides[zh]
        hit = registry.lookup(target) or (
            target if target in registry.textbook_entity_names else None
        )
        if hit:
            return hit

    hits: list[str] = []
    en = name.split("/", 1)[1].strip() if "/" in name else ""
    for cand in _variants(zh, synonym_pairs):
        for probe in (cand, f"{cand}/{en}" if en else ""):
            if not probe:
                continue
            hit = registry.lookup(probe)
            if hit and hit not in hits:
                hits.append(hit)
    direct = registry.lookup(name)
    if direct and direct not in hits:
        hits.append(direct)
    if not hits:
        return None
    # 更长的教材主名通常更具体（命题等值演算 > 等值演算）
    return max(hits, key=lambda h: (len(entity_primary(h)), len(h)))


def _collect_candidates(triplets: list[dict[str, Any]]) -> set[str]:
    on_tb: set[str] = set()
    sources: dict[str, set[str]] = defaultdict(set)
    for t in triplets:
        for side in ("subject", "object"):
            n = (t.get(side) or "").strip()
            if not n:
                continue
            sources[n].add(str(t.get("extract_source") or ""))
            if t.get("extract_source") == "textbook":
                on_tb.add(n)

    cands: set[str] = set()
    for t in triplets:
        for side, rk in (
            ("subject", "subject_entity_ref"),
            ("object", "object_entity_ref"),
        ):
            n = (t.get(side) or "").strip()
            if not n:
                continue
            if t.get(rk) == "new" or (
                n not in on_tb and "textbook" not in sources[n]
            ):
                cands.add(n)
    for n, srcs in sources.items():
        if "textbook" not in srcs and n not in on_tb:
            cands.add(n)
    return cands


def _stats_for(
    triplets: list[dict[str, Any]],
) -> tuple[
    Counter[str],
    dict[str, set[str]],
    dict[str, set[str]],
    Counter[str],
    Counter[str],
]:
    deg: Counter[str] = Counter()
    rels: dict[str, set[str]] = defaultdict(set)
    cues: dict[str, set[str]] = defaultdict(set)
    as_prop_attr: Counter[str] = Counter()
    as_prop_owner: Counter[str] = Counter()
    for t in triplets:
        sub = (t.get("subject") or "").strip()
        obj = (t.get("object") or "").strip()
        pred = (t.get("abstract_relation") or "").split("|")[0]
        cue = t.get("cue_id")
        if sub:
            deg[sub] += 1
            rels[sub].add(pred)
            if cue:
                cues[sub].add(str(cue))
            if pred == "property_of":
                as_prop_attr[sub] += 1
        if obj:
            deg[obj] += 1
            rels[obj].add(pred)
            if cue:
                cues[obj].add(str(cue))
            if pred == "property_of":
                as_prop_owner[obj] += 1
    return deg, rels, cues, as_prop_attr, as_prop_owner


def decide_entity(
    name: str,
    *,
    registry: EntityRegistry,
    cfg: EntityTriageConfig,
    degree: int,
    n_cues: int,
    preds: list[str],
    as_prop_attr: int,
    as_prop_owner: int,
    lecture_id: str = "",
) -> TriageDecision:
    zh = entity_primary(name)
    d = TriageDecision(
        entity=name,
        zh=zh,
        decision="keep",
        degree=degree,
        n_cues=n_cues,
        preds=preds,
        lecture_id=lecture_id,
    )

    if zh in cfg.keep_overrides:
        d.decision = "keep"
        d.reasons.append("keep_overrides")
        return d
    if zh in cfg.drop_overrides:
        d.decision = "drop"
        d.reasons.append("drop_overrides")
        return d

    # 明显元叙述先丢，避免「真假无法…」被同义改写误并到「真值」
    if cfg.meta_re.search(zh) or cfg.meta_re.search(name):
        d.decision = "drop"
        d.reasons.append("元叙述/非学科术语")
        return d

    linked = resolve_textbook_link(
        name,
        registry,
        synonym_pairs=cfg.synonym_pairs,
        merge_overrides=cfg.merge_overrides,
    )
    if linked:
        d.decision = "merge"
        d.merge_to = linked
        if linked == name:
            d.reasons.append("已是教材全名，应标 textbook")
        else:
            d.reasons.append(f"可链教材→{linked}")
        return d

    # —— drop 启发式（链不上教材的噪声）——
    if cfg.notation_re.search(zh) or cfg.notation_re.search(name):
        d.decision = "drop"
        d.reasons.append("表层记号")
        return d
    if len(zh) >= 10 and ("/" not in name or cfg.phrase_re.search(zh)):
        if cfg.phrase_re.search(zh) or " " in zh:
            d.decision = "drop"
            d.reasons.append("长短语/属性口述")
            return d
    if cfg.phrase_re.search(zh) and "/" not in name:
        d.decision = "drop"
        d.reasons.append("无英文的属性/动作短语")
        return d
    if (
        as_prop_attr
        and degree <= 2
        and as_prop_owner == 0
        and (
            len(zh) <= 3
            or cfg.phrase_re.search(zh)
            or cfg.verbish_re.search(zh)
            or "/" not in name
        )
    ):
        d.decision = "drop"
        d.reasons.append("主要作 property_of 属性端且低度数")
        return d
    # 过程动作：…约束化/实例化；度数放宽到 3（常被 depend_on 反复提及）
    if cfg.action_re.search(zh) and degree <= 3:
        d.decision = "drop"
        d.reasons.append("过程动作短语")
        return d
    # 主题并列「A与B」→ 更像章节主题（可有双语）
    if "与" in zh and degree <= 3 and len(zh) >= 5:
        d.decision = "drop"
        d.reasons.append("主题并列短语")
        return d
    # 用途说明：…属性 / …间关系（教材正式「等价关系」等一般不会以「间关系」结尾）
    if degree <= 2 and (zh.endswith("属性") or zh.endswith("间关系")) and len(zh) >= 4:
        d.decision = "drop"
        d.reasons.append("用途说明型短语")
        return d
    if degree == 1 and len(zh) >= 8 and "/" not in name:
        d.decision = "drop"
        d.reasons.append("单次出现的长中文无斜杠名")
        return d
    if degree <= 2 and "/" not in name and _DEFAULT_BROAD.search(zh):
        d.decision = "drop"
        d.reasons.append("过宽元概念")
        return d
    # 纯例子论域元素：短、像「非零自然数」这类修饰+集合名且度数低
    if (
        degree <= 2
        and re.search(r"^(非零|任意|某个|某一)", zh)
        and len(zh) <= 8
    ):
        d.decision = "drop"
        d.reasons.append("例子论域元素")
        return d

    # 复合子类 → keep_under_parent
    for pat, parent in cfg.compound_parent:
        if re.search(pat, zh):
            d.decision = "keep_under_parent"
            d.parent = parent
            d.reasons.append(f"复合子类，建议 part_of → {parent}")
            return d

    d.reasons.append("像术语，保留")
    return d


def triage_triplets(
    triplets: list[dict[str, Any]],
    registry: EntityRegistry,
    *,
    cfg: EntityTriageConfig | None = None,
    lecture_id: str | None = None,
) -> TriageResult:
    """对候选新实体分流，并按配置改写/过滤三元组。"""
    cfg = cfg or EntityTriageConfig()
    if not cfg.enabled:
        return TriageResult(decisions=[], triplets=list(triplets), stats={"enabled": False})

    scoped = triplets
    if lecture_id is not None:
        scoped = [t for t in triplets if str(t.get("lecture_id", "")) == str(lecture_id)]

    # 按讲次分别决策（同一实体名在不同讲可能角色不同，但 merge/drop 通常一致）
    by_lec: dict[str, list[dict]] = defaultdict(list)
    for t in scoped:
        by_lec[str(t.get("lecture_id", "") or lecture_id or "")].append(t)

    decisions: list[TriageDecision] = []
    seen_entity: set[str] = set()

    for lec, lec_trips in sorted(by_lec.items()):
        deg, rels, cues, as_prop_attr, as_prop_owner = _stats_for(lec_trips)
        for name in sorted(_collect_candidates(lec_trips)):
            key = f"{lec}::{name}"
            if key in seen_entity:
                continue
            seen_entity.add(key)
            decisions.append(
                decide_entity(
                    name,
                    registry=registry,
                    cfg=cfg,
                    degree=deg[name],
                    n_cues=len(cues[name]),
                    preds=sorted(rels[name]),
                    as_prop_attr=as_prop_attr[name],
                    as_prop_owner=as_prop_owner[name],
                    lecture_id=lec,
                )
            )

    # 应用：全局按实体名合并决策（merge 优先于 drop；keep 默认）
    by_name: dict[str, TriageDecision] = {}
    for d in decisions:
        prev = by_name.get(d.entity)
        if prev is None:
            by_name[d.entity] = d
            continue
        rank = {"merge": 3, "keep_under_parent": 2, "keep": 1, "drop": 0}
        if rank.get(d.decision, 0) > rank.get(prev.decision, 0):
            by_name[d.entity] = d
        elif d.decision == "merge" and d.merge_to and not prev.merge_to:
            by_name[d.entity] = d

    out_trips: list[dict[str, Any]] = []
    dropped_edges = 0
    merged_rewrites = 0
    parent_injected = 0

    merge_map = {
        e: d.merge_to
        for e, d in by_name.items()
        if d.decision == "merge" and d.merge_to and cfg.apply_merge
    }
    drop_set = {
        e
        for e, d in by_name.items()
        if d.decision == "drop" and cfg.apply_drop
    }
    parent_of = {
        e: d.parent
        for e, d in by_name.items()
        if d.decision == "keep_under_parent" and d.parent
    }

    # 解析 parent 到图中已有名（候选 keep 里找含 parent zh 的）
    def resolve_parent(parent_zh: str, entities_present: set[str]) -> str | None:
        for n in entities_present:
            if entity_primary(n) == parent_zh or n == parent_zh:
                return n
        hit = registry.lookup(parent_zh)
        if hit:
            return hit
        # 父概念本身是 keep 候选
        for e, d in by_name.items():
            if d.decision in ("keep", "keep_under_parent") and entity_primary(e) == parent_zh:
                return e
            if entity_primary(e) == parent_zh and e not in drop_set:
                return e
        return None

    for t in scoped:
        row = dict(t)
        sub = str(row.get("subject") or "").strip()
        obj = str(row.get("object") or "").strip()
        if cfg.apply_merge:
            if sub in merge_map:
                row["subject"] = merge_map[sub]
                row["subject_entity_ref"] = "textbook"
                merged_rewrites += 1
                sub = row["subject"]
            if obj in merge_map:
                row["object"] = merge_map[obj]
                row["object_entity_ref"] = "textbook"
                merged_rewrites += 1
                obj = row["object"]
        if cfg.apply_drop and (sub in drop_set or obj in drop_set):
            dropped_edges += 1
            continue
        out_trips.append(row)

    if cfg.inject_parent_edges and parent_of:
        present = {
            str(t.get("subject") or "").strip()
            for t in out_trips
            if str(t.get("subject") or "").strip()
        } | {
            str(t.get("object") or "").strip()
            for t in out_trips
            if str(t.get("object") or "").strip()
        }
        for child, parent_zh in parent_of.items():
            if child in drop_set or child in merge_map:
                continue
            parent = resolve_parent(parent_zh, present)
            if not parent or parent == child:
                continue
            # 避免重复
            exists = any(
                t.get("subject") == child
                and t.get("object") == parent
                and str(t.get("abstract_relation", "")).startswith("part_of")
                for t in out_trips
            )
            if exists:
                continue
            lec = by_name[child].lecture_id if child in by_name else ""
            out_trips.append(
                {
                    "subject": child,
                    "object": parent,
                    "abstract_relation": "part_of",
                    "concrete_relation": "是…的子类/组成",
                    "natural_statement": f"{entity_primary(child)} 是 {entity_primary(parent)} 的子类",
                    "extract_source": "entity_triage",
                    "lecture_id": lec,
                    "subject_entity_ref": "new",
                    "object_entity_ref": "new",
                }
            )
            parent_injected += 1
            present.add(child)
            present.add(parent)

    counts = Counter(d.decision for d in decisions)
    stats = {
        "enabled": True,
        "candidate_count": len(decisions),
        "decision_counts": dict(counts),
        "merged_rewrites": merged_rewrites,
        "dropped_edges": dropped_edges,
        "parent_edges_injected": parent_injected,
        "output_triplets": len(out_trips),
        "input_triplets": len(scoped),
    }
    return TriageResult(decisions=decisions, triplets=out_trips, stats=stats)
