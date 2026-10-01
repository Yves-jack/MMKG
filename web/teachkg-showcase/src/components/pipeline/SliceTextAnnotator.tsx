import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isBidirectionalRelation, RELATION_EDGE_COLOR, relationArrowText } from "@/lib/pipeline/graphLogic";
import type { PipelineEdge } from "@/lib/pipeline/types";
import { LatexText } from "./LatexText";
import styles from "./SliceTextAnnotator.module.css";

export type SliceAnnTriple = {
  id: string;
  from: string;
  to: string;
  pred: string;
  concrete?: string;
  direction?: string;
};

type SpanGroup = {
  start: number;
  end: number;
  triples: SliceAnnTriple[];
};

type Seg =
  | { kind: "text"; value: string }
  | { kind: "ann"; value: string; triples: SliceAnnTriple[]; key: string };

type HoverTip = {
  key: string;
  triples: SliceAnnTriple[];
  x: number;
  y: number;
  above?: boolean;
  caretX?: number;
  color?: string;
};

function zh(name: string) {
  return (name || "").split("/")[0];
}

function relColor(pred: string) {
  return RELATION_EDGE_COLOR[pred] || "#3ecf8e";
}

const PUNCT_MAP: Record<string, string> = {
  "，": ",",
  "。": ".",
  "；": ";",
  "：": ":",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "「": "[",
  "」": "]",
  "、": ",",
  "“": "'",
  "”": "'",
  "‘": "'",
  "’": "'",
  "′": "'",
  "'": "'",
  "＇": "'",
  '"': "'",
  "＂": "'",
  "—": "-",
  "–": "-",
  "−": "-",
  "～": "~",
  "·": ".",
  "•": ".",
  "…": "...",
};

const MATH_SYM: Record<string, string> = {
  wedge: "∧",
  vee: "∨",
  land: "∧",
  lor: "∨",
  neg: "¬",
  lnot: "¬",
  to: "→",
  rightarrow: "→",
  leftrightarrow: "↔",
  iff: "↔",
  forall: "∀",
  exists: "∃",
  in: "∈",
  subseteq: "⊆",
  subset: "⊂",
  cup: "∪",
  cap: "∩",
  times: "×",
  cdot: "·",
  emptyset: "∅",
};

/** 逐字规范化，保留原文下标映射；折叠空白/公式/引号差异 */
function normalizeForMatch(s: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = "";
  const raw = s || "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "$") {
      const dbl = raw[i + 1] === "$";
      const close = dbl ? "$$" : "$";
      const start = i + close.length;
      const end = raw.indexOf(close, start);
      if (end >= 0) {
        const nested = normalizeForMatch(raw.slice(start, end));
        for (let k = 0; k < nested.norm.length; k++) {
          map.push(nested.map[k]! + start);
          norm += nested.norm[k];
        }
        i = end + close.length;
        continue;
      }
    }
    if (ch === "\\" && /[a-zA-Z]/.test(raw[i + 1] || "")) {
      let j = i + 1;
      while (j < raw.length && /[a-zA-Z]/.test(raw[j]!)) j += 1;
      const sym = MATH_SYM[raw.slice(i + 1, j).toLowerCase()];
      if (sym) {
        map.push(i);
        norm += sym;
      }
      i = j;
      while (raw[i] === "{" || raw[i] === "}") i += 1;
      continue;
    }
    if ("{}`*#~".includes(ch)) {
      i += 1;
      continue;
    }
    map.push(i);
    norm += PUNCT_MAP[ch] || ch;
    i += 1;
  }
  return { norm, map };
}

function spanFromNorm(
  map: number[],
  ni: number,
  nlen: number
): { start: number; end: number } | null {
  if (ni < 0 || nlen <= 0 || !map.length) return null;
  const start = map[ni];
  const endIdx = Math.min(ni + nlen - 1, map.length - 1);
  const end = map[endIdx]! + 1;
  if (start == null || end <= start) return null;
  return { start, end };
}

/** 去掉标点后的内容串，便于模糊对齐 */
function contentOnly(norm: string): { core: string; map: number[] } {
  const map: number[] = [];
  let core = "";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i]!;
    if (/[0-9A-Za-z\u3400-\u9fff々〆〇∧∨¬→↔∀∃∈⊆⊂∪∩×·∅]/.test(ch)) {
      map.push(i);
      core += ch;
    }
  }
  return { core, map };
}

/** 最长连续公共子串 */
function longestCommonSubstring(
  a: string,
  b: string
): { ai: number; bi: number; len: number } {
  let best = { ai: 0, bi: 0, len: 0 };
  if (!a || !b) return best;
  let prev = new Array(b.length + 1).fill(0);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.len) {
          best = { ai: i - cur[j], bi: j - cur[j], len: cur[j] };
        }
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return best;
}

/**
 * 在规范化正文中模糊定位 context。
 * 策略：完整匹配 → 高比例子串 → 去标点匹配 → 最长公共子串 → 多锚点覆盖。
 */
function fuzzyLocateInNorm(
  nb: string,
  nc: string
): { ni: number; nlen: number } | null {
  if (!nc || nc.length < 4 || !nb) return null;

  let ni = nb.indexOf(nc);
  if (ni >= 0) return { ni, nlen: nc.length };

  // 1) context 连续子串（门槛降到约 40%）
  const minLen = Math.max(6, Math.floor(nc.length * 0.4));
  for (let len = nc.length - 1; len >= minLen; len--) {
    const mid = Math.max(0, Math.floor((nc.length - len) / 2));
    const candidates = [
      nc.slice(0, len),
      nc.slice(nc.length - len),
      nc.slice(mid, mid + len),
    ];
    for (const sub of candidates) {
      const j = nb.indexOf(sub);
      if (j >= 0) return { ni: j, nlen: len };
    }
    // 步长扫描，避免 O(n^2) 过重
    const step = Math.max(1, Math.floor(len / 8));
    for (let i0 = 1; i0 + len <= nc.length; i0 += step) {
      const j = nb.indexOf(nc.slice(i0, i0 + len));
      if (j >= 0) return { ni: j, nlen: len };
    }
  }

  // 2) 去标点后再匹配
  const { core: cb, map: cbMap } = contentOnly(nb);
  const { core: cc, map: ccMap } = contentOnly(nc);
  if (cc.length >= 4 && cb.length) {
    let ci = cb.indexOf(cc);
    let clen = cc.length;
    if (ci < 0) {
      const cMin = Math.max(6, Math.floor(cc.length * 0.4));
      outer: for (let len = cc.length - 1; len >= cMin; len--) {
        const step = Math.max(1, Math.floor(len / 6));
        for (let i0 = 0; i0 + len <= cc.length; i0 += step) {
          const j = cb.indexOf(cc.slice(i0, i0 + len));
          if (j >= 0) {
            ci = j;
            clen = len;
            break outer;
          }
        }
      }
    }
    if (ci >= 0 && clen > 0) {
      const nStart = cbMap[ci]!;
      const nEnd = cbMap[Math.min(ci + clen - 1, cbMap.length - 1)]!;
      return { ni: nStart, nlen: nEnd - nStart + 1 };
    }
  }

  // 3) 最长公共子串（容忍首尾改写）
  const lcs = longestCommonSubstring(nc, nb);
  const lcsMin = Math.max(8, Math.floor(nc.length * 0.35));
  if (lcs.len >= lcsMin) {
    return { ni: lcs.bi, nlen: lcs.len };
  }

  // 4) 多锚点：用 6 字窗口投票，取命中最密的正文区间
  const win = 6;
  if (nc.length >= win) {
    const hits: number[] = [];
    const step = Math.max(1, Math.floor(win / 2));
    for (let i = 0; i + win <= nc.length; i += step) {
      const g = nc.slice(i, i + win);
      if (!/[\u3400-\u9fff]/.test(g)) continue;
      let from = 0;
      while (from < nb.length) {
        const j = nb.indexOf(g, from);
        if (j < 0) break;
        hits.push(j);
        from = j + 1;
        if (hits.length > 400) break;
      }
      if (hits.length > 400) break;
    }
    if (hits.length) {
      hits.sort((a, b) => a - b);
      // 滑窗：在正文中找覆盖最多锚点、宽度约 nc.length 的区间
      const targetW = Math.max(win, Math.min(nb.length, Math.floor(nc.length * 1.2)));
      let bestCount = 0;
      let bestStart = hits[0]!;
      let left = 0;
      for (let right = 0; right < hits.length; right++) {
        while (hits[right]! - hits[left]! > targetW) left += 1;
        const cnt = right - left + 1;
        if (cnt > bestCount) {
          bestCount = cnt;
          bestStart = hits[left]!;
        }
      }
      const need = Math.max(2, Math.floor((nc.length / win) * 0.35));
      if (bestCount >= need) {
        return {
          ni: bestStart,
          nlen: Math.min(targetW, nb.length - bestStart),
        };
      }
    }
  }

  // 5) 再降门槛：任意 >=8 的公共子串
  if (lcs.len >= 8) return { ni: lcs.bi, nlen: lcs.len };
  return null;
}

/** 在正文中定位 context（支持标点/公式差异与改写模糊匹配） */
export function findContextSpan(
  body: string,
  context: string
): { start: number; end: number } | null {
  const ctx = (context || "").trim();
  if (!body || !ctx) return null;

  const exact = body.indexOf(ctx);
  if (exact >= 0) return { start: exact, end: exact + ctx.length };

  const { norm: nb, map } = normalizeForMatch(body);
  const { norm: nc } = normalizeForMatch(ctx);
  if (!nc || nc.length < 4 || !map.length) return null;

  const hit = fuzzyLocateInNorm(nb, nc);
  if (!hit) return null;
  return spanFromNorm(map, hit.ni, hit.nlen);
}

/** 边的原文依据：课堂增量 context / 修正依据 / 修正前依据 */
export function edgeEvidenceText(e: PipelineEdge): string {
  return (
    e.context ||
    e.basis_after ||
    e.correction_evidence ||
    e.basis_before ||
    ""
  ).trim();
}

/** 仅合并相同或真正重叠的区间；相邻但不重叠的保持分开 */
function mergeSpans(spans: SpanGroup[]): SpanGroup[] {
  if (!spans.length) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SpanGroup[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ ...s, triples: [...s.triples] });
      continue;
    }
    const identical = s.start === last.start && s.end === last.end;
    const overlapping = s.start < last.end;
    if (identical || overlapping) {
      last.end = Math.max(last.end, s.end);
      for (const t of s.triples) {
        if (!last.triples.some((x) => x.id === t.id)) last.triples.push(t);
      }
    } else {
      out.push({ ...s, triples: [...s.triples] });
    }
  }
  return out;
}

function buildSegments(body: string, edges: PipelineEdge[]): Seg[] {
  const spans: SpanGroup[] = [];
  for (const e of edges || []) {
    if (!e.id) continue;
    const quotes = [
      e.basis_before,
      e.basis_after,
      e.correction_evidence,
      e.context,
    ]
      .map((s) => (s || "").trim())
      .filter(Boolean);
    const seen = new Set<string>();
    for (const ctx of quotes) {
      if (seen.has(ctx)) continue;
      seen.add(ctx);
      const hit = findContextSpan(body, ctx);
      if (!hit) continue;
      spans.push({
        start: hit.start,
        end: hit.end,
        triples: [
          {
            id: e.id,
            from: e.from || "",
            to: e.to || "",
            pred: (e.relation || e.label || "").trim(),
            concrete: (e.concrete || e.concrete_relation || "").trim(),
            direction: (e.statement_direction || "").trim(),
          },
        ],
      });
    }
  }
  const merged = mergeSpans(spans);
  const segs: Seg[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) {
      segs.push({ kind: "text", value: body.slice(cursor, m.start) });
    }
    segs.push({
      kind: "ann",
      value: body.slice(m.start, m.end),
      triples: m.triples,
      key: `a-${m.start}-${m.end}`,
    });
    cursor = m.end;
  }
  if (cursor < body.length) segs.push({ kind: "text", value: body.slice(cursor) });
  return segs;
}

function formatTripleLine(t: SliceAnnTriple): string {
  const pred = t.pred || "related_with";
  const concrete = (t.concrete || "").trim();
  const s = t.from;
  const o = t.to;
  if (concrete) {
    const dir = t.direction || "subject_to_object";
    if (concrete.includes("...") || concrete.includes("…")) {
      if (dir === "object_to_subject") {
        return `${o}${concrete.replace(/\.\.\.|…/g, zh(s))}`;
      }
      return `${s}${concrete.replace(/\.\.\.|…/g, zh(o))}`;
    }
    if (dir === "object_to_subject") return `${o}${concrete}${s}`;
    return `${s}${concrete}${o}`;
  }
  if (isBidirectionalRelation(pred)) {
    return `${s} ${relationArrowText(pred, "undirected")} ${o}`;
  }
  return `${s} ${relationArrowText(pred, "out")} ${o}`;
}

function formatTripleShort(t: SliceAnnTriple): string {
  const pred = t.pred || "related_with";
  const concrete = (t.concrete || "").trim();
  const s = zh(t.from);
  const o = zh(t.to);
  if (concrete) {
    const dir = t.direction || "subject_to_object";
    if (concrete.includes("...") || concrete.includes("…")) {
      if (dir === "object_to_subject") {
        return `${o}${concrete.replace(/\.\.\.|…/g, s)}`;
      }
      return `${s}${concrete.replace(/\.\.\.|…/g, o)}`;
    }
    if (isBidirectionalRelation(pred)) return `${s} ${concrete} ${o}`;
    if (dir === "object_to_subject") return `${o} ${concrete} ${s}`;
    return `${s} ${concrete} ${o}`;
  }
  return `${s} ${relationArrowText(
    pred,
    isBidirectionalRelation(pred) ? "undirected" : "out"
  )} ${o}`;
}

/** 行内高亮，不改变正文排版；公式走 KaTeX */
function UnderlinedWords({ text }: { text: string }) {
  return (
    <span className={styles.uw}>
      <LatexText text={text} as="span" compact />
    </span>
  );
}

type Props = {
  text: string;
  edges: PipelineEdge[];
  selectedEdgeId?: string | null;
  /** 图谱聚焦中的边（划线多边高亮时用于正文 active 态） */
  focusEdgeIds?: string[] | null;
  /** id: 当前点选边；groupIds: 该高亮段关联的全部边 */
  onSelectEdge?: (id: string, groupIds?: string[]) => void;
  className?: string;
  /** 视觉主题：教材正文 / 对照旧稿 */
  tone?: "new" | "old";
};

export function SliceTextAnnotator({
  text,
  edges,
  selectedEdgeId,
  focusEdgeIds = null,
  onSelectEdge,
  className,
  tone = "new",
}: Props) {
  const segments = useMemo(() => buildSegments(text || "", edges || []), [text, edges]);
  const [tip, setTip] = useState<HoverTip | null>(null);
  const hideTimer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 由图谱选中触发的浮层，保持显示直到换边/取消选中 */
  const pinnedRef = useRef(false);
  const selectedEdgeIdRef = useRef(selectedEdgeId);
  selectedEdgeIdRef.current = selectedEdgeId;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const matched = useMemo(
    () => segments.filter((s) => s.kind === "ann").length,
    [segments]
  );

  const clearHideTimer = () => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const tipFromEl = (
    key: string,
    triples: SliceAnnTriple[],
    el: HTMLElement,
    pinned: boolean
  ) => {
    clearHideTimer();
    pinnedRef.current = pinned;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const maxW = Math.min(420, window.innerWidth - pad * 2);
    let x = r.left;
    if (x + maxW > window.innerWidth - pad) {
      x = Math.max(pad, window.innerWidth - pad - maxW);
    }
    const below = r.bottom + 8;
    const placeAbove = below > window.innerHeight - 96;
    const caretX = Math.max(12, Math.min(maxW - 20, r.left + r.width / 2 - x - 5));
    const color = relColor(triples[0]?.pred || "");
    setTip({
      key,
      triples,
      x,
      y: placeAbove ? r.top - 8 : below,
      above: placeAbove,
      caretX,
      color,
    });
  };

  const revealSelectedTip = () => {
    const id = selectedEdgeIdRef.current;
    const root = rootRef.current;
    if (!id || !root) {
      setTip(null);
      pinnedRef.current = false;
      return;
    }
    const seg = segmentsRef.current.find(
      (s): s is Extract<Seg, { kind: "ann" }> =>
        s.kind === "ann" && s.triples.some((t) => t.id === id)
    );
    if (!seg) {
      setTip(null);
      pinnedRef.current = false;
      return;
    }
    const nodes = root.querySelectorAll<HTMLElement>("[data-edge-ids]");
    let target: HTMLElement | null = null;
    nodes.forEach((n) => {
      const ids = (n.getAttribute("data-edge-ids") || "").split(/\s+/).filter(Boolean);
      if (ids.includes(id)) target = n;
    });
    if (target) tipFromEl(seg.key, seg.triples, target, true);
  };

  const scheduleHide = () => {
    if (pinnedRef.current) return;
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => {
      // 离开后：若仍有选中边，回到该边的划线+关系浮层；否则关闭
      if (selectedEdgeIdRef.current) {
        revealSelectedTip();
      } else {
        setTip(null);
      }
    }, 140);
  };

  const showTip = (
    key: string,
    triples: SliceAnnTriple[],
    el: HTMLElement,
    pinned = false
  ) => {
    tipFromEl(key, triples, el, pinned);
  };

  useEffect(() => () => clearHideTimer(), []);

  useEffect(() => {
    pinnedRef.current = false;
    setTip(null);
  }, [text, edges, tone]);

  // 图谱/侧栏选中边后：滚到划线并同步弹出关系浮层（高亮+悬浮一体）
  useEffect(() => {
    if (!selectedEdgeId || !rootRef.current) {
      pinnedRef.current = false;
      setTip(null);
      return;
    }
    const id = selectedEdgeId;
    const seg = segments.find(
      (s): s is Extract<Seg, { kind: "ann" }> =>
        s.kind === "ann" && s.triples.some((t) => t.id === id)
    );
    if (!seg) return;

    let cancelled = false;
    let settleTimer: number | null = null;

    const reveal = (el: HTMLElement) => {
      if (cancelled) return;
      tipFromEl(seg.key, seg.triples, el, true);
    };

    const run = () => {
      const root = rootRef.current;
      if (!root || cancelled) return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-edge-ids]"));
      const target = nodes.find((n) => {
        const ids = (n.getAttribute("data-edge-ids") || "").split(/\s+/).filter(Boolean);
        return ids.includes(id);
      });
      if (!target) return;

      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

      const onScrollEnd = () => {
        reveal(target);
      };

      const scroller =
        (target.closest(`.${styles.root}`)?.parentElement as HTMLElement | null) ||
        (target.closest("[class*='sliceScroll'], [class*='compareBody']") as HTMLElement | null);

      if (scroller && "onscrollend" in window) {
        scroller.addEventListener("scrollend", onScrollEnd, { once: true });
      }
      settleTimer = window.setTimeout(() => {
        reveal(target);
      }, 420);
    };

    const t = window.setTimeout(run, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      if (settleTimer != null) window.clearTimeout(settleTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEdgeId, segments]);

  if (!text) return <p className={styles.empty}>（无正文）</p>;

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ${tone === "old" ? styles.toneOld : styles.toneNew} ${
        className || ""
      }`.trim()}
    >
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          return (
            <LatexText key={`t-${i}`} text={seg.value} as="span" compact />
          );
        }
        const active =
          seg.triples.some((t) => t.id === selectedEdgeId) ||
          seg.triples.some((t) => focusEdgeIds?.includes(t.id));
        const hot = tip?.key === seg.key;
        const color = relColor(seg.triples[0]?.pred || "");
        return (
          <span
            key={seg.key}
            className={`${styles.ann} ${active ? styles.annActive : ""} ${
              hot ? styles.annHot : ""
            }`}
            style={{ ["--ann-color" as string]: color }}
            data-edge-ids={seg.triples.map((t) => t.id).join(" ")}
            onMouseEnter={(ev) => showTip(seg.key, seg.triples, ev.currentTarget, false)}
            onMouseLeave={scheduleHide}
          >
            <span
              role="button"
              tabIndex={0}
              className={styles.annSrc}
              onClick={() => {
                const ids = seg.triples.map((t) => t.id);
                const prefer =
                  seg.triples.find((t) => t.id === selectedEdgeId) || seg.triples[0];
                if (prefer) onSelectEdge?.(prefer.id, ids);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  const ids = seg.triples.map((t) => t.id);
                  const prefer =
                    seg.triples.find((t) => t.id === selectedEdgeId) || seg.triples[0];
                  if (prefer) onSelectEdge?.(prefer.id, ids);
                }
              }}
            >
              <UnderlinedWords text={seg.value} />
            </span>
          </span>
        );
      })}

      {tip &&
        createPortal(
          <div
            className={`${styles.annLabels} ${
              tip.above ? styles.annLabelsAbove : styles.annLabelsBelow
            }`}
            style={{
              left: tip.x,
              top: tip.y,
              ["--ann-color" as string]: tip.color || undefined,
              ["--caret-x" as string]: `${tip.caretX ?? 16}px`,
            }}
            onMouseEnter={() => {
              clearHideTimer();
              // 停在浮层上时保持对应划线高亮
              pinnedRef.current = true;
            }}
            onMouseLeave={() => {
              pinnedRef.current = false;
              scheduleHide();
            }}
          >
            <div className={styles.annLabelsHead}>
              <i className={styles.annLabelsHeadMark} aria-hidden />
              <span>划线依据 · 关系</span>
            </div>
            {tip.triples.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`${styles.annLabel} ${
                  selectedEdgeId === t.id ? styles.annLabelOn : ""
                }`}
                style={{ color: relColor(t.pred) }}
                title={formatTripleLine(t)}
                onClick={() => onSelectEdge?.(t.id, [t.id])}
              >
                <LatexText text={formatTripleShort(t)} as="span" compact />
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
