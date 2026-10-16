import { useEffect, useState } from "react";
import { withBase } from "@/lib/withBase";
import pipe from "@/styles/panels.module.css";

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
  chapters?: Array<{ title?: string; sections?: unknown }>;
  course_skeleton?: boolean;
  text_first?: boolean;
  restored?: boolean;
  mindmap?: unknown;
};

export function ChapterOutlinePanel({
  courseId,
  chapter,
  onApplied,
  onRestored,
  mode = "chapter",
  buildMode = "text_first",
}: {
  courseId: string;
  chapter: string;
  /** 保存后回调：用新大纲重建导图 */
  onApplied?: (outlineText: string, meta: OutlineDoc) => void | Promise<void>;
  /** 从 mindmaps_kg_v1 还原本章后回调 */
  onRestored?: (mindmap: unknown) => void | Promise<void>;
  /** course_skeleton：整课章→节层级，不含细概念 */
  mode?: "chapter" | "course_skeleton";
  /**
   * text_first：从外源文本建概念树（默认，解除 KG 身份硬限制）
   * legacy：旧骨架+只挂 KG 叶
   */
  buildMode?: "text_first" | "legacy";
}) {
  const isCourseSkeleton = mode === "course_skeleton";
  const textFirst = buildMode === "text_first" && !isCourseSkeleton;
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
            ? textFirst
              ? "文本优先：正在增量合并…"
              : "正在增量合并到已有大纲…"
            : textFirst
              ? "文本优先：正在抽取概念树…"
              : "正在覆盖整理大纲…"
        );
      } else {
        setStatus("正在覆盖保存…");
      }
      let d: OutlineDoc & {
        error?: string;
        code?: string;
        outline_text?: string;
        source?: string | null;
        llm_notes?: string;
        incremental?: boolean;
      };
      let usedNormalize = opts.normalize;
      {
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
            course_skeleton: isCourseSkeleton,
            mode: textFirst ? "text_first" : undefined,
            text_first: textFirst || undefined,
          }),
        });
        d = await r.json().catch(() => ({}));
        // AI 不可用时：覆盖路径回退为原文直接建图，避免「点了没反应」
        if (
          !r.ok &&
          opts.normalize &&
          opts.apply &&
          !useIncremental &&
          (d?.code === "NO_LLM_KEY" || r.status === 503)
        ) {
          setStatus("AI 不可用，改用原文覆盖建图…");
          const r2 = await fetch(withBase("/api/mindmap-outline"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              courseId,
              chapter,
              outline_text: text,
              normalize: false,
              incremental: false,
              course_skeleton: isCourseSkeleton,
            }),
          });
          d = await r2.json().catch(() => ({}));
          if (!r2.ok) throw new Error(d?.error || "保存失败");
          usedNormalize = false;
        } else if (!r.ok) {
          throw new Error(d?.error || "保存失败");
        }
      }
      const nextText = String(d.outline_text || text);
      setBaseline(nextText);
      setSource(
        d.source || (usedNormalize ? "manual_llm" : "manual")
      );
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
        await onApplied(nextText, { ...d, text_first: textFirst });
        setStatus(
          d.llm_notes
            ? `导图已更新并写入磁盘（${d.llm_notes}）`
            : usedNormalize
              ? "导图已按大纲更新并写入磁盘"
              : "导图已按原文覆盖并写入磁盘"
        );
      }
    } catch (e) {
      setStatus(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const restoreFromBackup = async () => {
    setBusy(true);
    setStatus("正在从 mindmaps_kg_v1 还原本章…");
    try {
      const r = await fetch(withBase("/api/mindmap-outline"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          chapter,
          restore_from_backup: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "还原失败");
      if (onRestored) await onRestored(d.mindmap);
      setStatus("已从备份还原本章导图");
    } catch (e) {
      setStatus(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={pipe.detailCard}>
      {textFirst ? (
        <p className={pipe.sideEmpty} style={{ paddingBottom: 8, margin: 0 }}>
          文本优先模式 · 旧图已备份 mindmaps_kg_v1
          {source ? ` · 源 ${source}` : ""}
        </p>
      ) : null}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={
          textFirst
            ? "粘贴教材/讲义摘录或概念列表，AI 抽取后直接建章树…"
            : ""
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
        {!isCourseSkeleton ? (
          <button
            type="button"
            className={pipe.cueBtn}
            disabled={busy}
            onClick={() => void restoreFromBackup()}
            title="从 mindmaps_kg_v1 写回本章"
          >
            从备份还原本章
          </button>
        ) : null}
      </div>
      {status ? (
        <p className={pipe.sideEmpty} style={{ paddingTop: 8 }}>
          {status}
        </p>
      ) : null}
    </div>
  );
}
