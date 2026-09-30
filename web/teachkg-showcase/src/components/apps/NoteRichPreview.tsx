import { Fragment, useMemo } from "react";
import { LatexText } from "@/components/pipeline/LatexText";
import styles from "./NoteRichPreview.module.css";

type Inline =
  | { kind: "text"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "code"; value: string };

type Block =
  | { kind: "p"; inlines: Inline[] }
  | { kind: "h"; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: "li"; inlines: Inline[] }
  | { kind: "img"; alt: string; src: string }
  | { kind: "hr" }
  | { kind: "quote"; inlines: Inline[] };

const IMG_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+_-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)]+|wbimg:[^)\s]+)\)/;
const INLINE_RE =
  /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;

function splitInlines(raw: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.push({ kind: "text", value: raw.slice(last, m.index) });
    if (m[2] != null) out.push({ kind: "bold", value: m[2] });
    else if (m[3] != null) out.push({ kind: "italic", value: m[3] });
    else if (m[4] != null) out.push({ kind: "code", value: m[4] });
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push({ kind: "text", value: raw.slice(last) });
  return out.length ? out : [{ kind: "text", value: "" }];
}

function parseBlocks(src: string): Block[] {
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      continue;
    }
    const img = trimmed.match(new RegExp(`^${IMG_RE.source}$`));
    if (img) {
      blocks.push({ kind: "img", alt: img[1] || "图片", src: img[2] });
      continue;
    }
    // 行内夹图片：拆成多块
    if (IMG_RE.test(trimmed)) {
      let rest = trimmed;
      const local = new RegExp(IMG_RE.source, "g");
      let mm: RegExpExecArray | null;
      let cursor = 0;
      while ((mm = local.exec(rest)) !== null) {
        const before = rest.slice(cursor, mm.index).trim();
        if (before) blocks.push({ kind: "p", inlines: splitInlines(before) });
        blocks.push({ kind: "img", alt: mm[1] || "图片", src: mm[2] });
        cursor = mm.index + mm[0].length;
      }
      const after = rest.slice(cursor).trim();
      if (after) blocks.push({ kind: "p", inlines: splitInlines(after) });
      continue;
    }
    if (/^###\s+/.test(trimmed)) {
      blocks.push({ kind: "h", level: 3, inlines: splitInlines(trimmed.replace(/^###\s+/, "")) });
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      blocks.push({ kind: "h", level: 2, inlines: splitInlines(trimmed.replace(/^##\s+/, "")) });
      continue;
    }
    if (/^#\s+/.test(trimmed)) {
      blocks.push({ kind: "h", level: 1, inlines: splitInlines(trimmed.replace(/^#\s+/, "")) });
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      blocks.push({ kind: "quote", inlines: splitInlines(trimmed.replace(/^>\s?/, "")) });
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      blocks.push({ kind: "li", inlines: splitInlines(trimmed.replace(/^[-*•]\s+/, "")) });
      continue;
    }
    blocks.push({ kind: "p", inlines: splitInlines(trimmed) });
  }
  return blocks;
}

function InlineView({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((it, i) => {
        if (it.kind === "bold") {
          return (
            <strong key={i}>
              <LatexText text={it.value} as="span" compact />
            </strong>
          );
        }
        if (it.kind === "italic") {
          return (
            <em key={i}>
              <LatexText text={it.value} as="span" compact />
            </em>
          );
        }
        if (it.kind === "code") {
          return (
            <code key={i} className={styles.code}>
              {it.value}
            </code>
          );
        }
        return (
          <Fragment key={i}>
            <LatexText text={it.value} as="span" compact />
          </Fragment>
        );
      })}
    </>
  );
}

/** 笔记预览：Markdown 轻量语法 + 实时 LaTeX + 图片 */
export function NoteRichPreview({
  text,
  emptyHint = "预览将显示在这里",
}: {
  text: string;
  emptyHint?: string;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (!String(text || "").trim()) {
    return <p className={styles.empty}>{emptyHint}</p>;
  }
  return (
    <div className={styles.preview}>
      {blocks.map((b, i) => {
        if (b.kind === "hr") return <hr key={i} className={styles.hr} />;
        if (b.kind === "img") {
          return (
            <figure key={i} className={styles.figure}>
              <img src={b.src} alt={b.alt} className={styles.img} />
              {b.alt ? <figcaption>{b.alt}</figcaption> : null}
            </figure>
          );
        }
        if (b.kind === "h") {
          const Tag = (`h${b.level}` as "h1" | "h2" | "h3");
          return (
            <Tag key={i} className={styles[`h${b.level}`]}>
              <InlineView items={b.inlines} />
            </Tag>
          );
        }
        if (b.kind === "li") {
          return (
            <div key={i} className={styles.li}>
              <span className={styles.bullet}>•</span>
              <span>
                <InlineView items={b.inlines} />
              </span>
            </div>
          );
        }
        if (b.kind === "quote") {
          return (
            <blockquote key={i} className={styles.quote}>
              <InlineView items={b.inlines} />
            </blockquote>
          );
        }
        return (
          <p key={i} className={styles.p}>
            <InlineView items={b.inlines} />
          </p>
        );
      })}
    </div>
  );
}
