import { useMemo, useState } from "react";
import type { PipelineNode, PipelineStage } from "../../lib/pipeline/types";
import { LatexText } from "./LatexText";
import { ResizableSplit } from "./ResizableSplit";
import styles from "./SeedTextCompare.module.css";

type SeedKind = "alias" | "embedding" | "filtered_alias" | "filtered_embedding";

type SeedItem = {
  id: string;
  label: string;
  kind: SeedKind;
  found: boolean;
  matchedAlias?: string;
};

type TextSpan = {
  kind: "same" | "alias" | "embedding";
  text: string;
  seedId?: string;
};

function classifyKind(kind: string | undefined): SeedKind | null {
  if (kind === "seed_alias" || kind === "seed") return "alias";
  if (kind === "seed_embedding") return "embedding";
  if (kind === "seed_filtered_alias") return "filtered_alias";
  if (kind === "seed_filtered_embedding") return "filtered_embedding";
  return null;
}

/** 从「中文/English」实体名拆出用于匹配的别名，长的优先。 */
export function seedMatchAliases(entityId: string, label?: string): string[] {
  const parts = String(entityId || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<string>();
  if (label?.trim()) set.add(label.trim());
  for (const p of parts) {
    set.add(p);
    const noSpace = p.replace(/\s+/g, "");
    if (noSpace !== p) set.add(noSpace);
  }
  return [...set]
    .filter((a) => {
      if (a.length < 2) return false;
      // 纯单字母/过短英文易误伤
      if (/^[a-zA-Z]+$/.test(a) && a.length < 3) return false;
      return true;
    })
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function findFirstMatch(
  text: string,
  aliases: string[]
): { start: number; end: number; alias: string } | null {
  const lower = text.toLowerCase();
  let best: { start: number; end: number; alias: string } | null = null;
  for (const alias of aliases) {
    const isAscii = /^[\x00-\x7F]+$/.test(alias);
    let idx = -1;
    if (isAscii) {
      idx = lower.indexOf(alias.toLowerCase());
    } else {
      idx = text.indexOf(alias);
    }
    if (idx < 0) continue;
    const end = idx + alias.length;
    if (
      !best ||
      idx < best.start ||
      (idx === best.start && alias.length > best.end - best.start)
    ) {
      best = { start: idx, end, alias };
    }
  }
  return best;
}

function buildTextSpans(
  text: string,
  seeds: { id: string; kind: SeedKind; aliases: string[] }[]
): { spans: TextSpan[]; foundIds: Map<string, string> } {
  type Hit = {
    start: number;
    end: number;
    seedId: string;
    kind: "alias" | "embedding";
    alias: string;
  };
  const hits: Hit[] = [];
  for (const s of seeds) {
    if (s.kind !== "alias" && s.kind !== "embedding") continue;
    // 收集全文所有不重叠候选：对每个 alias 扫一遍
    for (const alias of s.aliases) {
      const isAscii = /^[\x00-\x7F]+$/.test(alias);
      const hay = isAscii ? text.toLowerCase() : text;
      const needle = isAscii ? alias.toLowerCase() : alias;
      let from = 0;
      while (from < hay.length) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        hits.push({
          start: idx,
          end: idx + alias.length,
          seedId: s.id,
          kind: s.kind,
          alias,
        });
        from = idx + Math.max(1, alias.length);
      }
    }
  }
  // 长匹配优先，再按起点
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);

  const taken: Hit[] = [];
  const occupied = (start: number, end: number) =>
    taken.some((h) => !(end <= h.start || start >= h.end));
  for (const h of hits) {
    if (!occupied(h.start, h.end)) taken.push(h);
  }
  taken.sort((a, b) => a.start - b.start);

  const foundIds = new Map<string, string>();
  for (const h of taken) {
    if (!foundIds.has(h.seedId)) foundIds.set(h.seedId, h.alias);
  }

  const spans: TextSpan[] = [];
  let cursor = 0;
  for (const h of taken) {
    if (h.start > cursor) {
      spans.push({ kind: "same", text: text.slice(cursor, h.start) });
    }
    spans.push({
      kind: h.kind,
      text: text.slice(h.start, h.end),
      seedId: h.seedId,
    });
    cursor = h.end;
  }
  if (cursor < text.length) {
    spans.push({ kind: "same", text: text.slice(cursor) });
  }
  if (!spans.length) {
    spans.push({ kind: "same", text: text || "（无）" });
  }
  return { spans, foundIds };
}

function buildSeedItems(nodes: PipelineNode[] | undefined, foundIds: Map<string, string>): SeedItem[] {
  const items: SeedItem[] = [];
  for (const n of nodes || []) {
    const kind = classifyKind(n.kind);
    if (!kind) continue;
    const id = String(n.id || "");
    if (!id) continue;
    items.push({
      id,
      label: String(n.label || id.split("/")[0] || id),
      kind,
      found: foundIds.has(id),
      matchedAlias: foundIds.get(id),
    });
  }
  const order: Record<SeedKind, number> = {
    alias: 0,
    embedding: 1,
    filtered_alias: 2,
    filtered_embedding: 3,
  };
  items.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      Number(b.found) - Number(a.found) ||
      a.label.localeCompare(b.label, "zh")
  );
  return items;
}

function kindLabel(kind: SeedKind): string {
  if (kind === "alias") return "别名";
  if (kind === "embedding") return "向量";
  if (kind === "filtered_alias") return "已筛·别名";
  return "已筛·向量";
}

export function SeedTextCompare({ stage }: { stage: PipelineStage }) {
  const [showFiltered, setShowFiltered] = useState(false);
  const text = stage.text || stage.corrected_text || "";

  const { spans, kept, filtered, foundCount, missCount } = useMemo(() => {
    const keptNodes = (stage.nodes || []).filter((n) => {
      const k = classifyKind(n.kind);
      return k === "alias" || k === "embedding";
    });
    const seedMeta = keptNodes.map((n) => {
      const kind = classifyKind(n.kind)!;
      return {
        id: String(n.id),
        kind: kind as "alias" | "embedding",
        aliases: seedMatchAliases(String(n.id), n.label),
      };
    });
    const { spans: sp, foundIds } = buildTextSpans(text, seedMeta);
    // 未在贪心占用中命中的，再试「是否至少出现一次」以标记 found
    for (const s of seedMeta) {
      if (foundIds.has(s.id)) continue;
      const m = findFirstMatch(text, s.aliases);
      if (m) foundIds.set(s.id, m.alias);
    }
    const allItems = buildSeedItems(stage.nodes, foundIds);
    const keptItems = allItems.filter((i) => i.kind === "alias" || i.kind === "embedding");
    const filteredItems = allItems.filter(
      (i) => i.kind === "filtered_alias" || i.kind === "filtered_embedding"
    );
    return {
      spans: sp,
      kept: keptItems,
      filtered: filteredItems,
      foundCount: keptItems.filter((i) => i.found).length,
      missCount: keptItems.filter((i) => !i.found).length,
    };
  }, [stage.nodes, text]);

  const visible = showFiltered ? [...kept, ...filtered] : kept;

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.legend}>
          <span className={styles.legItem}>
            <i className={styles.legAlias} /> 别名命中
          </span>
          <span className={styles.legItem}>
            <i className={styles.legEmb} /> 向量命中
          </span>
          <span className={styles.legItem}>
            <i className={styles.legMiss} /> 原文未匹配
          </span>
        </div>
        <span className={styles.hint}>
          保留 {kept.length} · 原文命中 {foundCount}
          {missCount ? ` · 未匹配 ${missCount}` : ""}
          {filtered.length ? ` · 已筛 ${filtered.length}` : ""}
        </span>
        {filtered.length > 0 && (
          <button
            type="button"
            className={`${styles.toggle} ${showFiltered ? styles.toggleOn : ""}`}
            onClick={() => setShowFiltered((v) => !v)}
            aria-pressed={showFiltered}
          >
            {showFiltered ? "隐藏已筛掉" : "显示已筛掉"}
          </button>
        )}
      </div>

      <ResizableSplit
        className={styles.cols}
        storageKey="split-seed-text-list-v2"
        initialLeftRatio={0.5}
        minLeftPx={220}
        minRightPx={200}
        leftClassName={styles.col}
        rightClassName={styles.col}
        left={
          <>
            <header className={styles.head}>
              <strong>预处理文本</strong>
              <span>{text.length} 字</span>
            </header>
            <div className={styles.body}>
              {spans.map((sp, i) => {
                if (sp.kind === "same") {
                  return (
                    <LatexText key={i} text={sp.text} as="span" className={styles.inlineTex} />
                  );
                }
                return (
                  <mark
                    key={i}
                    className={sp.kind === "alias" ? styles.hlAlias : styles.hlEmb}
                    title={sp.seedId || ""}
                  >
                    <LatexText text={sp.text} as="span" className={styles.inlineTex} />
                  </mark>
                );
              })}
            </div>
          </>
        }
        right={
          <>
            <header className={styles.head}>
              <strong>种子实体</strong>
              <span>{visible.length} 个</span>
            </header>
            <div className={styles.seedList}>
              {visible.length === 0 ? (
                <div className={styles.empty}>（无种子）</div>
              ) : (
                visible.map((s) => {
                  const filteredSeed =
                    s.kind === "filtered_alias" || s.kind === "filtered_embedding";
                  const chipClass = [
                    styles.chip,
                    filteredSeed
                      ? styles.chipFiltered
                      : s.found
                        ? s.kind === "alias"
                          ? styles.chipAlias
                          : styles.chipEmb
                        : styles.chipMiss,
                  ].join(" ");
                  return (
                    <div key={`${s.kind}:${s.id}`} className={chipClass} title={s.id}>
                      <span className={styles.chipKind}>{kindLabel(s.kind)}</span>
                      <span className={styles.chipLabel}>{s.label}</span>
                      {!filteredSeed && !s.found && (
                        <span className={styles.chipTag}>未在原文</span>
                      )}
                      {!filteredSeed && s.found && s.matchedAlias && s.matchedAlias !== s.label && (
                        <span className={styles.chipTag}>匹配「{s.matchedAlias}」</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        }
      />
    </div>
  );
}
