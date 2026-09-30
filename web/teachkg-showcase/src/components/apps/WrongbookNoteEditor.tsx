import { useEffect, useRef, useState } from "react";
import { NoteRichPreview } from "@/components/apps/NoteRichPreview";
import styles from "./WrongbookNoteEditor.module.css";

type Props = {
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  placeholder?: string;
};

async function fileToCompressedDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const maxW = 1280;
  const scale = Math.min(1, maxW / Math.max(bitmap.width, 1));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  // jpeg 更省；保留 png 透明
  const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
  return canvas.toDataURL(mime, mime === "image/jpeg" ? 0.82 : undefined);
}

function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
  fallback = "文本"
) {
  const selected = value.slice(start, end) || fallback;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  const cursor = start + before.length + selected.length + after.length;
  return { next, cursor, selStart: start + before.length, selEnd: start + before.length + selected.length };
}

/** 类飞书：编辑 + 实时预览，支持公式与插图 */
export function WrongbookNoteEditor({
  value,
  onChange,
  hint,
  placeholder = "写下易错点；可用 $公式$ 或工具栏插入图片…",
}: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<"split" | "edit" | "preview">("split");
  const [busyImg, setBusyImg] = useState(false);

  useEffect(() => {
    // 窄屏默认编辑，宽屏保持分栏（由 CSS 控制）；这里不强制改 tab
  }, []);

  const applyWrap = (before: string, after: string, fallback?: string) => {
    const el = taRef.current;
    if (!el) {
      onChange(`${value}${before}${fallback || ""}${after}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const { next, selStart, selEnd } = wrapSelection(value, start, end, before, after, fallback);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  };

  const insertAtCursor = (snippet: string, selectInside?: { from: number; to: number }) => {
    const el = taRef.current;
    if (!el) {
      onChange(`${value}${value && !value.endsWith("\n") ? "\n" : ""}${snippet}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const pad =
      start > 0 && value[start - 1] !== "\n" && !snippet.startsWith("\n") ? "\n" : "";
    const next = value.slice(0, start) + pad + snippet + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      if (selectInside) {
        const base = start + pad.length;
        el.setSelectionRange(base + selectInside.from, base + selectInside.to);
      } else {
        const pos = start + pad.length + snippet.length;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const onPickImage = async (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    setBusyImg(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      const alt = file.name.replace(/\.[^.]+$/, "") || "图片";
      insertAtCursor(`![${alt}](${dataUrl})\n`);
    } catch {
      /* ignore */
    } finally {
      setBusyImg(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        e.preventDefault();
        const file = it.getAsFile();
        await onPickImage(file);
        return;
      }
    }
  };

  const onDrop = async (e: React.DragEvent<HTMLTextAreaElement>) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) {
      e.preventDefault();
      await onPickImage(file);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.toolGroup}>
          <button type="button" className={styles.tool} title="加粗" onClick={() => applyWrap("**", "**", "加粗")}>
            B
          </button>
          <button type="button" className={styles.tool} title="斜体" onClick={() => applyWrap("*", "*", "斜体")}>
            I
          </button>
          <button
            type="button"
            className={styles.tool}
            title="标题"
            onClick={() => insertAtCursor("## 标题\n", { from: 3, to: 5 })}
          >
            H
          </button>
          <button
            type="button"
            className={styles.tool}
            title="列表"
            onClick={() => insertAtCursor("- 要点\n", { from: 2, to: 4 })}
          >
            ≡
          </button>
          <button
            type="button"
            className={styles.tool}
            title="引用"
            onClick={() => insertAtCursor("> 摘录\n", { from: 2, to: 4 })}
          >
            “
          </button>
        </div>
        <div className={styles.toolGroup}>
          <button
            type="button"
            className={styles.tool}
            title="行内公式 $...$"
            onClick={() => applyWrap("$", "$", "x^2")}
          >
            $ƒ$
          </button>
          <button
            type="button"
            className={styles.tool}
            title="独立公式 $$...$$"
            onClick={() => insertAtCursor("\n$$\n\\sum_{i=1}^{n} i\n$$\n", { from: 4, to: 20 })}
          >
            $$
          </button>
          <button
            type="button"
            className={styles.tool}
            title="插入图片（也可粘贴 / 拖入）"
            disabled={busyImg}
            onClick={() => fileRef.current?.click()}
          >
            {busyImg ? "…" : "图"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => void onPickImage(e.target.files?.[0] || null)}
          />
        </div>
        <div className={styles.viewTabs}>
          <button
            type="button"
            className={tab === "edit" ? styles.tabOn : styles.tab}
            onClick={() => setTab("edit")}
          >
            编辑
          </button>
          <button
            type="button"
            className={tab === "split" ? styles.tabOn : styles.tab}
            onClick={() => setTab("split")}
          >
            双栏
          </button>
          <button
            type="button"
            className={tab === "preview" ? styles.tabOn : styles.tab}
            onClick={() => setTab("preview")}
          >
            预览
          </button>
        </div>
      </div>

      <div
        className={
          tab === "split" ? styles.panes : tab === "preview" ? styles.panePreviewOnly : styles.paneEditOnly
        }
      >
        {tab !== "preview" ? (
          <textarea
            ref={taRef}
            className={styles.editor}
            rows={7}
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={(e) => void onPaste(e)}
            onDrop={(e) => void onDrop(e)}
            onDragOver={(e) => {
              if ([...e.dataTransfer.items].some((x) => x.kind === "file")) e.preventDefault();
            }}
            spellCheck={false}
          />
        ) : null}
        {tab !== "edit" ? (
          <div className={styles.previewPane} aria-label="笔记实时预览">
            <p className={styles.previewLabel}>实时预览</p>
            <NoteRichPreview text={value} emptyHint="输入后这里会即时渲染公式与图片" />
          </div>
        ) : null}
      </div>

      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </div>
  );
}
