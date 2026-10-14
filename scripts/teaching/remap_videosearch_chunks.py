"""把 VAT-KG 旧 cue 映射到 VideoSearch ppt_change chunk，并可把图谱/资产上的 cue 换成新划分。

讲次：VideoSearch 视频编号（0-based，第 N 讲 = video N-1）与 VAT-KG lecture_id 用 ASR 唯一 4-gram 对齐。
片段：ASR（主）+ 时间锚点拉伸（辅）+ OCR（弱）；单调约束。两边录像不同步，不能直接比时间轴。

默认只写 plan。加 --apply 才写出替换后的 cues / triplets / kg / assets / showcase JSON
（原文件不改，写到 --apply-dir）。
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COURSE = "离散数学(图论+数理逻辑与集合论)"

NORM = re.compile(r"[^\u4e00-\u9fffA-Za-z0-9]")
TAG = re.compile(r"<[^>]+>|```\w*")
SRT_TS = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")
COMMON_DF_RATIO = 0.3
UNMATCHED_SCORE = 0.05
W_OCR, W_ASR, W_TIME = 0.15, 0.55, 0.30
FALLBACK_MIN = 0.10
LECTURE_SCORE_HIGH, LECTURE_MARGIN_HIGH = 150, 1.5
LECTURE_SCORE_OK, LECTURE_MARGIN_OK = 80, 1.15


def norm(text: str) -> str:
    return NORM.sub("", TAG.sub(" ", text or "")).lower()


def ngrams(text: str, n: int) -> Counter:
    t = text.replace(" ", "")
    return Counter(t[i:i + n] for i in range(len(t) - n + 1))


def mmss(s: str) -> float:
    parts = [float(x) for x in s.strip().split(":")]
    return parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0] * 3600 + parts[1] * 60 + parts[2]


def hms_ms(s: str) -> float:
    h, m, rest = s.split(":")
    sec, _, ms = rest.partition(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms or 0) / 1000


def read_seg(path: Path) -> list[float]:
    if not path.is_file():
        return []
    return sorted(mmss(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip())


def read_srt(path: Path) -> list[tuple[float, float, str, str]]:
    """(start, end, raw, normalized)."""
    out: list[tuple[float, float, str, str]] = []
    if not path.is_file():
        return out
    for block in re.split(r"\n\s*\n", path.read_text(encoding="utf-8", errors="replace")):
        lines = [l for l in block.strip().splitlines() if l.strip()]
        for i, line in enumerate(lines):
            m = SRT_TS.search(line)
            if m:
                g = list(map(int, m.groups()))
                s = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
                e = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
                raw = "".join(lines[i + 1 :])
                out.append((s, e, raw, norm(raw)))
                break
    return out


def text_in_span(spans: list[tuple[float, float, str, str]], s: float, e: float, *, raw: bool = False) -> str:
    parts = []
    for bs, be, *rest in spans:
        t = rest[0] if raw else rest[1]
        if be <= s or bs >= e or not t:
            continue
        dur = max(1e-6, be - bs)
        a = int(len(t) * max(0.0, (s - bs) / dur))
        b = int(math.ceil(len(t) * min(1.0, (e - bs) / dur)))
        parts.append(t[a:b])
    return "".join(parts)


def intervals(bounds: list[float], end: float) -> list[tuple[float, float]]:
    cuts = [0.0] + [b for b in bounds if 0 < b < end] + [end]
    return [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1) if cuts[i + 1] > cuts[i]]


def cue_id_for(course: str, lecture: str, start: float, end: float) -> str:
    return f"{course}_{lecture}_{int(round(start * 1000))}_{int(round(end * 1000))}"


@dataclass
class Unit:
    uid: str
    start: float
    end: float
    ocr: str
    asr: str
    asr_raw: str = ""
    extra: dict = field(default_factory=dict)


def load_new_chunks(vs_root: Path, video: int, *, course: str, lecture: str) -> list[Unit]:
    srt = read_srt(vs_root / "stage1" / "srt" / f"{video}_0.srt")
    dur = srt[-1][1] if srt else 0.0
    ocr_segs = []
    p = vs_root / "stage2" / f"{video}_ocrsum.json"
    if p.is_file():
        for seg in json.loads(p.read_text(encoding="utf-8")).get("segments", []):
            ocr_segs.append((hms_ms(seg["start_time"]), hms_ms(seg["end_time"]), norm(seg.get("text", ""))))
    units = []
    for k, (s, e) in enumerate(intervals(read_seg(vs_root / "stage1" / "ppt_change" / f"{video}_seg.txt"), dur)):
        ocr = " ".join(
            t
            for os_, oe, t in ocr_segs
            if min(e, oe + 1) - max(s, os_) > 0.5 * max(1.0, min(e - s, oe - os_))
        )
        uid = cue_id_for(course, lecture, s, e)
        units.append(
            Unit(
                uid,
                s,
                e,
                ocr,
                text_in_span(srt, s, e),
                text_in_span(srt, s, e, raw=True),
                {"video": video, "seg_index": k, "vs_uid": f"v{video}#{k}"},
            )
        )
    return units


def load_old_cues(vat_root: Path, course: str, lecture: str) -> list[Unit]:
    seg_dir = vat_root / "data" / "segments" / course
    cues = [
        json.loads(l)
        for l in (seg_dir / "cues.jsonl").read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]
    cues = sorted((c for c in cues if str(c.get("lecture_id")) == lecture), key=lambda c: float(c["start_sec"]))
    srt = read_srt(seg_dir / "asr" / f"{lecture}_0.srt")
    end = max([float(c["end_sec"]) for c in cues] + [srt[-1][1] if srt else 0.0])
    pages = intervals(read_seg(seg_dir / "ppt_change" / f"{lecture}_seg.txt"), end)
    ocr_path = seg_dir / "asr_work" / lecture / "ocr" / "ppt_ocr.json"
    page_text = {}
    if ocr_path.is_file():
        page_text = {int(k): norm(v) for k, v in json.loads(ocr_path.read_text(encoding="utf-8")).get("pages", {}).items()}
    units = []
    for c in cues:
        s, e = float(c["start_sec"]), float(c["end_sec"])
        idx = [k for k, (ps, pe) in enumerate(pages) if min(e, pe) - max(s, ps) > 0.5 * min(pe - ps, e - s)]
        units.append(
            Unit(
                c["cue_id"],
                s,
                e,
                " ".join(page_text.get(k, "") for k in idx),
                text_in_span(srt, s, e) or norm(c.get("asr_text", "")),
                c.get("asr_text") or "",
                {"pages": idx, "raw_cue": c},
            )
        )
    return units


def _timed_unique_4grams(spans: list[tuple[float, float, str, str]]) -> dict[str, float]:
    idx: dict[str, list[float]] = defaultdict(list)
    for s, e, _raw, t in spans:
        if len(t) < 4:
            continue
        for i in range(len(t) - 3):
            g = t[i : i + 4]
            idx[g].append(s + (e - s) * (i / max(1, len(t) - 1)))
    return {g: times[0] for g, times in idx.items() if len(times) == 1}


def time_warp(old_spans, new_spans) -> list[tuple[float, float]]:
    """单调锚点链 [(old_t, new_t), ...]。"""
    old_u = _timed_unique_4grams(old_spans)
    new_u = _timed_unique_4grams(new_spans)
    pairs = sorted(((new_u[g], old_u[g]) for g in old_u.keys() & new_u.keys()), key=lambda x: x[0])
    if not pairs:
        return []
    tails: list[float] = []
    tail_idx: list[int] = []
    prev = [-1] * len(pairs)
    for i, (_, o) in enumerate(pairs):
        k = bisect.bisect_left(tails, o)
        if k == len(tails):
            tails.append(o)
            tail_idx.append(i)
        else:
            tails[k] = o
            tail_idx[k] = i
        prev[i] = tail_idx[k - 1] if k else -1
    chain = []
    i = tail_idx[-1] if tail_idx else -1
    while i >= 0:
        n, o = pairs[i]
        chain.append((o, n))
        i = prev[i]
    chain.reverse()
    return chain


def warp_t(chain: list[tuple[float, float]], t: float) -> float:
    if not chain:
        return t
    if t <= chain[0][0]:
        return chain[0][1] + (t - chain[0][0])
    if t >= chain[-1][0]:
        return chain[-1][1] + (t - chain[-1][0])
    lo, hi = 0, len(chain) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if chain[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    o0, n0 = chain[lo]
    o1, n1 = chain[hi]
    a = 0.0 if o1 == o0 else (t - o0) / (o1 - o0)
    return n0 + a * (n1 - n0)


def overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def similarity(
    old: list[Unit], new: list[Unit], chain: list[tuple[float, float]]
) -> tuple[list[list[float]], list[list[float]], list[list[float]], list[list[float]]]:
    def grams(u: Unit, attr: str, n: int) -> set[str]:
        return set(ngrams(getattr(u, attr), n))

    def contain_matrix(attr: str, n: int) -> list[list[float]]:
        og = [grams(u, attr, n) for u in old]
        ng = [grams(u, attr, n) for u in new]
        df = Counter(g for s in og + ng for g in s)
        cap = max(2, int(COMMON_DF_RATIO * (len(og) + len(ng))))
        w = {g: 1.0 / math.log(1 + k) for g, k in df.items() if k <= cap}
        mat = []
        for o in og:
            row = []
            for q in ng:
                denom = sum(w.get(g, 0.0) for g in q)
                row.append(sum(w.get(g, 0.0) for g in q & o) / denom if denom else 0.0)
            mat.append(row)
        return mat

    ocr = contain_matrix("ocr", 3)
    asr = contain_matrix("asr", 4)
    tm = []
    for u in old:
        ws, we = warp_t(chain, u.start), warp_t(chain, u.end)
        if we < ws:
            ws, we = we, ws
        row = []
        for v in new:
            ov = overlap(ws, we, v.start, v.end)
            denom = max(1e-6, min(we - ws, v.end - v.start))
            row.append(ov / denom)
        tm.append(row)
    total = [
        [W_OCR * ocr[i][j] + W_ASR * asr[i][j] + W_TIME * tm[i][j] for j in range(len(new))]
        for i in range(len(old))
    ]
    return total, ocr, asr, tm


def monotone_align(score: list[list[float]]) -> list[int | None]:
    """每个新 chunk 选一个旧 cue（或不配），旧 cue 序号沿新 chunk 顺序不减。"""
    n = len(score)
    m = len(score[0]) if n else 0
    if not n or not m:
        return [None] * m
    neg = float("-inf")
    best = [[neg] * n for _ in range(m)]
    back: list[list[int | None]] = [[None] * n for _ in range(m)]
    skip = [0.0] * m
    skip_back: list[int | None] = [None] * m
    for j in range(m):
        prev = best[j - 1] if j else None
        run, run_i = (skip[j - 1] if j else 0.0), None
        for i in range(n):
            if prev is not None and prev[i] > run:
                run, run_i = prev[i], i
            best[j][i] = run + score[i][j]
            back[j][i] = run_i
        if j:
            top = max(range(n), key=lambda i: prev[i])
            skip[j], skip_back[j] = max(
                (skip[j - 1] + UNMATCHED_SCORE, None),
                (prev[top] + UNMATCHED_SCORE, top),
                key=lambda x: x[0],
            )
        else:
            skip[j] = UNMATCHED_SCORE
    assign: list[int | None] = [None] * m
    i_best = max(range(n), key=lambda i: best[m - 1][i])
    state: int | None = i_best if best[m - 1][i_best] >= skip[m - 1] else None
    for j in range(m - 1, -1, -1):
        assign[j] = state
        state = back[j][state] if state is not None else skip_back[j]
    return assign


def plan_lecture(old: list[Unit], new: list[Unit], chain: list[tuple[float, float]]) -> dict:
    total, ocr, asr, tm = similarity(old, new, chain)
    assign = monotone_align(total)
    cues = []
    for i, u in enumerate(old):
        js = [j for j, a in enumerate(assign) if a == i]
        mode = "aligned"
        if not js:
            lo = max([j for j, a in enumerate(assign) if a is not None and a < i] + [0])
            hi = min([j for j, a in enumerate(assign) if a is not None and a > i] + [len(new) - 1])
            cand = list(range(lo, hi + 1)) if lo <= hi else list(range(len(new)))
            best_j = max(cand, key=lambda j: total[i][j])
            if total[i][best_j] >= FALLBACK_MIN:
                js = [best_j]
                mode = "fallback"
            else:
                js = []
                mode = "unmatched"
        if js:
            weights = [total[i][j] for j in js]
            primary = js[max(range(len(js)), key=lambda k: weights[k])]
            cues.append(
                {
                    "old_cue_id": u.uid,
                    "old_span": [u.start, u.end],
                    "old_pages": u.extra.get("pages", []),
                    "mode": mode,
                    "new_chunks": [new[j].uid for j in js],
                    "primary": new[primary].uid,
                    "score": round(sum(weights) / len(weights), 4),
                    "ocr": round(max(ocr[i][j] for j in js), 4),
                    "asr": round(max(asr[i][j] for j in js), 4),
                    "time": round(max(tm[i][j] for j in js), 4),
                }
            )
        else:
            cues.append(
                {
                    "old_cue_id": u.uid,
                    "old_span": [u.start, u.end],
                    "old_pages": u.extra.get("pages", []),
                    "mode": "unmatched",
                    "new_chunks": [],
                    "primary": None,
                    "score": 0.0,
                    "ocr": 0.0,
                    "asr": 0.0,
                    "time": 0.0,
                }
            )
    chunks = [
        {
            "chunk": u.uid,
            "vs_uid": u.extra.get("vs_uid"),
            "span": [u.start, u.end],
            "old_cue": old[a].uid if a is not None else None,
            "score": round(total[a][j], 4) if a is not None else 0.0,
            "asr_raw": u.asr_raw,
        }
        for j, (u, a) in enumerate(zip(new, assign))
    ]
    return {"cues": cues, "chunks": chunks, "n_warp_anchors": len(chain)}


def lecture_confidence(score: int, margin: float) -> str:
    if score >= LECTURE_SCORE_HIGH and margin >= LECTURE_MARGIN_HIGH:
        return "high"
    if score >= LECTURE_SCORE_OK and margin >= LECTURE_MARGIN_OK:
        return "medium"
    return "low"


def match_lectures(vs_root: Path, vat_root: Path, course: str) -> list[dict]:
    """每个视频独立选 top-1 旧讲次；冲突时高分留下，低分改用未占用的 runner-up。"""
    seg_dir = vat_root / "data" / "segments" / course

    def uniq(text: str) -> set[str]:
        return {g for g, k in ngrams(text, 4).items() if k == 1}

    old_asr = {
        int(p.stem.split("_")[0]): uniq("".join(t for *_, t in read_srt(p)))
        for p in (seg_dir / "asr").glob("*_0.srt")
    }
    df_asr = Counter(g for s in old_asr.values() for g in s)
    rows = []
    for p in sorted((vs_root / "stage1" / "srt").glob("*_0.srt"), key=lambda x: int(x.stem.split("_")[0])):
        v = int(p.stem.split("_")[0])
        na = uniq("".join(t for *_, t in read_srt(p)))
        scores = {L: len({g for g in na & old_asr[L] if df_asr[g] == 1}) for L in old_asr}
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        rows.append({"video": v, "scores": scores, "ranked": ranked})

    chosen: dict[int, int] = {}
    taken: dict[int, int] = {}
    for score, v, L in sorted(((r["ranked"][0][1], r["video"], r["ranked"][0][0]) for r in rows if r["ranked"]), reverse=True):
        if v in chosen:
            continue
        if L not in taken:
            chosen[v] = L
            taken[L] = v
            continue
        for alt, alt_s in rows[[x["video"] for x in rows].index(v)]["ranked"][1:]:
            if alt not in taken and alt_s >= LECTURE_SCORE_OK:
                chosen[v] = alt
                taken[alt] = v
                break
        if v not in chosen:
            chosen[v] = L

    out = []
    for r in rows:
        ranked = r["ranked"]
        L = chosen.get(r["video"])
        s1 = r["scores"].get(L, 0) if L is not None else 0
        others = [s for k, s in ranked if k != L]
        s2 = others[0] if others else 0
        margin = round(s1 / max(1, s2), 2)
        out.append(
            {
                "video": r["video"],
                "old_lecture": str(L) if L is not None else None,
                "score": s1,
                "runner_up": str(ranked[0][0] if ranked and ranked[0][0] != L else (ranked[1][0] if len(ranked) > 1 else None)),
                "margin": margin,
                "confidence": lecture_confidence(s1, margin),
                "top3": [[str(k), s] for k, s in ranked[:3]],
            }
        )
    return out


def build_plan(vs_root: Path, vat_root: Path, course: str, canvas: str, override: dict[int, str] | None) -> dict:
    lectures = match_lectures(vs_root, vat_root, course)
    if override:
        for row in lectures:
            if row["video"] in override:
                row.update(
                    old_lecture=str(override[row["video"]]),
                    source="override",
                    confidence="high",
                    score=max(row.get("score") or 0, 999),
                )
    plan: dict[str, Any] = {"course_id": course, "canvas_course": canvas, "lectures": []}
    print("video  old_L  conf    score  margin  top3")
    for row in lectures:
        print(
            f"{row['video']:5d}  L{str(row['old_lecture']):<4}  {row['confidence']:<6}  {row['score']:5d}  {row['margin']:5.2f}   {row['top3']}"
        )
        old = load_old_cues(vat_root, course, row["old_lecture"]) if row["old_lecture"] else []
        new = load_new_chunks(vs_root, row["video"], course=course, lecture=str(row["old_lecture"])) if row["old_lecture"] else []
        seg_dir = vat_root / "data" / "segments" / course
        chain = time_warp(
            read_srt(seg_dir / "asr" / f"{row['old_lecture']}_0.srt"),
            read_srt(vs_root / "stage1" / "srt" / f"{row['video']}_0.srt"),
        ) if row["old_lecture"] else []
        lp = plan_lecture(old, new, chain) if old and new else {"cues": [], "chunks": [], "n_warp_anchors": 0}
        plan["lectures"].append({**row, "n_old_cues": len(old), "n_new_chunks": len(new), **lp})
    print("\nvideo old_L  conf    aligned/fb/un  chunks(m/u)  mean  low  warp")
    for lec in plan["lectures"]:
        cues = lec["cues"]
        al = sum(c["mode"] == "aligned" for c in cues)
        fb = sum(c["mode"] == "fallback" for c in cues)
        un = sum(c["mode"] == "unmatched" for c in cues)
        mt = sum(c["old_cue"] is not None for c in lec["chunks"])
        mean = sum(c["score"] for c in cues) / max(1, len(cues))
        low = sum(c["score"] < 0.15 for c in cues)
        print(
            f"{lec['video']:5d}  L{str(lec['old_lecture']):<4}  {lec['confidence']:<6} "
            f"{al:3d}/{fb:<2d}/{un:<2d}         {mt:3d}/{lec['n_new_chunks'] - mt:<3d}     "
            f"{mean:.3f}  {low:3d}  {lec.get('n_warp_anchors', 0)}"
        )
    return plan


def mapping_from_plan(lec: dict) -> dict[str, dict]:
    """old_cue_id -> {primary, all, start, end} using new chunk metadata."""
    chunk = {c["chunk"]: c for c in lec["chunks"]}
    out = {}
    for row in lec["cues"]:
        if not row.get("primary"):
            continue
        ch = chunk[row["primary"]]
        out[row["old_cue_id"]] = {
            "primary": row["primary"],
            "all": row["new_chunks"],
            "start": ch["span"][0],
            "end": ch["span"][1],
            "score": row["score"],
            "mode": row["mode"],
        }
    return out


def rewrite_tree(obj: Any, mp: dict[str, dict]) -> Any:
    if isinstance(obj, list):
        return [rewrite_tree(x, mp) for x in obj]
    if not isinstance(obj, dict):
        return obj
    out = {k: rewrite_tree(v, mp) for k, v in obj.items()}
    cid = out.get("cue_id")
    if isinstance(cid, str) and cid in mp:
        info = mp[cid]
        out["cue_id"] = info["primary"]
        out["start_sec"] = info["start"]
        out["end_sec"] = info["end"]
        if "cue_label" in out:
            out["cue_label"] = info["primary"]
    if isinstance(out.get("cue_ids"), list):
        seen, merged = set(), []
        for x in out["cue_ids"]:
            for n in mp.get(str(x), {}).get("all") or ([mp[str(x)]["primary"]] if str(x) in mp else [x]):
                if n and n not in seen:
                    seen.add(n)
                    merged.append(n)
        out["cue_ids"] = merged
    g = out.get("grounding")
    if isinstance(g, dict) and isinstance(g.get("cue_id"), str) and g["cue_id"] in mp:
        info = mp[g["cue_id"]]
        g = {**g, "cue_id": info["primary"], "start_sec": info["start"], "end_sec": info["end"]}
        out["grounding"] = g
    return out


def apply_plan(plan: dict, vat_root: Path, dest: Path) -> None:
    course = plan["course_id"]
    dest.mkdir(parents=True, exist_ok=True)
    mp_all: dict[str, dict] = {}
    # 同一旧讲次只保留置信度最高的一条视频
    best: dict[str, dict] = {}
    for lec in plan["lectures"]:
        if lec.get("confidence") == "low" or not lec.get("old_lecture"):
            continue
        if not mapping_from_plan(lec):
            continue
        lid = str(lec["old_lecture"])
        prev = best.get(lid)
        if prev is None or lec.get("score", 0) > prev.get("score", 0):
            best[lid] = lec
    lecture_ok = list(best)
    chosen_videos = {lec["video"] for lec in best.values()}
    for lec in best.values():
        mp_all.update(mapping_from_plan(lec))

    src_cues = vat_root / "data" / "segments" / course / "cues.jsonl"
    new_cues = []
    kept = 0
    replaced = set(lecture_ok)
    for line in src_cues.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if str(row.get("lecture_id")) not in replaced:
            new_cues.append(row)
            kept += 1
    for lec in plan["lectures"]:
        if lec.get("video") not in chosen_videos:
            continue
        for ch in lec["chunks"]:
            s, e = ch["span"]
            lid = str(lec["old_lecture"])
            new_cues.append(
                {
                    "cue_id": ch["chunk"],
                    "segment_id": ch["chunk"],
                    "course_id": course,
                    "lecture_id": lid,
                    "start_sec": s,
                    "end_sec": e,
                    "duration_sec": e - s,
                    "asr_text": ch.get("asr_raw") or "",
                    "boundary_type": "videosearch_ppt_change",
                    "extra": {
                        "video": lec["video"],
                        "vs_uid": ch.get("vs_uid"),
                        "old_cue": ch.get("old_cue"),
                        "canvas_course": plan.get("canvas_course"),
                    },
                }
            )
    new_cues.sort(key=lambda r: (str(r.get("lecture_id")), float(r.get("start_sec") or 0)))
    out_seg = dest / "segments"
    out_seg.mkdir(parents=True, exist_ok=True)
    (out_seg / "cues.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in new_cues), encoding="utf-8"
    )

    kg_src = vat_root / "data" / "kg" / course
    kg_dst = dest / "kg"
    kg_dst.mkdir(parents=True, exist_ok=True)
    trips_in = kg_src / "triplets.jsonl"
    if trips_in.is_file():
        rows = []
        for line in trips_in.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(rewrite_tree(json.loads(line), mp_all))
        (kg_dst / "triplets.jsonl").write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
        )
    kgj = kg_src / "kg.json"
    if kgj.is_file():
        (kg_dst / "kg.json").write_text(
            json.dumps(rewrite_tree(json.loads(kgj.read_text(encoding="utf-8")), mp_all), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    lib = kg_src / "assets" / "library.json"
    if lib.is_file():
        (kg_dst / "assets").mkdir(parents=True, exist_ok=True)
        (kg_dst / "assets" / "library.json").write_text(
            json.dumps(rewrite_tree(json.loads(lib.read_text(encoding="utf-8")), mp_all), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    for lid in lecture_ok:
        src = kg_src / f"lecture_{lid}" / "kg.json"
        if src.is_file():
            d = dest / "kg" / f"lecture_{lid}"
            d.mkdir(parents=True, exist_ok=True)
            (d / "kg.json").write_text(
                json.dumps(rewrite_tree(json.loads(src.read_text(encoding="utf-8")), mp_all), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    viz_src = vat_root / "data" / "viz" / course
    viz_dst = dest / "viz"
    viz_dst.mkdir(parents=True, exist_ok=True)
    for lid in lecture_ok:
        for name in (f"kg_processed_lecture_{lid}.json", f"pipeline_build_lecture_{lid}.json"):
            src = viz_src / name
            if not src.is_file():
                continue
            data = json.loads(src.read_text(encoding="utf-8"))
            if name.startswith("pipeline_build") and isinstance(data.get("items"), list):
                data = _rebuild_pipeline_items(data, lec_by_id(plan, lid), mp_all)
            else:
                data = rewrite_tree(data, mp_all)
            (viz_dst / name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    meta = {
        "lectures_applied": lecture_ok,
        "mapped_old_cues": len(mp_all),
        "cues_kept_other_lectures": kept,
        "note": "low-confidence videos skipped; originals untouched",
    }
    (dest / "apply_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("apply ->", dest)
    print(json.dumps(meta, ensure_ascii=False, indent=2))


def lec_by_id(plan: dict, lecture: str) -> dict:
    for lec in plan["lectures"]:
        if str(lec.get("old_lecture")) == str(lecture):
            return lec
    raise KeyError(lecture)


def _rebuild_pipeline_items(data: dict, lec: dict, mp: dict[str, dict]) -> dict:
    old_items = {it.get("cue_id"): it for it in data.get("items") or [] if isinstance(it, dict)}
    new_items = []
    for ch in lec["chunks"]:
        nid = ch["chunk"]
        donors = [old_items[c["old_cue_id"]] for c in lec["cues"] if nid in (c.get("new_chunks") or []) and c["old_cue_id"] in old_items]
        if not donors:
            continue
        base = json.loads(json.dumps(donors[0], ensure_ascii=False))
        s, e = ch["span"]
        base["cue_id"] = nid
        base["start_sec"] = s
        base["end_sec"] = e
        base["asr_text"] = ch.get("asr_raw") or base.get("asr_text")
        trips = []
        for d in donors:
            for t in d.get("triplets") or []:
                trips.append(rewrite_tree(t, mp))
        base["triplets"] = trips
        new_items.append(rewrite_tree(base, mp))
        new_items[-1]["cue_id"] = nid
        new_items[-1]["start_sec"] = s
        new_items[-1]["end_sec"] = e
    data = rewrite_tree(data, mp)
    data["items"] = new_items
    data["cue_count"] = len(new_items)
    return data


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--vs-root", type=Path, required=True)
    ap.add_argument("--course-id", default=DEFAULT_COURSE)
    ap.add_argument("--vat-root", type=Path, default=ROOT)
    ap.add_argument("--canvas-course", default="88078")
    ap.add_argument("--lecture-map", type=Path, help="JSON {video: old_lecture} 覆盖自动讲次识别")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--apply-dir", type=Path)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    override = None
    if args.lecture_map:
        raw = json.loads(args.lecture_map.read_text(encoding="utf-8"))
        override = {int(k): str(v) for k, v in raw.items() if not str(k).startswith("_")}
    plan = build_plan(args.vs_root, args.vat_root, args.course_id, args.canvas_course, override)
    out = args.out or (
        args.vat_root / "data" / "processed" / args.course_id / "videosearch_remap_plan.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\nplan ->", out)
    if args.apply:
        dest = args.apply_dir or (args.vat_root / "data" / "processed" / args.course_id / "videosearch_remapped")
        apply_plan(plan, args.vat_root, dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
