"""Stage3：用 merge_map / aliases 把图谱 canonical 名对齐到 triplets 原名。

Stage2 合并后实体 id 多为教材正式名，而 ``triplets.jsonl`` 仍可能保留课堂别名；
描述生成与文本证据挂接需通过本模块做名称集合匹配。
"""

from __future__ import annotations

from typing import Any


def build_alias_lookup(
    entities: list[dict[str, Any]],
    merge_map: dict[str, str] | None = None,
) -> dict[str, set[str]]:
    """构建 ``canonical → 可匹配名称集合``。

    名称来源：
    - 实体 ``id`` / ``name``（canonical）
    - 实体 ``aliases`` 列表
    - ``merge_map`` 中指向该 canonical 的别名键

    Args:
        entities: KG/MMKG 中的实体字典列表。
        merge_map: 可选，``别名 → canonical``；与实体内 aliases 互补。

    Returns:
        ``{canonical: {canonical, alias1, ...}}``。
    """
    lookup: dict[str, set[str]] = {}
    for ent in entities:
        canon = str(ent.get("id") or ent.get("name") or "").strip()
        if not canon:
            continue
        names = lookup.setdefault(canon, {canon})
        for alias in ent.get("aliases") or []:
            a = str(alias).strip()
            if a:
                names.add(a)
    for alias, target in (merge_map or {}).items():
        a = str(alias).strip()
        t = str(target).strip()
        if a and t:
            lookup.setdefault(t, {t}).add(a)
    return lookup


def entity_name_matches(
    entity_id: str,
    subject: str,
    obj: str,
    alias_lookup: dict[str, set[str]],
) -> bool:
    """判断三元组主/客体是否命中某实体（含别名）。

    Args:
        entity_id: 图谱中的 canonical 实体 id。
        subject: 三元组主语。
        obj: 三元组宾语。
        alias_lookup: :func:`build_alias_lookup` 的结果。

    Returns:
        ``subject`` 或 ``obj`` 落在该实体名称集合内则为 True。
    """
    names = alias_lookup.get(entity_id) or {entity_id}
    return subject in names or obj in names
