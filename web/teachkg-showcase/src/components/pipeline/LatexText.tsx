import { Fragment, useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import styles from "./LatexText.module.css";

type Part =
  | { kind: "text"; value: string }
  | { kind: "inline"; value: string }
  | { kind: "display"; value: string };

const MATH_DELIM_RE =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$((?:\\.|[^$\\])+)\$|\\\(((?:\\.|[^\\])+?)\\\)/g;

/** 已有 $...$ / $$...$$ / \(...\) / \[...\] 的区间保护后，再给裸露命令补 $...$。 */
export function prepareLatexInput(raw: string): string {
  const text = raw || "";
  if (!text) return "";
  if (!/[\\$]/.test(text) && !text.includes("\\(") && !text.includes("\\[")) {
    return text;
  }

  const slots: string[] = [];
  const protect = (chunk: string) => {
    const i = slots.length;
    slots.push(chunk);
    return `\uE000${i}\uE001`;
  };

  // 先保护已有定界公式，避免二次包裹
  let masked = text.replace(new RegExp(MATH_DELIM_RE.source, "g"), (m) => protect(m));

  // 括号内含反斜杠命令： (A \land B) → $(A \land B)$
  masked = masked.replace(/\(([^()\uE000\uE001]*\\[a-zA-Z]+[^()\uE000\uE001]*)\)/g, (m) =>
    protect(`$${m}$`)
  );

  // 连续裸露 TeX 命令序列：\neg、\land、\rightarrow、\mathrm{P}、P_1 等
  masked = masked.replace(
    /(?:\\[a-zA-Z]+(?:\s*\{[^{}]*\})?(?:\s*[_^](?:\{[^{}]+\}|[A-Za-z0-9\\]+))?)+/g,
    (m) => protect(`$${m}$`)
  );

  return masked.replace(/\uE000(\d+)\uE001/g, (_, i) => slots[Number(i)] || "");
}

/** 切分 $$...$$ / $...$ / \[...\] / \(...\)，其余保留为普通文本。 */
export function splitLatexParts(input: string): Part[] {
  const text = prepareLatexInput(input || "");
  if (!text) return [];
  const re = new RegExp(MATH_DELIM_RE.source, "g");
  const parts: Part[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ kind: "text", value: text.slice(last, m.index) });
    }
    if (m[1] != null) parts.push({ kind: "display", value: m[1] });
    else if (m[2] != null) parts.push({ kind: "display", value: m[2] });
    else if (m[3] != null) parts.push({ kind: "inline", value: m[3] });
    else if (m[4] != null) parts.push({ kind: "inline", value: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      throwOnError: false,
      displayMode,
      strict: "ignore",
      trust: false,
    });
  } catch {
    return "";
  }
}

export function LatexText({
  text,
  className,
  as: Tag = "div",
  compact = false,
}: {
  text: string;
  className?: string;
  as?: "div" | "span" | "pre";
  /** 侧栏等场景：继承父级字号/行高/颜色 */
  compact?: boolean;
}) {
  const parts = useMemo(() => splitLatexParts(text || ""), [text]);

  if (!text) return <Tag className={className}>（无）</Tag>;

  return (
    <Tag
      className={`${styles.root} ${compact ? styles.compact : ""} ${className || ""}`.trim()}
    >
      {parts.map((p, i) => {
        if (p.kind === "text") {
          return <Fragment key={i}>{p.value}</Fragment>;
        }
        const html = renderKatex(p.value, p.kind === "display");
        if (!html) {
          return (
            <code key={i} className={styles.fallback}>
              {p.kind === "display" ? `$$${p.value}$$` : `$${p.value}$`}
            </code>
          );
        }
        return (
          <span
            key={i}
            className={p.kind === "display" ? styles.display : styles.inline}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </Tag>
  );
}
