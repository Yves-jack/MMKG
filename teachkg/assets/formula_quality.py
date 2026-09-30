"""公式卡质量：只保留可复用的通式 / 计数公式 / 课程级记号约定。

实例谓词（Embrace、小弟弟）、程序点断言（A 点谓词）、故事代入式
（所有人终有一死）、以及课堂闲笔里的微积分史，一律不当公式。
"""

from __future__ import annotations

import re
from typing import Any

from teachkg.assets.overlap import primary_zh

# 故事 / 例题里的专名，不应成为通式名
_STORY = re.compile(
    r"(小弟弟|红气球|抱住|苏格拉底|柏拉图|亚当|夏娃|终有一死|"
    r"所有人都会死|所有人终有一死)"
)
_OFF_TOPIC = re.compile(r"(牛顿|莱布尼茨|流数|微积分|导数积分|积分和式)")
_PROGRAM_POINT = re.compile(r"([ABCD]点(谓词)?|点谓词|程序点|循环不变)")
_SCHEMA_CUE = re.compile(
    r"(约定|记号|形式|规则|定理|公式|条件|充要|一般|任意|对所有|对任意|"
    r"基本形式|易名|握手|完全图|补图|空图|量词|分离)"
)
# 例题里临时发明的英文谓词：Embrace(x)、LittleBrother(x)
_EXAMPLE_PRED = re.compile(
    r"\b(Embrace|LittleBrother|Balloon|Big|Red|Man|Likes|father|teacher)\s*\(",
    re.I,
)
_CAMEL_PRED = re.compile(r"\b[A-Z][a-z]+[A-Z][a-zA-Z]*\s*\(")


def formula_drop_reason(
    name: str,
    *,
    latex: str = "",
    summary: str = "",
    evidence: str = "",
) -> str | None:
    """返回丢弃原因；None 表示这是可保留的通式。"""
    zh = primary_zh(name)
    ev = (evidence or "").strip()

    if _OFF_TOPIC.search(zh) or _OFF_TOPIC.search(summary or ""):
        return "off-topic formula"
    if _PROGRAM_POINT.search(zh):
        return "instance program predicate"
    if _STORY.search(zh):
        return "example-instantiated formula"

    # 「P(x,y)定义为 x+y=2」是例题赋值，不是通式
    if "定义为" in zh:
        return "example definition labeled formula"
    if ev.startswith("例如") and not _SCHEMA_CUE.search(zh):
        return "example-local formula"

    # 名称本身就是某个例题谓词
    if not _SCHEMA_CUE.search(zh):
        if _EXAMPLE_PRED.search(name) or _EXAMPLE_PRED.search(latex or ""):
            return "example predicate symbol"
        if _CAMEL_PRED.search(name) or _CAMEL_PRED.search(latex or ""):
            return "example predicate symbol"
        # 「个体常项 a、b」——指向该例里的两个常量，不是课程约定
        if re.fullmatch(r"个体常项\s*[a-zA-Z、, ]+", zh):
            return "example-local constants"

    # G-v / G-e / G+e 是操作记号，不是可复用恒等式
    if re.match(r"(删去顶点|删去边|加边)", zh):
        return "operator notation not identity"

    # 只起名、没有等式/量词/求和的「记号」不当通式（个体/谓词字母约定除外）
    has_math = bool(re.search(r"(=|\\sum|\\forall|\\exists|\\to|\\rightarrow|\\land)", latex or ""))
    if re.search(r"记号", zh) and not has_math and not re.search(r"(个体|谓词|命题|量词)", zh):
        return "bare notation"
    if re.search(r"权值.*设为\s*1|设为\s*1.*权值", zh):
        return "default assumption not formula"

    return None


def _formula_family(name: str) -> str | None:
    zh = primary_zh(name)
    if "握手" in zh:
        return "handshake"
    if re.search(r"完全图.*边数|边数.*完全图", zh):
        return "complete_edges"
    if "个体" in zh and re.search(r"(字母|记号|常项|变项)", zh):
        return "indiv_notation"
    if re.search(r"(谓词变项|命题与谓词)", zh):
        return "letter_pred"
    return None


def _card_name(card: Any) -> str:
    return str(card.get("name") or "") if isinstance(card, dict) else str(card.name or "")


def _card_field(card: Any, *keys: str) -> str:
    if isinstance(card, dict):
        for k in keys:
            v = str(card.get(k) or "")
            if v:
                return v
        return ""
    for k in keys:
        v = str(getattr(card, k, "") or "")
        if v:
            return v
    return ""


def _richer_formula(card: Any, prev: Any) -> bool:
    def score(c: Any) -> tuple:
        n = _card_name(c)
        return (
            int("公式" in n),
            len(_card_field(c, "latex")),
            len(_card_field(c, "statement", "summary")),
            len(n),
        )

    return score(card) > score(prev)


def _norm_latex(latex: str) -> str:
    s = re.sub(r"\s+", "", latex or "")
    s = s.replace("\\,", "").replace("\\ ", "")
    return s


def keep_generic_formulas(cards: list[Any]) -> list[Any]:
    """过滤公式卡；例子和其他 kind 原样保留。同 latex 去重，留陈述更完整的。"""
    kept: list[Any] = []
    dropped_names: list[str] = []
    for card in cards:
        kind = getattr(card, "kind", None) or (card.get("kind") if isinstance(card, dict) else "")
        if kind != "formula":
            kept.append(card)
            continue
        if isinstance(card, dict):
            name = str(card.get("name") or "")
            reason = formula_drop_reason(
                name,
                latex=str(card.get("latex") or ""),
                summary=str(card.get("summary") or ""),
                evidence=str(card.get("evidence") or ""),
            )
        else:
            name = str(card.name or "")
            reason = formula_drop_reason(
                name,
                latex=str(getattr(card, "latex", "") or ""),
                summary=str(getattr(card, "summary", "") or ""),
                evidence=str(getattr(card, "evidence", "") or ""),
            )
        if reason:
            dropped_names.append(f"{name} ({reason})")
            continue
        kept.append(card)

    by_tex: dict[str, Any] = {}
    others: list[Any] = []
    for card in kept:
        kind = getattr(card, "kind", None) or (card.get("kind") if isinstance(card, dict) else "")
        if kind != "formula":
            others.append(card)
            continue
        latex = (
            str(card.get("latex") or "")
            if isinstance(card, dict)
            else str(getattr(card, "latex", "") or "")
        )
        key = _norm_latex(latex)
        if not key:
            others.append(card)
            continue
        prev = by_tex.get(key)
        if prev is None:
            by_tex[key] = card
            continue
        prev_name = (
            str(prev.get("name") or "")
            if isinstance(prev, dict)
            else str(prev.name or "")
        )
        name = (
            str(card.get("name") or "")
            if isinstance(card, dict)
            else str(card.name or "")
        )
        if _richer_formula(card, prev):
            by_tex[key] = card

    merged = others + list(by_tex.values())
    by_family: dict[str, Any] = {}
    rest: list[Any] = []
    for card in merged:
        kind = getattr(card, "kind", None) or (card.get("kind") if isinstance(card, dict) else "")
        if kind != "formula":
            rest.append(card)
            continue
        fam = _formula_family(_card_name(card))
        if not fam:
            rest.append(card)
            continue
        prev = by_family.get(fam)
        if prev is None or _richer_formula(card, prev):
            by_family[fam] = card
    return rest + list(by_family.values())
