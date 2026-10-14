import { useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import type { MindmapDoc, MindmapTreeNode } from "./MindmapTree";
import { filterMindmapByMastery } from "@/lib/kg/mindmapMasteryFilter.mjs";
import styles from "./StudentMasteryMindmap.module.css";

type PlacedNode = {
  node: MindmapTreeNode;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  depth: number;
  side: -1 | 0 | 1;
  branch: number;
};
type PlacedEdge = {
  key: string;
  path: string;
  depth: number;
  branch: number;
};
type Bounds = { x: number; y: number; width: number; height: number };

const ROW = 58;
const SIBLING_GAP = 12;
const LEVEL_GAP = [190, 160, 125, 108, 95];
const FONT_FAMILY = '"Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif';

function fontSize(depth: number): number {
  return depth === 0 ? 48 : depth === 1 ? 42 : depth === 2 ? 34 : 27;
}

function textWidth(label: string, size: number): number {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context) {
      context.font = `${size >= 34 ? 600 : 400} ${size}px ${FONT_FAMILY}`;
      return Math.ceil(context.measureText(label).width);
    }
  }
  return Math.ceil([...label].reduce((width, character) => width + (/^[\x00-\x7f]$/.test(character) ? 0.55 : 1), 0) * size);
}

function isLecture(node: MindmapTreeNode): boolean {
  return String(node.id || "").startsWith("__lecture__");
}

function childrenOf(node: MindmapTreeNode): MindmapTreeNode[] {
  return (node.children || []).filter((child) => !isLecture(child));
}

function isDenseLeafGroup(node: MindmapTreeNode): boolean {
  const children = childrenOf(node);
  return children.length > 4 && children.every((child) => childrenOf(child).length === 0);
}

function subtreeHeight(node: MindmapTreeNode, memo: WeakMap<MindmapTreeNode, number>): number {
  const cached = memo.get(node);
  if (cached != null) return cached;
  const children = childrenOf(node);
  let height: number;
  if (!children.length) height = ROW;
  else if (isDenseLeafGroup(node)) height = Math.ceil(children.length / 2) * ROW + ROW / 2;
  else height = children.reduce((sum, child) => sum + subtreeHeight(child, memo), 0) + SIBLING_GAP * (children.length - 1);
  memo.set(node, Math.max(ROW, height));
  return Math.max(ROW, height);
}

/** Exhaustive for the few root domains; no course-name/章次 inference. */
function balancedSides(domains: MindmapTreeNode[], memo: WeakMap<MindmapTreeNode, number>): Array<-1 | 1> {
  if (domains.length < 2) return domains.map(() => 1);
  if (domains.length > 12) {
    const totals = [0, 0];
    return domains.map((domain) => {
      const side = totals[0] <= totals[1] ? -1 : 1;
      totals[side === -1 ? 0 : 1] += subtreeHeight(domain, memo);
      return side;
    });
  }
  const heights = domains.map((domain) => subtreeHeight(domain, memo));
  let bestMask = 1;
  let bestCost = Infinity;
  for (let mask = 1; mask < (1 << domains.length) - 1; mask += 2) {
    const left = heights.reduce((sum, height, index) => sum + ((mask & (1 << index)) ? height : 0), 0);
    const right = heights.reduce((sum, height, index) => sum + ((mask & (1 << index)) ? 0 : height), 0);
    const cost = Math.abs(left - right);
    if (cost < bestCost) {
      bestCost = cost;
      bestMask = mask;
    }
  }
  return domains.map((_, index) => (bestMask & (1 << index)) ? -1 : 1);
}

function branchClass(node: MindmapTreeNode, index: number): string {
  // Domain names only choose paint; placement is driven solely by subtree size.
  if (node.zh.includes("图论")) return styles.branchGraph;
  if (node.zh.includes("集合论")) return styles.branchSet;
  if (node.zh.includes("逻辑")) return styles.branchLogic;
  return [styles.branch0, styles.branch1, styles.branch2, styles.branch3, styles.branch4, styles.branch5][index % 6];
}

function layoutMindmap(doc: MindmapDoc) {
  const root = doc.roots?.[0] || doc.root;
  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];
  const memo = new WeakMap<MindmapTreeNode, number>();
  const rootWidth = textWidth(root.zh, 48);
  nodes.push({ node: root, x: 0, y: 0, width: rootWidth, fontSize: 48, depth: 0, side: 0, branch: -1 });
  const domains = childrenOf(root);
  const sides = balancedSides(domains, memo);

  const makeEdge = (parent: PlacedNode, child: PlacedNode, key: string, leafCorridorX?: number) => {
    const side = child.side || 1;
    const x1 = parent.depth === 0 ? side * (parent.width / 2 + 26) : parent.x + side * (parent.width + 52);
    const x2 = child.x;
    const gap = Math.abs(x2 - x1);
    const c = Math.min(gap * 0.52, 100);
    // A far-column leaf crosses the near column only in the gap between its
    // rows. Reach that y before the near-column text/badge, then go straight.
    const path = leafCorridorX == null
      ? `M ${x1} ${parent.y} C ${x1 + side * c} ${parent.y}, ${x2 - side * c} ${child.y}, ${x2} ${child.y}`
      : `M ${x1} ${parent.y} C ${x1 + side * c * 0.5} ${parent.y}, ${leafCorridorX - side * 25} ${child.y}, ${leafCorridorX} ${child.y} L ${x2} ${child.y}`;
    edges.push({
      key,
      path,
      depth: parent.depth,
      branch: child.branch,
    });
  };

  const place = (node: MindmapTreeNode, parent: PlacedNode, side: -1 | 1, branch: number, centerY: number, key: string, innerX?: number, leafCorridorX?: number): PlacedNode => {
    const depth = parent.depth + 1;
    const width = textWidth(node.zh, fontSize(depth));
    const x = innerX ?? (parent.depth === 0
      ? side * (parent.width / 2 + LEVEL_GAP[0])
      : parent.x + side * (parent.width + (LEVEL_GAP[Math.min(parent.depth, LEVEL_GAP.length - 1)] || 95)));
    const placed: PlacedNode = { node, x, y: centerY, width, fontSize: fontSize(depth), depth, side, branch };
    nodes.push(placed);
    makeEdge(parent, placed, key, leafCorridorX);
    const children = childrenOf(node);
    if (!children.length) return placed;
    if (isDenseLeafGroup(node)) {
      const rows = Math.ceil(children.length / 2);
      const near = children.slice(0, rows);
      const far = children.slice(rows);
      const nearX = x + side * (width + LEVEL_GAP[Math.min(depth, LEVEL_GAP.length - 1)]);
      const farX = nearX + side * (Math.max(...near.map((child) => textWidth(child.zh, fontSize(depth + 1)))) + 112);
      const top = centerY - subtreeHeight(node, memo) / 2 + ROW / 2;
      near.forEach((child, index) => place(child, placed, side, branch, top + index * ROW, `${key}.n${index}`, nearX));
      far.forEach((child, index) => place(child, placed, side, branch, top + ROW / 2 + index * ROW, `${key}.f${index}`, farX, nearX - side * 36));
      return placed;
    }
    const height = subtreeHeight(node, memo);
    let cursor = centerY - height / 2;
    children.forEach((child, index) => {
      const childHeight = subtreeHeight(child, memo);
      place(child, placed, side, branch, cursor + childHeight / 2, `${key}.${index}`);
      cursor += childHeight + SIBLING_GAP;
    });
    return placed;
  };

  for (const side of [-1, 1] as const) {
    const domainIndexes = domains.map((_, index) => index).filter((index) => sides[index] === side);
    const total = domainIndexes.reduce((sum, index) => sum + subtreeHeight(domains[index], memo), 0)
      + Math.max(0, domainIndexes.length - 1) * ROW * 1.5;
    let cursor = -total / 2;
    for (const index of domainIndexes) {
      const domain = domains[index];
      const height = subtreeHeight(domain, memo);
      place(domain, nodes[0], side, index, cursor + height / 2, `domain.${index}`);
      cursor += height + ROW * 1.5;
    }
  }

  let minX = -rootWidth / 2 - 90;
  let maxX = rootWidth / 2 + 90;
  let minY = -80;
  let maxY = 80;
  for (const placed of nodes) {
    const left = placed.side === -1 ? placed.x - placed.width - 80 : placed.side === 1 ? placed.x : -placed.width / 2;
    const right = placed.side === 1 ? placed.x + placed.width + 80 : placed.side === -1 ? placed.x : placed.width / 2;
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
    minY = Math.min(minY, placed.y - placed.fontSize - 24);
    maxY = Math.max(maxY, placed.y + placed.fontSize + 24);
  }
  return { nodes, edges, domains, bounds: { x: minX - 80, y: minY - 80, width: maxX - minX + 160, height: maxY - minY + 160 } as Bounds };
}

function statusText(score: number | undefined): string {
  if (score == null) return "暂无记录";
  if (score === 0) return "未学习 · 0 分";
  return score >= 4 ? `已掌握 · ${score.toFixed(2)} 分` : `学习中 · ${score.toFixed(2)} 分`;
}

export function StudentMasteryMindmap({
  doc,
  mastery,
  selectedId,
  selectedPath,
  onSelect,
  onClearSelect,
  message,
}: {
  doc: MindmapDoc;
  mastery: Readonly<Record<string, number>>;
  selectedId?: string | null;
  selectedPath?: readonly number[] | null;
  onSelect?: (node: MindmapTreeNode) => void;
  onClearSelect?: () => void;
  message?: string;
}) {
  const [percent, setPercent] = useState(25);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<{ id: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null);
  const filtered = useMemo(
    () => filterMindmapByMastery(doc, mastery, percent, { selectedId, selectedPath, balanceDomains: true }),
    [doc, mastery, percent, selectedId, selectedPath],
  );
  const layout = useMemo(() => layoutMindmap(filtered.doc), [filtered.doc]);
  const fitted: Bounds = {
    x: layout.bounds.x + pan.x + layout.bounds.width * (1 - 1 / zoom) / 2,
    y: layout.bounds.y + pan.y + layout.bounds.height * (1 - 1 / zoom) / 2,
    width: layout.bounds.width / zoom,
    height: layout.bounds.height / zoom,
  };
  const setRequestedPercent = (value: number) => setPercent(Math.max(0, Math.min(100, Math.round(value))));
  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    pointer.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
  };
  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const current = pointer.current;
    if (!current || current.id !== event.pointerId) return;
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 4) {
      if (!current.moved) event.currentTarget.setPointerCapture(event.pointerId);
      current.moved = true;
      setDragging(true);
    }
    const matrix = event.currentTarget.getScreenCTM();
    if (current.moved && matrix) {
      const inverse = matrix.inverse();
      const before = new DOMPoint(current.x, current.y).matrixTransform(inverse);
      const after = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
      setPan((previous) => ({ x: previous.x - (after.x - before.x), y: previous.y - (after.y - before.y) }));
    }
    current.x = event.clientX;
    current.y = event.clientY;
  };
  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    if (pointer.current.moved) window.setTimeout(() => { pointer.current = null; }, 0);
    else pointer.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom((previous) => Math.max(0.5, Math.min(12, previous * (event.deltaY < 0 ? 1.12 : 1 / 1.12))));
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.counts}>显示 {filtered.stats.visibleNodes} / {filtered.stats.totalNodes} 个节点</span>
        <div className={styles.controls}>
          <label className={styles.controlLabel} htmlFor="mindmap-visible-percent">显示比例</label>
          <input id="mindmap-visible-percent" className={styles.percentSlider} type="range" min="0" max="100" step="1" value={percent} onChange={(event) => setRequestedPercent(Number(event.target.value))} />
          <input className={styles.controlSelect} aria-label="显示节点百分比" type="number" min="0" max="100" step="1" value={percent} onChange={(event) => setRequestedPercent(Number(event.target.value))} style={{ width: 62 }} />
          <span className={styles.percentValue}>%</span>
          <button type="button" className={styles.controlButton} onClick={() => setZoom((value) => Math.min(12, value * 1.25))}>＋</button>
          <button type="button" className={styles.controlButton} onClick={() => setZoom((value) => Math.max(0.5, value / 1.25))}>－</button>
          <button type="button" className={styles.controlButton} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>适合窗口</button>
        </div>
      </div>
      <div className={styles.canvas}>
        <svg
          className={`${styles.viewport} ${dragging ? styles.dragging : ""}`}
          viewBox={`${fitted.x} ${fitted.y} ${fitted.width} ${fitted.height}`}
          role="img"
          aria-label={`学生知识点掌握思维导图，显示 ${filtered.stats.visibleNodes} 个节点`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          onClick={(event) => { if (event.target === event.currentTarget && !pointer.current?.moved) onClearSelect?.(); }}
        >
          {layout.edges.map((edge) => {
            const domain = layout.domains[edge.branch];
            return <path key={edge.key} d={edge.path} className={`${styles.edge} ${edge.depth === 0 ? styles.edgeTrunk : edge.depth === 1 ? styles.edgeMajor : styles.edgeBranch} ${domain ? branchClass(domain, edge.branch) : ""}`} />;
          })}
          {layout.nodes.map((placed, index) => {
            const score = Object.prototype.hasOwnProperty.call(mastery, placed.node.zh) ? mastery[placed.node.zh] : undefined;
            const sourcePath = (placed.node as MindmapTreeNode & { __sourcePath?: number[] }).__sourcePath;
            const selected = selectedPath
              ? sourcePath?.join(".") === selectedPath.join(".")
              : placed.node.id === selectedId;
            const domain = layout.domains[placed.branch];
            const nodeClass = placed.depth === 0 ? styles.nodeRoot : placed.depth === 1 ? styles.nodeDomain : placed.depth === 2 ? styles.nodeChapter : "";
            const anchor = placed.side === -1 ? "end" : placed.side === 1 ? "start" : "middle";
            const start = placed.side === -1 ? -placed.width : placed.side === 1 ? 0 : -placed.width / 2;
            const end = start + placed.width;
            const badgeX = placed.side === -1 ? start - 27 : end + 27;
            const marker = score == null ? "?" : score === 0 ? "0" : score.toFixed(1);
            return (
              <g
                key={`${placed.node.id}-${index}`}
                className={`${styles.node} ${nodeClass} ${domain ? branchClass(domain, placed.branch) : ""} ${selected ? styles.nodeSelected : ""} ${score === 0 || score == null ? styles.masteryUnseen : ""}`}
                transform={`translate(${placed.x} ${placed.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${placed.node.zh}，${statusText(score)}`}
                onClick={(event) => { event.stopPropagation(); if (!pointer.current?.moved) onSelect?.(placed.node); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(placed.node); } }}
              >
                <title>{`${placed.node.zh} · ${statusText(score)}`}</title>
                {placed.depth === 0 ? <rect className={styles.rootCard} x={-placed.width / 2 - 26} y={-placed.fontSize * 0.72} width={placed.width + 52} height={placed.fontSize * 1.5} rx="16" /> : null}
                <rect className={styles.hitTarget} x={start - 12} y={-placed.fontSize * 0.7} width={placed.width + 24} height={placed.fontSize * 1.6} />
                <text x="0" y="0" textAnchor={anchor} dominantBaseline="middle">{placed.node.zh}</text>
                {placed.depth > 0 ? <path className={styles.underline} d={`M ${start} ${placed.fontSize * 0.75} L ${end} ${placed.fontSize * 0.75}`} /> : null}
                {placed.depth > 0 ? (
                  <g transform={`translate(${badgeX} 0)`}>
                    <circle className={styles.masteryBadge} r="22" />
                    <circle className={styles.masteryTrack} r="17" />
                    {score != null && score > 0 ? <circle className={styles.masteryArc} r="17" strokeDasharray={`${2 * Math.PI * 17 * score / 5} ${2 * Math.PI * 17}`} transform="rotate(-90)" /> : null}
                    <text className={styles.masteryText} textAnchor="middle" dominantBaseline="middle">{marker}</text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <div className={styles.legend}>
        <span className={styles.legendItem}>圆环：掌握分数 0–5</span>
        <span className={styles.legendItem}>各主分支按比例显示；分支内优先保留学习中的薄弱节点</span>
        {message ? <span className={styles.caption}>{message}</span> : null}
      </div>
    </div>
  );
}
