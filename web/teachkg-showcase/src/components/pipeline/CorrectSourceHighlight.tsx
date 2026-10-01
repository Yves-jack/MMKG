import { useEffect, useMemo, useRef } from "react";
import { LatexText } from "./LatexText";
import { locateQuoteInText, quotesEqual } from "@/lib/pipeline/textLocate";
import styles from "./CorrectTextGraph.module.css";

export type HlRole = "before" | "after" | "both" | "evidence";

type Seg = { text: string; role: HlRole | null };

function buildSegments(
  text: string,
  beforeQuote: string,
  afterQuote: string
): { segs: Seg[]; foundBefore: boolean; foundAfter: boolean; same: boolean } {
  const same = quotesEqual(beforeQuote, afterQuote);
  let beforeHit = beforeQuote ? locateQuoteInText(text, beforeQuote) : null;
  let afterHit = afterQuote ? locateQuoteInText(text, afterQuote) : null;

  if (same && beforeHit && !afterHit) afterHit = beforeHit;
  if (same && afterHit && !beforeHit) beforeHit = afterHit;

  if (same && beforeHit) {
    const segs: Seg[] = [
      { text: text.slice(0, beforeHit.start), role: null },
      { text: text.slice(beforeHit.start, beforeHit.end), role: "both" },
      { text: text.slice(beforeHit.end), role: null },
    ];
    return {
      segs: segs.filter((s) => s.text),
      foundBefore: true,
      foundAfter: true,
      same: true,
    };
  }

  if (!beforeHit && !afterHit) {
    return {
      segs: [{ text, role: null }],
      foundBefore: false,
      foundAfter: false,
      same,
    };
  }

  type Ev = { at: number; kind: "start" | "end"; role: "before" | "after" };
  const evs: Ev[] = [];
  if (beforeHit) {
    evs.push({ at: beforeHit.start, kind: "start", role: "before" });
    evs.push({ at: beforeHit.end, kind: "end", role: "before" });
  }
  if (afterHit) {
    evs.push({ at: afterHit.start, kind: "start", role: "after" });
    evs.push({ at: afterHit.end, kind: "end", role: "after" });
  }
  evs.sort((a, b) => a.at - b.at || (a.kind === "end" ? -1 : 1));

  const segs: Seg[] = [];
  let cursor = 0;
  let b = 0;
  let a = 0;
  const curRole = (): HlRole | null => {
    if (b > 0 && a > 0) return "both";
    if (b > 0) return "before";
    if (a > 0) return "after";
    return null;
  };

  for (const e of evs) {
    if (e.at > cursor) {
      segs.push({ text: text.slice(cursor, e.at), role: curRole() });
    }
    cursor = e.at;
    if (e.role === "before") b += e.kind === "start" ? 1 : -1;
    else a += e.kind === "start" ? 1 : -1;
  }
  if (cursor < text.length) {
    segs.push({ text: text.slice(cursor), role: curRole() });
  }

  return {
    segs: segs.filter((s) => s.text),
    foundBefore: !!beforeHit,
    foundAfter: !!afterHit,
    same,
  };
}

function buildEvidenceSegments(
  text: string,
  quote: string
): { segs: Seg[]; found: boolean } {
  const hit = quote ? locateQuoteInText(text, quote) : null;
  if (!hit) {
    return { segs: [{ text, role: null }], found: false };
  }
  const segs: Seg[] = [
    { text: text.slice(0, hit.start), role: null },
    { text: text.slice(hit.start, hit.end), role: "evidence" },
    { text: text.slice(hit.end), role: null },
  ];
  return {
    segs: segs.filter((s) => s.text),
    found: true,
  };
}

const ROLE_CLASS: Record<HlRole, string> = {
  before: styles.hlBefore,
  after: styles.hlAfter,
  both: styles.hlBoth,
  evidence: styles.hlEvidence,
};

export function CorrectSourceHighlight({
  text,
  beforeQuote,
  afterQuote,
  /** 单段依据高亮（课堂增量边等） */
  mode = "correct",
  evidenceLabel = "原文依据",
}: {
  text: string;
  beforeQuote?: string | null;
  afterQuote?: string | null;
  mode?: "correct" | "evidence";
  evidenceLabel?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const before = (beforeQuote || "").trim();
  const after = (afterQuote || "").trim();
  const evidence = mode === "evidence" ? after || before : "";

  const correctBuilt = useMemo(
    () =>
      mode === "correct"
        ? buildSegments(text || "", before, after)
        : { segs: [] as Seg[], foundBefore: false, foundAfter: false, same: false },
    [mode, text, before, after]
  );

  const evidenceBuilt = useMemo(
    () =>
      mode === "evidence"
        ? buildEvidenceSegments(text || "", evidence)
        : { segs: [] as Seg[], found: false },
    [mode, text, evidence]
  );

  const segs = mode === "evidence" ? evidenceBuilt.segs : correctBuilt.segs;
  const foundBefore = correctBuilt.foundBefore;
  const foundAfter = mode === "evidence" ? evidenceBuilt.found : correctBuilt.foundAfter;
  const same = correctBuilt.same;

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>("[data-hl]");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }, [before, after, evidence, text, mode]);

  if (!text) {
    return <p className={styles.empty}>（无原文）</p>;
  }

  const active = mode === "evidence" ? !!evidence : !!(before || after);

  return (
    <div className={styles.hlRoot}>
      {active && mode === "correct" ? (
        <div className={styles.hlLegend} aria-hidden>
          <span className={styles.legBefore}>修正前依据</span>
          <span className={styles.legAfter}>修正依据</span>
          <span className={styles.legBoth}>二者相同</span>
          {same && foundBefore ? (
            <span className={styles.legHint}>原文相同，紫色标出</span>
          ) : null}
        </div>
      ) : null}
      {active && mode === "evidence" ? (
        <div className={styles.hlLegend} aria-hidden>
          <span className={styles.legEvidence}>{evidenceLabel}</span>
          {!foundAfter ? (
            <span className={styles.legHint}>未在原文定位时显示摘录卡片</span>
          ) : null}
        </div>
      ) : null}
      {mode === "correct" && active && before && !foundBefore ? (
        <div className={`${styles.quoteChip} ${styles.quoteBefore}`}>
          <span className={styles.quoteTag}>修正前依据</span>
          <LatexText text={before} as="span" />
        </div>
      ) : null}
      {mode === "correct" && active && after && !foundAfter ? (
        <div className={`${styles.quoteChip} ${styles.quoteAfter}`}>
          <span className={styles.quoteTag}>修正依据</span>
          <LatexText text={after} as="span" />
        </div>
      ) : null}
      {mode === "evidence" && active && evidence && !foundAfter ? (
        <div className={`${styles.quoteChip} ${styles.quoteEvidence}`}>
          <span className={styles.quoteTag}>{evidenceLabel}</span>
          <LatexText text={evidence} as="span" />
        </div>
      ) : null}
      <div ref={bodyRef} className={`${styles.textBodyInner} text-panel`}>
        {segs.map((seg, i) => {
          if (!seg.role) {
            return <LatexText key={i} text={seg.text} as="span" />;
          }
          return (
            <mark key={i} data-hl={seg.role} className={ROLE_CLASS[seg.role]}>
              <LatexText text={seg.text} as="span" />
            </mark>
          );
        })}
      </div>
    </div>
  );
}
