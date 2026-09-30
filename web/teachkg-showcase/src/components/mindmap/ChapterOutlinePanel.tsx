import { useEffect, useState } from "react";
import { withBase } from "@/lib/withBase";
import pipe from "@/pages/PipelinePage.module.css";

type OutlineDoc = {
  courseId?: string;
  chapter?: string;
  source?: string | null;
  outline_text?: string;
  outline?: string[];
  empty?: boolean;
  llm_notes?: string;
  raw_draft?: string;
  incremental?: boolean;
};

export function ChapterOutlinePanel({
  courseId,
  chapter,
  onApplied,
}: {
  courseId: string;
  chapter: string;
  /** 保存后回调：用新大纲重建导图 */
  onApplied?: (outlineText: string, meta: OutlineDoc) => void | Promise<void>;
}) {
  /** 磁盘已存大纲（仅作增量合并底稿，不展示） */
  const [baseline, setBaseline] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!courseId || !chapter) return;
    let cancelled = false;
    setStatus(null);
    setText("");
    const q = new URLSearchParams({ courseId, chapter });
    fetch(withBase(`/api/mindmap-outline?${q}`), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: OutlineDoc | null) => {
        if (cancelled || !d) return;
        const saved =
          d.outline_text || (d.outline || []).join("\n") || "";
        setBaseline(saved);
        setSource(d.source || null);
      })
      .catch(() => {
        if (!cancelled) setStatus("加载大纲失败");
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, chapter]);

  const hasBaseline = Boolean(baseline.trim());

  const postOutline = async (opts: {
    normalize: boolean;
    apply: boolean;
    /** true=与已有大纲增量合并；false=仅用输入框覆盖 */
    incremental: boolean;
  }) => {
    setBusy(true);
    setStatus(null);
    try {
      const useIncremental =
        opts.normalize && opts.incremental && hasBaseline;
      if (opts.normalize) {
        setStatus(
          useIncremental
            ? "正在增量合并到已有大纲…"
            : "正在覆盖整理大纲…"
        );
      } else {
        setStatus("正在覆盖保存…");
      }
      const r = await fetch(withBase("/api/mindmap-outline"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          chapter,
          outline_text: text,
          normalize: opts.normalize,
          incremental: useIncremental,
          existing_outline: useIncremental ? baseline : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "保存失败");
      const nextText = String(d.outline_text || text);
      setBaseline(nextText);
      setSource(d.source || (opts.normalize ? "manual_llm" : "manual"));
      if (useIncremental) {
        setText("");
      } else {
        setText(nextText);
      }
      if (d.llm_notes) {
        setStatus(
          d.incremental
            ? `增量合并完成：${d.llm_notes}`
            : `覆盖整理完成：${d.llm_notes}`
        );
      } else {
        setStatus(opts.apply ? "已保存，正在更新导图…" : "大纲已保存");
      }
      if (opts.apply && onApplied) {
        await onApplied(nextText, d);
        setStatus(
          d.llm_notes
            ? `导图已更新并写入磁盘（${d.llm_notes}）`
            : "导图已按大纲更新并写入磁盘"
        );
      }
    } catch (e) {
      setStatus(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={pipe.detailCard}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        placeholder={
          hasBaseline
            ? "增量：只写本次补充内容\n覆盖整理：写完整草稿（AI 整理后替换已有）\n\n例：\n还讲了邻接矩阵…\n或：\n图的表示\n  邻接矩阵\n  关联矩阵"
            : "例：今天讲了命题、联结词，还有合式公式和真值表…\n\n或：\n命题\n  原子命题\n联结词\n合式公式"
        }
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.45,
          padding: 8,
          borderRadius: 6,
          border: "1px solid rgba(0,0,0,0.12)",
          resize: "vertical",
          background: "rgba(255,255,255,0.75)",
        }}
      />
      <div className={pipe.cueList} style={{ marginTop: 10 }}>
        {hasBaseline ? (
          <>
            <button
              type="button"
              className={pipe.cueBtn}
              disabled={busy || !text.trim()}
              onClick={() =>
                postOutline({
                  normalize: true,
                  apply: true,
                  incremental: true,
                })
              }
            >
              AI 增量合并并更新
            </button>
            <button
              type="button"
              className={pipe.cueBtn}
              disabled={busy || !text.trim()}
              onClick={() =>
                postOutline({
                  normalize: true,
                  apply: false,
                  incremental: true,
                })
              }
            >
              仅增量整理
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={pipe.cueBtn}
          disabled={busy || !text.trim()}
          onClick={() =>
            postOutline({
              normalize: true,
              apply: true,
              incremental: false,
            })
          }
        >
          AI 覆盖整理并更新
        </button>
        <button
          type="button"
          className={pipe.cueBtn}
          disabled={busy || !text.trim()}
          onClick={() =>
            postOutline({
              normalize: true,
              apply: false,
              incremental: false,
            })
          }
        >
          仅覆盖整理
        </button>
      </div>
      {status ? (
        <p className={pipe.sideEmpty} style={{ paddingTop: 8 }}>
          {status}
        </p>
      ) : null}
    </div>
  );
}
