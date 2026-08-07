import { useState } from "react";
import type { PipelineStage } from "../../lib/pipeline/types";
import { LatexText } from "./LatexText";
import { ResizableSplit } from "./ResizableSplit";
import styles from "./AsrTextCompare.module.css";

type DiffSpan = { kind: string; text: string };

function renderSpans(
  spans: DiffSpan[] | undefined,
  fallback: string,
  titles?: { add?: string; change?: string }
) {
  if (spans && spans.length > 0) {
    return spans.map((sp, i) => {
      const kind = sp.kind === "add" || sp.kind === "change" ? sp.kind : "same";
      if (kind === "same") {
        return <LatexText key={i} text={sp.text} as="span" className={styles.inlineTex} />;
      }
      return (
        <mark
          key={i}
          className={kind === "add" ? styles.add : styles.change}
          title={
            kind === "add"
              ? titles?.add || "补充"
              : titles?.change || "修正"
          }
        >
          <LatexText text={sp.text} as="span" className={styles.inlineTex} />
        </mark>
      );
    });
  }
  return <LatexText text={fallback} as="span" className={styles.inlineTex} />;
}

export function AsrTextCompare({ stage }: { stage: PipelineStage }) {
  const mode = stage.compare_mode || (stage.id === "preprocess" ? "preprocess" : "asr");
  const isPreprocess = mode === "preprocess";
  const [showLeft, setShowLeft] = useState(isPreprocess);

  const leftText = stage.raw_text || (isPreprocess ? stage.text : "") || "";
  const rightText = stage.corrected_text || stage.text || "";
  const spans = stage.corrected_spans;

  const leftLabel = isPreprocess ? "预处理前" : "原始 ASR";
  const rightLabel = isPreprocess ? "预处理后" : "PPT 校对后";
  const toggleShow = isPreprocess ? "显示预处理前" : "显示原始 ASR";
  const toggleHide = isPreprocess ? "隐藏预处理前" : "隐藏原始 ASR";

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={`${styles.toggle} ${showLeft ? styles.toggleOn : ""}`}
          onClick={() => setShowLeft((v) => !v)}
          aria-pressed={showLeft}
        >
          {showLeft ? toggleHide : toggleShow}
        </button>
        {isPreprocess ? (
          <span className={styles.hint}>
            {showLeft ? "左：校对后口述 · 右：清洗后可抽取文本" : "仅显示预处理结果"}
          </span>
        ) : showLeft ? (
          <div className={styles.legend}>
            <span className={styles.legItem}>
              <i className={styles.legChange} /> 修正 · ASR 术语听错
            </span>
            <span className={styles.legItem}>
              <i className={styles.legAdd} /> 补充 · PPT 独有（口述未讲）
            </span>
          </div>
        ) : (
          <span className={styles.hint}>已隐藏原文与校对高亮</span>
        )}
      </div>
      <ResizableSplit
        className={styles.cols}
        storageKey={`split-asr-${mode}-v2`}
        initialLeftRatio={0.5}
        minLeftPx={200}
        minRightPx={200}
        enabled={showLeft}
        leftClassName={styles.col}
        rightClassName={styles.col}
        left={
          <>
            <header className={styles.head}>
              <strong>{leftLabel}</strong>
              <span>{leftText.length} 字</span>
            </header>
            <LatexText text={leftText || "（无）"} className={styles.body} />
          </>
        }
        right={
          <>
            <header className={styles.head}>
              <strong>{rightLabel}</strong>
              <span>{rightText.length} 字</span>
            </header>
            <div className={styles.body}>
              {!isPreprocess && showLeft
                ? renderSpans(spans, rightText || "（无）", {
                    add: "补充：口述未讲，来自 PPT",
                    change: "修正：ASR 术语识别错误",
                  })
                : (
                  <LatexText
                    text={rightText || "（无）"}
                    as="span"
                    className={styles.inlineTex}
                  />
                )}
            </div>
          </>
        }
      />
    </div>
  );
}
