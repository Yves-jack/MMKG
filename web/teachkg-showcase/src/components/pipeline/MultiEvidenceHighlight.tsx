import { useEffect, useMemo, useRef } from "react";
import { LatexText } from "./LatexText";
import { locateQuoteInText } from "@/lib/pipeline/textLocate";
import styles from "./MultiEvidenceHighlight.module.css";

export type EvidenceMark = {
  id: string;
  quote: string;
  /** principle | theorem | technique */
  kind?: string;
  label?: string;
};

type Span = {
  start: number;
  end: number;
  id: string;
  kind: string;
  active: boolean;
};

type Seg = {
  text: string;
  marks: { id: string; kind: string; active: boolean }[];
};

function locateAll(text: string, marks: EvidenceMark[]): Span[] {
  const out: Span[] = [];
  for (const m of marks) {
    const q = (m.quote || "").trim();
    if (!q) continue;
    const hit = locateQuoteInText(text, q);
    if (!hit) continue;
    out.push({
      start: hit.start,
      end: hit.end,
      id: m.id,
      kind: String(m.kind || "evidence"),
      active: false,
    });
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

function buildSegments(text: string, spans: Span[]): Seg[] {
  if (!text) return [];
  if (!spans.length) return [{ text, marks: [] }];

  const points = new Set<number>([0, text.length]);
  for (const s of spans) {
    points.add(s.start);
    points.add(s.end);
  }
  const cuts = [...points].sort((a, b) => a - b);
  const segs: Seg[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    if (b <= a) continue;
    const mid = (a + b) / 2;
    const marks = spans
      .filter((s) => s.start <= mid && mid < s.end)
      .map((s) => ({ id: s.id, kind: s.kind, active: s.active }));
    // 去重 id
    const seen = new Set<string>();
    const uniq = marks.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    segs.push({ text: text.slice(a, b), marks: uniq });
  }
  return segs.filter((s) => s.text);
}

const KIND_CLASS: Record<string, string> = {
  principle: styles.hlPrinciple,
  theorem: styles.hlTheorem,
  technique: styles.hlTechnique,
  evidence: styles.hlEvidence,
};

export function MultiEvidenceHighlight({
  text,
  marks,
  activeId = null,
  onSelectMark,
}: {
  text: string;
  marks: EvidenceMark[];
  activeId?: string | null;
  onSelectMark?: (id: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const spans = useMemo(() => {
    const located = locateAll(text || "", marks);
    return located.map((s) => ({
      ...s,
      active: Boolean(activeId && s.id === activeId),
    }));
  }, [text, marks, activeId]);

  const segs = useMemo(() => buildSegments(text || "", spans), [text, spans]);

  const foundIds = useMemo(() => new Set(spans.map((s) => s.id)), [spans]);
  const missCount = marks.filter((m) => (m.quote || "").trim() && !foundIds.has(m.id)).length;

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !activeId) return;
    const el =
      root.querySelector<HTMLElement>("[data-hl-active]") ||
      [...root.querySelectorAll<HTMLElement>("[data-mark-id]")].find(
        (node) => node.dataset.markId === activeId
      );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }, [activeId, text, marks]);

  return (
    <div className={styles.root}>
      <div className={styles.legend}>
        <span className={styles.legPrinciple}>原理</span>
        <span className={styles.legTheorem}>定理</span>
        <span className={styles.legTechnique}>方法</span>
        {missCount > 0 ? (
          <span className={styles.legMiss}>{missCount} 条依据未在合并文本中定位</span>
        ) : null}
      </div>
      <div className={styles.body} ref={bodyRef}>
        <div className={styles.bodyInner}>
          {segs.map((seg, i) => {
            if (!seg.marks.length) {
              return (
                <LatexText key={i} text={seg.text} as="span" compact />
              );
            }
            const primary =
              seg.marks.find((m) => m.active) ||
              seg.marks.find((m) => m.kind === "principle") ||
              seg.marks[0]!;
            const cls = [
              KIND_CLASS[primary.kind] || styles.hlEvidence,
              primary.active ? styles.hlActive : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <mark
                key={i}
                className={cls}
                data-hl=""
                data-hl-active={primary.active ? "" : undefined}
                data-mark-id={primary.id}
                title={seg.marks.map((m) => m.id).join(", ")}
                onClick={() => onSelectMark?.(primary.id)}
              >
                <LatexText text={seg.text} as="span" compact />
              </mark>
            );
          })}
        </div>
      </div>
    </div>
  );
}
