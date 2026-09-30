import type { PipelineStage } from "../../lib/pipeline/types";
import { LatexText } from "./LatexText";
import { ResizableSplit } from "./ResizableSplit";
import styles from "./KnowledgePointPanel.module.css";

function highlightSpans(text: string, points: string[]): { kind: "same" | "kp"; text: string }[] {
  if (!text || !points.length) return [{ kind: "same", text: text || "" }];
  const aliases = [...points]
    .map((p) => p.trim())
    .filter((p) => p.length >= 2)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const spans: { kind: "same" | "kp"; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    let hit: { start: number; end: number } | null = null;
    for (const a of aliases) {
      const idx = text.indexOf(a, i);
      if (idx !== i) continue;
      hit = { start: idx, end: idx + a.length };
      break;
    }
    if (!hit) {
      let next = text.length;
      for (const a of aliases) {
        const idx = text.indexOf(a, i + 1);
        if (idx >= 0 && idx < next) next = idx;
      }
      spans.push({ kind: "same", text: text.slice(i, next) });
      i = next;
      continue;
    }
    spans.push({ kind: "kp", text: text.slice(hit.start, hit.end) });
    i = hit.end;
  }
  return spans;
}

export function KnowledgePointPanel({ stage }: { stage: PipelineStage }) {
  const text = String(stage.text || "");
  const points = (stage.knowledge_points || [])
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  const spans = highlightSpans(text, points);

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.legend}>
          <span className={styles.legItem}>
            <i className={styles.legKp} />
            知识点命中
          </span>
        </div>
        <span className={styles.count}>共 {points.length} 个知识点</span>
      </div>
      <ResizableSplit
        className={styles.cols}
        storageKey="split-kp-text-list-v1"
        initialLeftRatio={0.55}
        minLeftPx={220}
        minRightPx={200}
        leftClassName={styles.col}
        rightClassName={styles.col}
        left={
          <>
            <header className={styles.head}>
              <strong>课堂文本</strong>
              <span>{text.length} 字</span>
            </header>
            <div className={styles.body}>
              {spans.map((sp, i) =>
                sp.kind === "same" ? (
                  <LatexText key={i} text={sp.text} as="span" className={styles.inlineTex} />
                ) : (
                  <mark key={i} className={styles.hlKp}>
                    <LatexText text={sp.text} as="span" className={styles.inlineTex} />
                  </mark>
                )
              )}
            </div>
          </>
        }
        right={
          <>
            <header className={styles.head}>
              <strong>知识点列表</strong>
              <span>{points.length} 个</span>
            </header>
            <div className={styles.list}>
              {points.length === 0 ? (
                <div className={styles.empty}>
                  （暂无知识点：需重跑 Stage1 子图抽取以生成）
                </div>
              ) : (
                points.map((p, i) => (
                  <div key={`${i}:${p}`} className={styles.chip} title={p}>
                    <span className={styles.chipIdx}>{i + 1}</span>
                    <span className={styles.chipLabel}>{p}</span>
                  </div>
                ))
              )}
            </div>
          </>
        }
      />
    </div>
  );
}
