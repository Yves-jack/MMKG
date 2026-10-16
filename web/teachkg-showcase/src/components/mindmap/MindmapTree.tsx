import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  addChildNode,
  canReorderSibling,
  clearMindmapClipboard,
  clearMindmapEditPatch,
  clearMindmapUndoStack,
  cloneForest,
  cloneSubtreeWithNewIds,
  deleteNodePromoteChildren,
  deleteSubtree,
  docForest,
  flattenForest,
  getAt,
  loadMindmapClipboard,
  loadMindmapUndoStack,
  makeLeafNode,
  moveSubtree,
  parentIdAtPath,
  pathEquals,
  renameNode,
  reorderSibling,
  saveMindmapClipboard,
  saveMindmapEditPatch,
  saveMindmapUndoStack,
  withForest,
  type MindmapHistoryItem,
  type MindmapUndoEntry,
} from "@/lib/review/mindmapEdits";
import { dedupeEntityMatchesByZh } from "@/lib/entitySearchDedupe";
import { exportMindmapPng } from "@/lib/kg/exportMindmapPng";
import { remapSetTheoryChapterLabelsInDoc } from "@/lib/kg/mindmapTypes";
import { collectSubtreeIds, retargetIdentity, type ConceptLink } from "@/lib/review/conceptIdentity";
import { withBase } from "@/lib/withBase";
import styles from "./MindmapTree.module.css";

export type MindmapTreeNode = {
  id: string;
  zh: string;
  /** 课堂修正后的展示重要性（与复习图谱同源，非教材 base） */
  importance: number;
  relation?: string | null;
  related?: string[];
  /** depend_on 旁路：本节点依赖的概念名 */
  deps?: string[];
  /** 同一实体挂到另一父下的副本（默认不带子树） */
  copy?: boolean;
  /** 弱关联边（虚线）：副本挂接、虚根拼树、回流等 */
  weak?: boolean;
  /** 覆盖回流 / 浅树豁免挂入 */
  salvaged?: boolean;
  linkKind?: "hierarchy" | "attach" | "copy" | "depend";
  /** 本课边/片段上最早出现秒数（排序用） */
  firstSeenSec?: number;
  children: MindmapTreeNode[];
};

export type MindmapRemoteLink = {
  id: string;
  from: string;
  to: string;
  label?: string;
};

export type MindmapDoc = {
  lecture_id: string;
  root: MindmapTreeNode;
  /** 多棵独立树；缺省时退回 [root]（课程总导图仍是一棵） */
  roots?: MindmapTreeNode[];
  n_nodes: number;
  max_depth: number;
  orphan_count: number;
  /** 横向远程连接（非父子树边） */
  remoteLinks?: MindmapRemoteLink[];
  /** 被合并/删除的旧节点 id → 仍存在的概念 id */
  id_redirects?: Record<string, string>;
  /** 概念 id → 其他板块（复习/练习/视频等），不跟显示名走 */
  concept_links?: ConceptLink[];
  meta?: {
    chapter?: string;
    root_zh?: string;
    virtual_root?: boolean;
    n_trees?: number;
    n_entities_raw?: number;
    n_edges_raw?: number;
    attached_orphans?: number;
    n_chapters?: number;
    n_parts?: number;
    stitch?: string;
    /** course | chapter | lecture */
    scope?: "course" | "chapter" | "lecture";
    lecture_ids?: string[];
    source?: "kg" | "summary+kg" | "review+kg" | "outline_text" | "outline+kg";
    pipeline?: string;
    /** course=chapters 拼接；lecture=从章裁剪 */
    composed_from?: "chapters" | "chapter_slice";
    /** textbook_toc | summary | manual */
    skeleton_source?: string;
    n_sections?: number;
    id_redirects?: Record<string, string>;
    /** 整课骨架视图（仅章→节） */
    skeleton_view?: boolean;
    outline_key?: string;
  };
};

/**
 * leaf = 树上最外一层（无子节点），与 id 是否为 __topic__ 无关。
 * 有子节点时再按大纲前缀区分 chapter / topic。
 */
function nodeKind(
  id: string,
  depth: number,
  hasKids: boolean
): "root" | "chapter" | "topic" | "leaf" {
  if (id.startsWith("__course__/") || depth === 0) return "root";
  if (!hasKids) return "leaf";
  if (id.startsWith("__part__/")) return "chapter";
  if (id.startsWith("__chapter__/")) return "chapter";
  if (id.startsWith("__lecture__/")) return "chapter";
  if (id.startsWith("__section__/") || id.startsWith("__topic__/")) return "topic";
  if (id.startsWith("__salvage__/")) return "topic";
  // 带孩子的实体/手工节点：中间层，按 topic 样式
  return "topic";
}

function collectMaxImp(node: MindmapTreeNode): number {
  let m = node.importance || 0;
  for (const c of node.children || []) m = Math.max(m, collectMaxImp(c));
  return m;
}

function collectForestMaxImp(trees: MindmapTreeNode[]): number {
  return trees.reduce((m, n) => Math.max(m, collectMaxImp(n)), 0);
}

/** 子树视觉体量（节点数），用于左右分枝均衡 */
function subtreeWeight(node: MindmapTreeNode): number {
  const kids = node.children || [];
  if (!kids.length) return 1;
  let s = 1;
  for (const c of kids) s += subtreeWeight(c);
  return s;
}

type SplitKid = { node: MindmapTreeNode; index: number; w: number };

/**
 * 按子树体量把根下一级分到左右，尽量两边总重接近；
 * 同侧仍按原大纲顺序排列。
 */
function balanceRootSplit(kids: MindmapTreeNode[]): {
  left: SplitKid[];
  right: SplitKid[];
} {
  const items: SplitKid[] = kids.map((node, index) => ({
    node,
    index,
    w: subtreeWeight(node),
  }));
  if (items.length <= 1) {
    return { left: [], right: items };
  }
  const left: SplitKid[] = [];
  const right: SplitKid[] = [];
  let lw = 0;
  let rw = 0;
  const byWeight = [...items].sort(
    (a, b) => b.w - a.w || a.index - b.index
  );
  for (const it of byWeight) {
    if (lw <= rw) {
      left.push(it);
      lw += it.w;
    } else {
      right.push(it);
      rw += it.w;
    }
  }
  left.sort((a, b) => a.index - b.index);
  right.sort((a, b) => a.index - b.index);
  return { left, right };
}

function docTrees(doc: MindmapDoc): MindmapTreeNode[] {
  return doc.roots?.length ? doc.roots : doc.root ? [doc.root] : [];
}

function withRetargetedIdentity(
  doc: MindmapDoc,
  trees: MindmapTreeNode[],
  gone: Iterable<string>,
  canonical: string | null,
  remoteLinks: MindmapRemoteLink[]
): MindmapDoc {
  const next = retargetIdentity({
    gone,
    canonical,
    idRedirects: doc.id_redirects,
    remoteLinks,
    conceptLinks: doc.concept_links,
  });
  return withForest(doc, trees, next.remoteLinks, {
    idRedirects: next.id_redirects,
    conceptLinks: next.concept_links,
  });
}

export type MindmapLayout = "lr";

function isVirtualNode(id: string): boolean {
  return (
    id.startsWith("__course__/") ||
    id.startsWith("__part__/") ||
    id.startsWith("__chapter__/") ||
    id.startsWith("__lecture__/") ||
    id.startsWith("__section__/") ||
    id.startsWith("__topic__/") ||
    id.startsWith("__salvage__/")
  );
}

const ZOOM_MIN = 0.18;
const ZOOM_MAX = 2.8;
const ZOOM_STEP = 1.12;
/** 整图适配时不超过此缩放，避免小图被放得过大 */
const FIT_ZOOM_MAX = 1.05;
/** 整图相对视口留白 */
const FIT_PAD = 0.88;

function clampZoom(v: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
}

/** 树中节点最大 depth（根=0） */
function forestMaxDepth(nodes: MindmapTreeNode[], depth = 0): number {
  let m = depth;
  for (const n of nodes) {
    const kids = n.children || [];
    if (kids.length) m = Math.max(m, forestMaxDepth(kids, depth + 1));
    else m = Math.max(m, depth);
  }
  return m;
}

/**
 * expandDepth 语义：depth < expandDepth 的节点为展开。
 * 叶子在 maxD 时，有用上限为 maxD（打开 0..maxD-1，露出最外层）。
 */
function usefulExpandDepthCap(maxD: number) {
  return Math.max(0, maxD);
}

/** 整课：展开到「章」并露出其下一层（章节点打开） */
function courseChapterExpandDepth(trees: MindmapTreeNode[]): number {
  let chapterDepth: number | null = null;
  const walk = (n: MindmapTreeNode, d: number) => {
    const id = String(n.id || "");
    if (id.startsWith("__chapter__/")) {
      chapterDepth = chapterDepth == null ? d : Math.min(chapterDepth, d);
    }
    for (const c of n.children || []) walk(c, d + 1);
  };
  for (const t of trees) walk(t, 0);
  if (chapterDepth == null) return 2;
  return chapterDepth + 1;
}

type MindmapExpandState = {
  v: 1;
  depth: number;
  /** pathKey → 是否展开；覆盖 expandDepth 基线 */
  open?: Record<string, boolean>;
};

function readStoredExpandState(key: string): MindmapExpandState | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === "") return null;
    // 兼容旧版：只存了数字
    if (/^\d+(\.\d+)?$/.test(raw.trim())) {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? { v: 1, depth: n } : null;
    }
    const parsed = JSON.parse(raw) as MindmapExpandState;
    if (!parsed || typeof parsed !== "object") return null;
    const depth = Number(parsed.depth);
    if (!Number.isFinite(depth) || depth < 0) return null;
    const open =
      parsed.open && typeof parsed.open === "object" ? parsed.open : undefined;
    return { v: 1, depth, open };
  } catch {
    return null;
  }
}

function writeStoredExpandState(key: string, state: MindmapExpandState) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function collectSubtreePathKeys(
  trees: MindmapTreeNode[],
  rootPath: number[]
): string[] {
  let node: MindmapTreeNode | null = null;
  let cur: MindmapTreeNode[] = trees;
  for (let i = 0; i < rootPath.length; i++) {
    node = cur[rootPath[i]] || null;
    if (!node) return [];
    cur = node.children || [];
  }
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: MindmapTreeNode, path: number[]) => {
    if ((n.children || []).length) out.push(path.join("."));
    (n.children || []).forEach((c, i) => walk(c, [...path, i]));
  };
  walk(node, rootPath);
  return out;
}

/** 展开/收起后仍可见的焦点路径（收起时若原节点消失则回退到最近祖先） */
function resolveChromeFocusPath(
  selectedPath: number[] | null,
  nextExpandDepth: number,
  mode: "expand" | "collapse"
): string | null {
  if (!selectedPath?.length) return null;
  const depth = selectedPath.length - 1;
  // 可见：祖先均展开 → 节点 depth 不超过 nextExpandDepth
  if (mode === "expand" || depth <= nextExpandDepth) {
    return selectedPath.join(".");
  }
  const keepLen = Math.max(1, nextExpandDepth + 1);
  return selectedPath.slice(0, keepLen).join(".");
}

type ViewportFocusRequest = {
  seq: number;
  pathKey: string | null;
  mode: "expand" | "collapse";
};

/** 画布平移 + 滚轮缩放；移动超过阈值时吞掉随后的 click，避免误触展开 */
function PanViewport({
  children,
  resetKey,
  recenterToken,
  focusRequest,
  onViewChange,
}: {
  children: ReactNode;
  resetKey: string | number;
  /** 展开就绪 / 深度变化后触发，整图适配缩放并居中 */
  recenterToken?: string | number;
  focusRequest?: ViewportFocusRequest | null;
  /** 平移/缩放后回调（用于重测弯曲连线） */
  onViewChange?: () => void;
}) {
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [moved, setMoved] = useState(false);
  const [animating, setAnimating] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const animTimerRef = useRef<number | null>(null);
  const viewNotifyRaf = useRef<number | null>(null);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  const notifyViewChange = () => {
    if (!onViewChangeRef.current) return;
    if (viewNotifyRaf.current != null) return;
    viewNotifyRaf.current = requestAnimationFrame(() => {
      viewNotifyRaf.current = null;
      onViewChangeRef.current?.();
    });
  };

  const measureContentRect = (): DOMRect | null => {
    const host = hostRef.current;
    if (!host) return null;
    const canvas = host.querySelector(`.${styles.canvas}`) as HTMLElement | null;
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      if (r.width >= 4 && r.height >= 4) return r;
    }
    const bubbles = host.querySelectorAll<HTMLElement>("[data-mind-bubble]");
    if (!bubbles.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    bubbles.forEach((el) => {
      const r = el.getBoundingClientRect();
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    });
    if (!Number.isFinite(left) || right - left < 4 || bottom - top < 4) return null;
    return new DOMRect(left, top, right - left, bottom - top);
  };

  /** 缩放+平移，使当前可见整图落入视口（带边距） */
  const fitMapInView = (animate = false) => {
    if (dragRef.current) return false;
    const host = hostRef.current;
    if (!host) return false;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width < 8 || hostRect.height < 8) return false;
    const content = measureContentRect();
    if (!content) return false;
    const cur = viewRef.current;
    const worldW = content.width / Math.max(cur.scale, 1e-6);
    const worldH = content.height / Math.max(cur.scale, 1e-6);
    if (worldW < 4 || worldH < 4) return false;
    const fitScale = clampZoom(
      Math.min(
        (hostRect.width * FIT_PAD) / worldW,
        (hostRect.height * FIT_PAD) / worldH,
        FIT_ZOOM_MAX
      )
    );
    const contentCx = content.left + content.width / 2;
    const contentCy = content.top + content.height / 2;
    const hostCx = hostRect.left + hostRect.width / 2;
    const hostCy = hostRect.top + hostRect.height / 2;
    const dx = hostCx - contentCx;
    const dy = hostCy - contentCy;
    const cx = hostRect.width / 2;
    const cy = hostRect.height / 2;
    const x1 = cur.x + dx;
    const y1 = cur.y + dy;
    const wx = (cx - x1) / cur.scale;
    const wy = (cy - y1) / cur.scale;
    const next = {
      x: cx - wx * fitScale,
      y: cy - wy * fitScale,
      scale: fitScale,
    };
    if (
      Math.abs(next.x - cur.x) < 0.5 &&
      Math.abs(next.y - cur.y) < 0.5 &&
      Math.abs(next.scale - cur.scale) < 0.002
    ) {
      return true;
    }
    if (animate) {
      if (animTimerRef.current != null) window.clearTimeout(animTimerRef.current);
      setAnimating(true);
      animTimerRef.current = window.setTimeout(() => {
        setAnimating(false);
        animTimerRef.current = null;
      }, 400);
    }
    viewRef.current = next;
    setView(next);
    notifyViewChange();
    return true;
  };

  const zoomAt = (nextScale: number, clientX: number, clientY: number) => {
    const host = hostRef.current;
    if (!host) {
      setView((v) => ({ ...v, scale: clampZoom(nextScale) }));
      notifyViewChange();
      return;
    }
    const rect = host.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const cur = viewRef.current;
    const scale = clampZoom(nextScale);
    if (scale === cur.scale) return;
    const wx = (cx - cur.x) / cur.scale;
    const wy = (cy - cur.y) / cur.scale;
    setView({ x: cx - wx * scale, y: cy - wy * scale, scale });
    notifyViewChange();
  };

  const zoomBy = (factor: number) => {
    const host = hostRef.current;
    const rect = host?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    zoomAt(viewRef.current.scale * factor, cx, cy);
  };

  const resetView = () => {
    const origin = { x: 0, y: 0, scale: 1 };
    viewRef.current = origin;
    setView(origin);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitMapInView(true);
      });
    });
  };

  const findFocusEl = (pathKey: string | null): HTMLElement | null => {
    const host = hostRef.current;
    if (!host) return null;
    if (pathKey) {
      let parts = pathKey.split(".").filter(Boolean);
      while (parts.length) {
        const el = host.querySelector(
          `[data-node-path="${CSS.escape(parts.join("."))}"]`
        ) as HTMLElement | null;
        if (el) return el;
        parts = parts.slice(0, -1);
      }
    }
    return host.querySelector("[data-mind-bubble]") as HTMLElement | null;
  };

  useEffect(() => {
    const origin = { x: 0, y: 0, scale: 1 };
    viewRef.current = origin;
    setView(origin);
    dragRef.current = null;
    setDragging(false);
    setMoved(false);
    setAnimating(false);
    suppressClickRef.current = false;
  }, [resetKey]);

  // 换图 / 展开就绪后：整图适配进视口（多次尝试等布局稳定）
  useEffect(() => {
    let cancelled = false;
    const delays = [60, 160, 320, 560];
    const timers = delays.map((ms, i) =>
      window.setTimeout(() => {
        if (cancelled) return;
        requestAnimationFrame(() => {
          if (!cancelled) fitMapInView(i > 0);
        });
      }, ms)
    );
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, recenterToken]);

  useEffect(() => {
    if (!focusRequest) return;
    const host = hostRef.current;
    if (!host) return;

    const run = () => {
      const el = findFocusEl(focusRequest.pathKey);
      if (!el) return;
      const hostRect = host.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const elCx = elRect.left + elRect.width / 2;
      const elCy = elRect.top + elRect.height / 2;
      const hostCx = hostRect.left + hostRect.width / 2;
      const hostCy = hostRect.top + hostRect.height / 2;
      const dx = hostCx - elCx;
      const dy = hostCy - elCy;
      const cur = viewRef.current;
      const scaleFactor = focusRequest.mode === "expand" ? 1.1 : 0.9;
      const nextScale = clampZoom(cur.scale * scaleFactor);
      const cx = hostRect.width / 2;
      const cy = hostRect.height / 2;

      if (animTimerRef.current != null) window.clearTimeout(animTimerRef.current);
      setAnimating(true);
      setView((v) => {
        const x1 = v.x + dx;
        const y1 = v.y + dy;
        const wx = (cx - x1) / v.scale;
        const wy = (cy - y1) / v.scale;
        return {
          x: cx - wx * nextScale,
          y: cy - wy * nextScale,
          scale: nextScale,
        };
      });
      animTimerRef.current = window.setTimeout(() => {
        setAnimating(false);
        animTimerRef.current = null;
      }, 400);
    };

    // 等 DOM 按新 expandDepth 完成布局后再量位置
    let cancelled = false;
    const t = window.setTimeout(() => {
      requestAnimationFrame(() => {
        if (!cancelled) run();
      });
    }, 50);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [focusRequest?.seq]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      const top =
        (typeof document !== "undefined"
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null) || (e.target as Element | null);
      // 右键菜单 / 顶栏 / 编辑条上的滚轮：留给原生滚动，不缩放导图
      if (
        top?.closest?.(
          "[data-mind-ctx], [data-mind-chrome], [data-mind-edit], [data-mind-zoom]"
        )
      ) {
        return;
      }
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      zoomAt(viewRef.current.scale * factor, e.clientX, e.clientY);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={hostRef}
      className={[
        styles.panViewport,
        dragging ? styles.panDragging : "",
        moved ? styles.panMoved : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClickCapture={(e) => {
        // 仅吞掉画布内「拖拽后的误点击」，不要 document 级拦截（否则侧栏 ←EduKG 失效）
        if (!suppressClickRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        suppressClickRef.current = false;
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const t = e.target as HTMLElement | null;
        // 不排除 data-mind-tree：编辑态下整树拖动会禁用，事件需落到此处才能平移画布
        if (
          t?.closest?.(
            "[data-mind-bubble], [data-mind-toggle], [data-mind-zoom], [data-mind-resize], [data-mind-edit], [data-mind-chrome], [data-mind-ctx]"
          )
        )
          return;
        if (animTimerRef.current != null) {
          window.clearTimeout(animTimerRef.current);
          animTimerRef.current = null;
        }
        setAnimating(false);
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origX: view.x,
          origY: view.y,
          moved: false,
        };
        setDragging(true);
        setMoved(false);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.moved && Math.hypot(dx, dy) > 5) {
          d.moved = true;
          setMoved(true);
        }
        setView((v) => ({ ...v, x: d.origX + dx, y: d.origY + dy }));
        if (d.moved) notifyViewChange();
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (d.moved) {
          suppressClickRef.current = true;
          notifyViewChange();
        }
        dragRef.current = null;
        setDragging(false);
        setMoved(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
        setMoved(false);
        notifyViewChange();
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest?.("[data-mind-bubble], [data-mind-toggle], [data-mind-zoom]")) {
          return;
        }
        resetView();
      }}
      title="空白处拖动画布 · 拖动一棵树可单独挪开 · 滚轮缩放 · 双击空白整图适配"
    >
      <div
        className={[styles.panLayer, animating ? styles.panLayerAnim : ""]
          .filter(Boolean)
          .join(" ")}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {children}
      </div>
      <div className={styles.zoomBar} data-mind-zoom="1">
        <button type="button" className={styles.zoomBtn} onClick={() => zoomBy(ZOOM_STEP)} title="放大">
          +
        </button>
        <span className={styles.zoomLabel}>{Math.round(view.scale * 100)}%</span>
        <button type="button" className={styles.zoomBtn} onClick={() => zoomBy(1 / ZOOM_STEP)} title="缩小">
          −
        </button>
        <button type="button" className={styles.zoomBtn} onClick={resetView} title="整图适配">
          复位
        </button>
      </div>
    </div>
  );
}

type LayerMode = "all" | "frontier";

type TreeOpenCmd = {
  seq: number;
  path: number[];
  open: boolean;
  /** true=全部层；false=仅当前节点一层 */
  deep: boolean;
};

function pathIsPrefix(prefix: number[], full: number[]) {
  return prefix.length <= full.length && prefix.every((v, i) => full[i] === v);
}

function MapBranch({
  node,
  path,
  depth,
  maxImp,
  defaultOpen: _defaultOpen,
  expandDepth,
  selectedId,
  onSelect,
  editMode,
  editTool,
  editActions,
  selectedPath,
  moveFromPath,
  linkFromId,
  remoteLinkedIds,
  onEditPick,
  onPick,
  onNodeContextMenu,
  layerMode,
  openCmd,
  onOpenCmd,
  openOverrides,
  onLayout,
  nodeSizes,
  onNodeResize,
  forceOpenPath,
  series = 1,
  growDir = "ltr",
  balanceRoot = true,
}: {
  node: MindmapTreeNode;
  path: number[];
  depth: number;
  maxImp: number;
  defaultOpen: boolean;
  expandDepth: number;
  selectedId?: string | null;
  onSelect?: (node: MindmapTreeNode) => void;
  editMode?: boolean;
  editTool?: EditTool;
  /** 允许右键菜单展示编辑项（通常等于 editEnabled） */
  editActions?: boolean;
  selectedPath?: number[] | null;
  moveFromPath?: number[] | null;
  linkFromId?: string | null;
  remoteLinkedIds?: Set<string>;
  onEditPick?: (node: MindmapTreeNode, path: number[]) => void;
  /** 浏览/选择态：始终点选高亮 */
  onPick?: (node: MindmapTreeNode, path: number[]) => void;
  onNodeContextMenu?: (
    e: ReactMouseEvent,
    node: MindmapTreeNode,
    path: number[],
    handlers: { hasKids: boolean; open: boolean }
  ) => void;
  layerMode?: LayerMode;
  openCmd?: TreeOpenCmd | null;
  onOpenCmd?: (path: number[], open: boolean, deep: boolean) => void;
  /** 节点级展开覆盖（持久化）；无键时回退到 expandDepth 基线 */
  openOverrides?: Record<string, boolean> | null;
  onLayout?: () => void;
  nodeSizes?: Record<string, { w: number; h: number }>;
  onNodeResize?: (nodeId: string, size: { w: number; h: number } | null) => void;
  /** 搜索定位时强制展开到该路径 */
  forceOpenPath?: number[] | null;
  /** business-handoff 域色序号 1–6，子树继承；根下第一层按兄弟下标分色 */
  series?: number;
  /** ltr=向右生长，rtl=向左生长（handoff 左右反向） */
  growDir?: "ltr" | "rtl";
  balanceRoot?: boolean;
}) {
  const shouldForceOpen =
    !!forceOpenPath &&
    forceOpenPath.length > path.length &&
    path.every((v, i) => v === forceOpenPath[i]);
  const pathKey = path.join(".");
  // 只跟 expandDepth / 强制路径走；根上的 defaultOpen 若参与计算，
  // 会导致 expandDepth=0 时 open 仍为 true，全部层收起后「最外层展开」改深度却不触发 revealed 同步。
  const baselineOpen = Boolean(shouldForceOpen || depth < expandDepth);
  const open =
    openOverrides && Object.prototype.hasOwnProperty.call(openOverrides, pathKey)
      ? Boolean(openOverrides[pathKey])
      : baselineOpen;
  /** 展开过一次就保留子树挂载，避免收起再点 + 时按 expandDepth 把深层一并打开 */
  const [revealed, setRevealed] = useState(open);
  const hasKids = (node.children?.length || 0) > 0;
  const kind = nodeKind(node.id, depth, hasKids);
  const imp = Math.max(0.15, Math.min(1, (node.importance || 0) / (maxImp || 1)));
  const nodeSize = nodeSizes?.[node.id] || null;
  const selectedById = !!selectedId && node.id === selectedId;
  const pathSelected =
    !!selectedPath &&
    selectedPath.length === path.length &&
    selectedPath.every((v, i) => v === path[i]);
  const selected = pathSelected || selectedById;
  const moveSource =
    !!moveFromPath &&
    moveFromPath.length === path.length &&
    moveFromPath.every((v, i) => v === path[i]);
  const linkSource = !!linkFromId && linkFromId === node.id;

  useEffect(() => {
    if (open) setRevealed(true);
  }, [open]);

  useEffect(() => {
    if (shouldForceOpen) {
      setRevealed(true);
    }
  }, [shouldForceOpen, forceOpenPath?.join(".")]);

  useEffect(() => {
    if (!openCmd) return;
    if (!pathIsPrefix(openCmd.path, path)) return;
    const isSelf = path.length === openCmd.path.length;
    if (!openCmd.deep && !isSelf) return;
    if (openCmd.open) setRevealed(true);
    else if (openCmd.deep) setRevealed(false);
  }, [openCmd?.seq]);

  // 顶栏改 expandDepth 且无节点覆盖时：展开则挂载，收起则卸挂载
  useEffect(() => {
    if (openOverrides && Object.prototype.hasOwnProperty.call(openOverrides, pathKey)) {
      return;
    }
    if (open) setRevealed(true);
    else setRevealed(false);
  }, [expandDepth, open, openOverrides, pathKey]);

  useEffect(() => {
    onLayout?.();
  }, [open, nodeSize?.w, nodeSize?.h, onLayout]);

  const select = () => {
    if (editMode && editTool && editTool !== "select" && onEditPick) {
      onEditPick(node, path);
      return;
    }
    onPick?.(node, path);
    onSelect?.(node);
  };

  const applyOpen = (next: boolean, deep: boolean) => {
    if (!hasKids) return;
    if (onOpenCmd) {
      onOpenCmd(path, next, deep);
      return;
    }
  };

  const toggleOpen = () => {
    if (!hasKids) return;
    const deep = layerMode === "all";
    applyOpen(!open, deep);
  };

  const onResizePointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const bubble = handle.closest("[data-mind-bubble]") as HTMLElement | null;
    if (!bubble || !onNodeResize) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = bubble.offsetWidth;
    const startH = bubble.offsetHeight;
    const pid = e.pointerId;
    handle.setPointerCapture(pid);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const w = Math.max(72, Math.min(420, startW + (ev.clientX - startX)));
      const h = Math.max(28, Math.min(240, startH + (ev.clientY - startY)));
      onNodeResize(node.id, { w: Math.round(w), h: Math.round(h) });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      try {
        handle.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      onLayout?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const sizeStyle =
    nodeSize && nodeSize.w > 0
      ? {
          width: nodeSize.w,
          height: nodeSize.h > 0 ? nodeSize.h : undefined,
          maxWidth: "none" as const,
        }
      : undefined;

  const seriesIdx = ((Math.max(1, series) - 1) % 6) + 1;
  const lectureLike = node.id.startsWith("__lecture__/");
  const kids = node.children || [];
  /** 根：按子树体量均衡分到左右（非简单对半切） */
  const splitRoot = balanceRoot && depth === 0 && kids.length > 1;
  const rootSplit = splitRoot ? balanceRootSplit(kids) : null;
  const leftKids = rootSplit?.left ?? [];
  const rightKids = rootSplit?.right ?? [];
  const showLeft = Boolean(splitRoot && revealed && leftKids.length);
  const showRight = Boolean(
    revealed && (splitRoot ? rightKids.length : kids.length)
  );
  const showLeftElbow = Boolean(hasKids && open && showLeft);
  const showRightElbow = Boolean(hasKids && open && showRight);
  const showSideElbow = Boolean(hasKids && open && !splitRoot);

  const branchPropsForChild = (c: MindmapTreeNode, i: number, colDir: "ltr" | "rtl") => {
    const childSeries = depth === 0 ? (i % 6) + 1 : seriesIdx;
    return {
      node: c,
      path: [...path, i] as number[],
      depth: depth + 1,
      maxImp,
      defaultOpen: false,
      expandDepth,
      selectedId,
      onSelect,
      editMode,
      editTool,
      editActions,
      selectedPath,
      moveFromPath,
      linkFromId,
      remoteLinkedIds,
      onEditPick,
      onPick,
      onNodeContextMenu,
      layerMode,
      openCmd,
      onOpenCmd,
      openOverrides,
      onLayout,
      nodeSizes,
      onNodeResize,
      forceOpenPath,
      series: childSeries,
      growDir: colDir as "ltr" | "rtl",
      childSeries,
    };
  };

  const renderChildRow = (
    c: MindmapTreeNode,
    i: number,
    j: number,
    totalInCol: number,
    colDir: "ltr" | "rtl"
  ) => {
    const p = branchPropsForChild(c, i, colDir);
    const { childSeries, ...branchProps } = p;
    return (
      <div
        key={`${c.id}-${c.relation || ""}-${c.copy ? "c" : "p"}-${c.weak ? "w" : "s"}-${i}`}
        className={styles.childRow}
        data-mind-child-row="1"
        data-dir={colDir}
        data-first={j === 0 ? "1" : "0"}
        data-last={j === totalInCol - 1 ? "1" : "0"}
        data-weak={c.weak || c.copy || c.salvaged ? "1" : "0"}
        data-series={childSeries}
      >
        <span className={styles.rail} data-mind-spacer="1" aria-hidden />
        <MapBranch {...branchProps} />
      </div>
    );
  };

  const bubbleNode = (
    <div
      className={styles.bubble}
      style={{
        ["--imp" as string]: String(imp),
        ...sizeStyle,
      }}
      data-mind-bubble="1"
      data-node-id={node.id}
      data-node-path={pathKey}
      data-kind={kind}
      data-lecture={lectureLike ? "1" : undefined}
      data-selected={selected ? "1" : "0"}
      data-move-src={moveSource ? "1" : "0"}
      data-link-src={linkSource ? "1" : "0"}
      data-sized={nodeSize ? "1" : "0"}
      data-open={hasKids ? (open ? "1" : "0") : undefined}
      role="button"
      tabIndex={0}
      onClick={select}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPick?.(node, path);
        onSelect?.(node);
        if (!editActions) return;
        onNodeContextMenu?.(e, node, path, {
          hasKids,
          open,
        });
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
        if (
          (e.key === "+" ||
            e.key === "-" ||
            e.key === "ArrowRight" ||
            e.key === "ArrowLeft" ||
            e.key === "ArrowDown" ||
            e.key === "ArrowUp") &&
          hasKids
        ) {
          e.preventDefault();
          if (e.key === "+" || e.key === "ArrowRight" || e.key === "ArrowDown") {
            applyOpen(true, layerMode === "all");
          } else applyOpen(false, layerMode === "all");
        }
      }}
      title={
        [
          editMode
            ? editTool === "move"
              ? moveSource
                ? "已选为移动源，再点目标父节点"
                : "点此作为移动目标父节点"
              : `编辑选中「${node.zh}」`
            : isVirtualNode(node.id)
              ? node.zh
              : `查看「${node.zh}」详情`,
          hasKids
            ? layerMode === "all"
              ? "双击展开/收起全部下层"
              : "双击展开/收起一层"
            : editActions
              ? "右键进入编辑"
              : "",
          editActions ? "右下角拖拽调大小；双击手柄复位" : "",
        ]
          .filter(Boolean)
          .join(" · ")
      }
    >
      <span
        className={styles.bubbleText}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && String(sel).length > 0) {
            e.stopPropagation();
          }
        }}
      >
        {node.zh}
      </span>
      {hasKids ? (
        <button
          type="button"
          className={styles.bubbleToggle}
          data-mind-toggle="1"
          aria-expanded={open}
          title={
            open
              ? layerMode === "all"
                ? "收起全部下层"
                : "收起一层"
              : layerMode === "all"
                ? "展开全部下层"
                : "展开一层"
          }
          onClick={(e) => {
            e.stopPropagation();
            toggleOpen();
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {open ? "−" : "+"}
        </button>
      ) : null}
      {editActions && onNodeResize ? (
        <span
          className={styles.resizeHandle}
          data-mind-resize="1"
          title="拖拽调整大小（双击复位）"
          onPointerDown={onResizePointerDown}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onNodeResize(node.id, null);
          }}
        />
      ) : null}
    </div>
  );

  return (
    <div
      className={styles.branch}
      data-mind-branch="1"
      data-depth={depth}
      data-kind={kind}
      data-series={seriesIdx}
      data-dir={growDir}
      data-split-root={splitRoot ? "1" : undefined}
    >
      {showLeft ? (
        <div
          className={styles.childCol}
          data-mind-child-col="1"
          data-dir="rtl"
          data-open={open ? "1" : "0"}
          hidden={!open}
          aria-hidden={!open}
        >
          {leftKids.map((item, j) =>
            renderChildRow(item.node, item.index, j, leftKids.length, "rtl")
          )}
        </div>
      ) : null}

      <div className={styles.branchMain} data-mind-branch-main="1">
        {splitRoot && showLeftElbow ? (
          <span className={styles.elbow} data-mind-spacer="1" aria-hidden />
        ) : null}
        {bubbleNode}
        {(splitRoot ? showRightElbow : showSideElbow) ? (
          <span className={styles.elbow} data-mind-spacer="1" aria-hidden />
        ) : null}
      </div>

      {showRight ? (
        <div
          className={styles.childCol}
          data-mind-child-col="1"
          data-dir={splitRoot ? "ltr" : growDir}
          data-open={open ? "1" : "0"}
          hidden={!open}
          aria-hidden={!open}
        >
          {splitRoot
            ? rightKids.map((item, j) =>
                renderChildRow(item.node, item.index, j, rightKids.length, "ltr")
              )
            : kids.map((c, j) =>
                renderChildRow(c, j, j, kids.length, growDir)
              )}
        </div>
      ) : null}
    </div>
  );
}

function DraggableTree({
  id,
  resetKey,
  disabled,
  onLayout,
  children,
}: {
  id: string;
  resetKey: string | number;
  disabled?: boolean;
  /** 拖动时同步重测弯曲连线，避免节点与 SVG 分离 */
  onLayout?: () => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const layoutRafRef = useRef<number | null>(null);

  const scheduleLayout = () => {
    if (!onLayout) return;
    if (layoutRafRef.current != null) return;
    layoutRafRef.current = requestAnimationFrame(() => {
      layoutRafRef.current = null;
      onLayout();
    });
  };

  useEffect(() => {
    setPos({ x: 0, y: 0 });
    dragRef.current = null;
    setDragging(false);
    suppressClickRef.current = false;
  }, [resetKey]);

  useEffect(
    () => () => {
      if (layoutRafRef.current != null) cancelAnimationFrame(layoutRafRef.current);
    },
    []
  );

  return (
    <div
      className={[styles.treeSlot, dragging ? styles.treeDragging : ""].filter(Boolean).join(" ")}
      data-mind-tree={id}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      title="拖动整棵树"
      onClickCapture={(e) => {
        if (!suppressClickRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        suppressClickRef.current = false;
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        if (e.button !== 0) return;
        const t = e.target as HTMLElement | null;
        if (t?.closest?.("[data-mind-toggle], [data-mind-zoom], [data-mind-bubble]")) return;
        e.stopPropagation();
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origX: pos.x,
          origY: pos.y,
          moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.moved && Math.hypot(dx, dy) > 5) {
          d.moved = true;
          setDragging(true);
        }
        if (d.moved) {
          setPos({ x: d.origX + dx, y: d.origY + dy });
          scheduleLayout();
        }
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (d.moved) {
          suppressClickRef.current = true;
          onLayout?.();
        }
        dragRef.current = null;
        setDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
        onLayout?.();
      }}
    >
      {children}
    </div>
  );
}

export type MindmapExpandPreset = "course" | "full";

type MindmapTreeProps = {
  doc: MindmapDoc;
  resetKey?: string | number;
  /** @deprecated 使用 expandPreset=\"full\"；仍兼容 deep 课次 */
  expandAll?: boolean;
  /**
   * course：整课默认展开到章+下一层；
   * full：章/课次/视频导图默认全部展开。
   * 各界面展开深度按 expandStorageKey 分别持久化。
   */
  expandPreset?: MindmapExpandPreset;
  /** localStorage 键；整课/章/课次/视频各自独立 */
  expandStorageKey?: string | null;
  selectedId?: string | null;
  onSelect?: (node: MindmapTreeNode) => void;
  /** 点击空白取消选中 */
  onClearSelect?: () => void;
  className?: string;
  /** 开启后显示编辑工具条（添加 / 重命名 / 删节点 / 移子树等） */
  editEnabled?: boolean;
  courseId?: string;
  lectureId?: string;
  /** 课次导图可关闭左右平衡，使所有分支向右展开。 */
  balanceRoot?: boolean;
  onDocChange?: (doc: MindmapDoc) => void;
  /** 清除本地编辑后回调（父级应重新拉取原始导图） */
  onResetEdits?: () => void;
  /** 操作历史（右栏卡片）；不含完整快照 */
  onHistoryChange?: (items: MindmapHistoryItem[]) => void;
  /** 父级可挂载撤销回调 */
  undoRef?: { current: (() => void) | null };
};

function shortOpName(zh: string, max = 10): string {
  const t = String(zh || "").trim() || "节点";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function toHistoryItems(stack: MindmapUndoEntry[]): MindmapHistoryItem[] {
  return stack.map((e) => ({ label: e.label, at: e.at }));
}

type EditTool = "select" | "move";

type NameDialogState = {
  mode: "addChild" | "rename";
  path: number[];
  value: string;
};

type ConfirmDialogState = {
  mode: "deleteSubtree" | "deleteNode";
  path: number[];
  label: string;
};

type Seg = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
};

type TreeEdge = {
  id: string;
  d: string;
  series: number;
  weight: "trunk" | "major" | "branch" | "twig";
  weak?: boolean;
};

type NodeUnderline = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  series: number;
  kind: string;
  selected: boolean;
  lecture?: boolean;
  weak?: boolean;
};

/** business-handoff 同款三次贝塞尔：cy2 贴终点 y，水平控制点偏起点 */
function handoffCubic(x0: number, y0: number, x1: number, y1: number): string {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const cx1 = x0 + dx * 0.143;
  const cy1 = y0 + dy * 0.58;
  const cx2 = x0 + dx * 0.252;
  const cy2 = y0 + dy;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M${r(x0)},${r(y0)} C${r(cx1)},${r(cy1)} ${r(cx2)},${r(cy2)} ${r(x1)},${r(y1)}`;
}

/** 下划线高度（与 CSS ::after 一致），锚点取底边中线 */
function underlineY(localTop: number, localHeight: number, kind: string): number {
  const h =
    kind === "chapter" ? 4 : kind === "topic" ? 2.8 : kind === "leaf" ? 2 : 2.5;
  return localTop + localHeight - h / 2;
}

function edgeWeightForKind(
  parentKind: string | null,
  depth: number
): TreeEdge["weight"] {
  if (parentKind === "root" || depth === 0) return "trunk";
  if (parentKind === "chapter" || depth === 1) return "major";
  if (parentKind === "topic" || depth === 2) return "branch";
  return "twig";
}

export function MindmapTree({
  doc: docProp,
  resetKey = 0,
  expandAll = false,
  expandPreset = "course",
  expandStorageKey = null,
  selectedId = null,
  onSelect,
  onClearSelect,
  className,
  editEnabled = false,
  courseId,
  lectureId,
  balanceRoot = true,
  onDocChange,
  onResetEdits,
  onHistoryChange,
  undoRef,
}: MindmapTreeProps) {
  // 集合论分册：树内「第9–12章」展示为「第1–4章」
  const doc = useMemo(
    () => remapSetTheoryChapterLabelsInDoc(docProp),
    [docProp],
  );
  const resolvedPreset: MindmapExpandPreset =
    expandAll || expandPreset === "full" ? "full" : "course";
  const [editMode, setEditMode] = useState(false);
  const [editTool, setEditTool] = useState<EditTool>("select");
  const [selectedPath, setSelectedPath] = useState<number[] | null>(null);
  const [moveFromPath, setMoveFromPath] = useState<number[] | null>(null);
  const [linkFromId, setLinkFromId] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    node: MindmapTreeNode;
    path: number[];
    hasKids: boolean;
    open: boolean;
  } | null>(null);
  const [layerMode, setLayerMode] = useState<LayerMode>("all");
  const [expandDepth, setExpandDepth] = useState(() => {
    if (expandStorageKey) {
      const stored = readStoredExpandState(expandStorageKey);
      if (stored != null) return stored.depth;
    }
    return resolvedPreset === "full" ? 32 : 2;
  });
  const [openOverrides, setOpenOverrides] = useState<Record<
    string,
    boolean
  > | null>(() => {
    if (!expandStorageKey) return null;
    const stored = readStoredExpandState(expandStorageKey);
    return stored?.open && Object.keys(stored.open).length ? stored.open : null;
  });
  const [openCmd, setOpenCmd] = useState<TreeOpenCmd | null>(null);
  const openCmdSeqRef = useRef(0);
  const focusSeqRef = useRef(0);
  const persistExpandTimer = useRef<number | null>(null);
  /** 树就绪并套用预设/恢复本地态之前，禁止把初始占位 depth 写入 localStorage */
  const [expandHydrated, setExpandHydrated] = useState(false);
  /** 已完成恢复的 storage key；换图时避免把旧展开态写入新 key（整课/骨架串态） */
  const hydratedExpandKeyRef = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<ViewportFocusRequest | null>(
    null
  );
  const [layoutTick, setLayoutTick] = useState(0);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [treeEdges, setTreeEdges] = useState<TreeEdge[]>([]);
  const [nodeUnderlines, setNodeUnderlines] = useState<NodeUnderline[]>([]);
  const [nodeSizes, setNodeSizes] = useState<Record<string, { w: number; h: number }>>(
    {}
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [forceOpenPath, setForceOpenPath] = useState<number[] | null>(null);
  const [exportingPng, setExportingPng] = useState(false);
  const [clipTick, setClipTick] = useState(0);
  const [history, setHistory] = useState<MindmapUndoEntry[]>([]);
  const historyRef = useRef<MindmapUndoEntry[]>([]);
  const docRef = useRef(doc);
  docRef.current = doc;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const trees = useMemo(() => docTrees(doc), [doc]);
  const maxImp = useMemo(() => collectForestMaxImp(trees), [trees]);
  const remoteLinks = useMemo(() => doc.remoteLinks || [], [doc.remoteLinks]);
  const remoteLinkedIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of remoteLinks) {
      s.add(l.from);
      s.add(l.to);
    }
    return s;
  }, [remoteLinks]);

  const flatNodes = useMemo(() => flattenForest(trees), [trees]);
  const key = `${doc.lecture_id}-${resetKey}`;
  const undoScopeKey = String(lectureId || doc.lecture_id || "");
  const siblingOrder = useMemo(
    () => canReorderSibling(trees, selectedPath),
    [trees, selectedPath]
  );
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    // 只按节点显示名（zh）匹配，不匹配实体 id
    const hits = flatNodes.filter(({ node }) => {
      const zh = String(node.zh || "").trim().toLowerCase();
      return Boolean(zh) && zh.includes(q);
    });
    const scored = hits.map((hit, i) => {
      const zh = String(hit.node.zh || "").trim().toLowerCase();
      let score = 100 - i;
      if (zh === q) score = 400;
      else if (zh.startsWith(q)) score = 200;
      return {
        ...hit,
        label: String(hit.node.zh || hit.node.id || ""),
        id: String(hit.node.id || ""),
        score,
      };
    });
    return dedupeEntityMatchesByZh(scored).slice(0, 12);
  }, [flatNodes, searchQuery]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest?.("[data-mind-ctx]")) return;
      setCtxMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setCtxMenu(null);
    };
    const onScroll = (ev: Event) => {
      const t = ev.target as HTMLElement | null;
      // 菜单自身滚动不关闭；页面/画布滚动再关
      if (t?.closest?.("[data-mind-ctx]")) return;
      setCtxMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [ctxMenu]);

  const sizeStorageKey =
    courseId && lectureId
      ? `mindmap-node-sizes:${courseId}:${lectureId}`
      : `mindmap-node-sizes:${doc.lecture_id}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(sizeStorageKey);
      if (!raw) {
        setNodeSizes({});
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, { w: number; h: number }>;
      setNodeSizes(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      setNodeSizes({});
    }
  }, [sizeStorageKey]);

  const onNodeResize = (nodeId: string, size: { w: number; h: number } | null) => {
    setNodeSizes((prev) => {
      const next = { ...prev };
      if (!size) delete next[nodeId];
      else next[nodeId] = size;
      try {
        localStorage.setItem(sizeStorageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  const treeMaxDepth = useMemo(
    () => usefulExpandDepthCap(forestMaxDepth(trees)),
    [trees]
  );

  const persistExpandState = (
    depth: number,
    open: Record<string, boolean> | null
  ) => {
    if (!expandStorageKey) return;
    const payload: MindmapExpandState = { v: 1, depth };
    if (open && Object.keys(open).length) payload.open = open;
    writeStoredExpandState(expandStorageKey, payload);
  };

  const schedulePersistExpand = (
    depth: number,
    open: Record<string, boolean> | null
  ) => {
    if (persistExpandTimer.current != null) {
      window.clearTimeout(persistExpandTimer.current);
    }
    persistExpandTimer.current = window.setTimeout(() => {
      persistExpandState(depth, open);
      persistExpandTimer.current = null;
    }, 50);
  };

  const applyExpandDepth = (next: number) => {
    const value = trees.length
      ? Math.max(0, Math.min(next, treeMaxDepth))
      : Math.max(0, next);
    // 顶栏改全局深度时清空节点覆盖，与原先「全体跟随 expandDepth」一致
    setExpandDepth(value);
    setOpenOverrides(null);
    persistExpandState(value, null);
  };

  // 换图时先停落盘，避免占位 depth 污染存储（整课 ↔ 骨架必须隔离）
  useEffect(() => {
    hydratedExpandKeyRef.current = null;
    setExpandHydrated(false);
    if (persistExpandTimer.current != null) {
      window.clearTimeout(persistExpandTimer.current);
      persistExpandTimer.current = null;
    }
  }, [expandStorageKey, resetKey]);

  // 树就绪后：有本地记录则恢复，否则按界面预设；换界面 / 深度变化时重读
  useEffect(() => {
    if (!trees.length) return;
    const keyNow = expandStorageKey || null;
    const stored = keyNow ? readStoredExpandState(keyNow) : null;
    if (stored != null) {
      setExpandDepth(Math.min(Math.max(0, stored.depth), treeMaxDepth));
      setOpenOverrides(
        stored.open && Object.keys(stored.open).length ? stored.open : null
      );
    } else {
      const next =
        resolvedPreset === "full"
          ? treeMaxDepth
          : Math.min(courseChapterExpandDepth(trees), treeMaxDepth);
      setExpandDepth(next);
      setOpenOverrides(null);
    }
    hydratedExpandKeyRef.current = keyNow;
    setExpandHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trees 内容随 treeMaxDepth 间接变化
  }, [expandStorageKey, resetKey, resolvedPreset, treeMaxDepth]);

  // 深度或节点覆盖变化时落盘（节点级 +/- / 右键深开收）
  useEffect(() => {
    if (!expandStorageKey || !expandHydrated) return;
    // 禁止把上一视图的 depth/open 写入新 key
    if (hydratedExpandKeyRef.current !== expandStorageKey) return;
    schedulePersistExpand(expandDepth, openOverrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandStorageKey, expandDepth, openOverrides, expandHydrated]);

  const persistDisk = (next: MindmapDoc) => {
    if (!courseId) return;
    const isSkeleton =
      String(lectureId || "") === "course:skeleton" ||
      Boolean(doc.meta?.skeleton_view) ||
      String(doc.meta?.outline_key || "") === "__course_skeleton__";
    const chapter = isSkeleton
      ? "__course_skeleton__"
      : doc.meta?.scope === "chapter"
        ? doc.meta.chapter || String(lectureId || "").replace(/^chapter:/, "")
        : String(lectureId || "").startsWith("chapter:")
          ? String(lectureId).slice("chapter:".length)
          : "";
    if (!chapter) return;
    void fetch(withBase("/api/mindmap-outline"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId,
        chapter,
        mindmap: next,
        persist_mindmap: true,
        mindmap_only: true,
        course_skeleton: isSkeleton,
      }),
    }).catch(() => null);
  };

  const bumpLayout = useMemo(() => {
    let raf: number | null = null;
    return () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        setLayoutTick((n) => n + 1);
      });
    };
  }, []);

  const emitOpenCmd = (path: number[], open: boolean, deep: boolean) => {
    openCmdSeqRef.current += 1;
    setOpenCmd({
      seq: openCmdSeqRef.current,
      path,
      open,
      deep,
    });
    setOpenOverrides((prev) => {
      const next = { ...(prev || {}) };
      if (deep) {
        for (const key of collectSubtreePathKeys(trees, path)) {
          next[key] = open;
        }
      } else {
        next[path.join(".")] = open;
      }
      return next;
    });
    bumpLayout();
  };

  /** 顶栏展开/收起：无选中时默认选中根节点，便于聚焦与后续编辑 */
  const ensureChromeSelection = (): number[] | null => {
    if (selectedPath?.length) return selectedPath;
    if (!trees.length) return null;
    const path = [0];
    setSelectedPath(path);
    onSelect?.(trees[0]);
    return path;
  };

  const requestViewportFocus = (
    mode: "expand" | "collapse",
    nextExpandDepth: number,
    pathOverride?: number[] | null
  ) => {
    focusSeqRef.current += 1;
    setFocusRequest({
      seq: focusSeqRef.current,
      pathKey: resolveChromeFocusPath(
        pathOverride ?? selectedPath,
        nextExpandDepth,
        mode
      ),
      mode,
    });
    bumpLayout();
  };

  const doChromeExpand = () => {
    const focusSel = ensureChromeSelection();
    const maxD = treeMaxDepth;
    if (layerMode === "all") {
      // 清掉旧的 deep-close 命令，避免挡住 expandDepth
      openCmdSeqRef.current += 1;
      setOpenCmd({
        seq: openCmdSeqRef.current,
        path: [],
        open: true,
        deep: true,
      });
      applyExpandDepth(maxD);
      setHint("已展开全部层");
      requestViewportFocus("expand", maxD, focusSel);
      return;
    }
    const capped = Math.min(expandDepth, maxD);
    if (capped >= maxD) {
      setHint("已展开到最深层");
      if (expandDepth !== maxD) {
        applyExpandDepth(maxD);
        requestViewportFocus("expand", maxD, focusSel);
      }
      return;
    }
    const next = capped + 1;
    // 清掉全部层收起留下的 deep-close，避免 revealed 被压住
    openCmdSeqRef.current += 1;
    setOpenCmd({
      seq: openCmdSeqRef.current,
      path: [],
      open: true,
      deep: true,
    });
    applyExpandDepth(next);
    setHint(`已多展开一层（深度 ${next}）`);
    requestViewportFocus("expand", next, focusSel);
  };

  const doChromeCollapse = () => {
    const focusSel = ensureChromeSelection();
    const maxD = treeMaxDepth;
    if (layerMode === "all") {
      // depth 0：整课/多根也只留顶层节点气泡（+/- 为 +）
      openCmdSeqRef.current += 1;
      setOpenCmd({
        seq: openCmdSeqRef.current,
        path: [],
        open: false,
        deep: true,
      });
      applyExpandDepth(0);
      setHint("已收起全部层");
      requestViewportFocus("collapse", 0, focusSel);
      return;
    }
    // 先钳到真实树深，避免 99→98 这种「看起来没反应」
    const capped = Math.min(expandDepth, maxD);
    if (capped <= 0) {
      setHint("已是最外层");
      if (expandDepth !== 0) {
        applyExpandDepth(0);
        requestViewportFocus("collapse", 0, focusSel);
      }
      return;
    }
    const next = capped - 1;
    applyExpandDepth(next);
    setHint(`已收起一层（深度 ${next}）`);
    requestViewportFocus("collapse", next, focusSel);
  };

  const pushHistory = (snapshot: MindmapDoc, label: string) => {
    const entry: MindmapUndoEntry = {
      doc: snapshot,
      label: label || "编辑",
      at: Date.now(),
    };
    const next = [...historyRef.current.slice(-49), entry];
    historyRef.current = next;
    setHistory(next);
    if (undoScopeKey) saveMindmapUndoStack(undoScopeKey, next);
    onHistoryChange?.(toHistoryItems(next));
  };

  const persist = (
    next: MindmapDoc,
    opts?: { recordHistory?: boolean; label?: string }
  ) => {
    if (opts?.recordHistory !== false) {
      const cur = docRef.current;
      pushHistory(
        withForest(
          cur,
          cloneForest(docForest(cur)),
          (cur.remoteLinks || []).map((l) => ({ ...l })),
          {
            idRedirects: { ...(cur.id_redirects || {}) },
            conceptLinks: (cur.concept_links || []).map((l) => ({ ...l })),
          }
        ),
        opts?.label || "编辑"
      );
    }
    onDocChange?.(next);
    if (courseId && lectureId) {
      saveMindmapEditPatch(courseId, lectureId, {
        trees: docTrees(next),
        remoteLinks: next.remoteLinks || [],
        id_redirects: next.id_redirects,
        concept_links: next.concept_links,
      });
    }
    persistDisk(next);
  };

  const doUndo = () => {
    const h = historyRef.current;
    if (!h.length) {
      setHint("没有可撤销的操作");
      return;
    }
    const last = h[h.length - 1];
    const rest = h.slice(0, -1);
    historyRef.current = rest;
    setHistory(rest);
    if (undoScopeKey) saveMindmapUndoStack(undoScopeKey, rest);
    onHistoryChange?.(toHistoryItems(rest));
    onDocChange?.(last.doc);
    if (courseId && lectureId) {
      saveMindmapEditPatch(courseId, lectureId, {
        trees: docTrees(last.doc),
        remoteLinks: last.doc.remoteLinks || [],
        id_redirects: last.doc.id_redirects,
        concept_links: last.doc.concept_links,
      });
    }
    persistDisk(last.doc);
    bumpLayout();
    setHint(
      rest.length
        ? `已撤销「${last.label}」（还可撤销 ${rest.length} 步）`
        : `已撤销「${last.label}」`
    );
  };
  const doUndoRef = useRef(doUndo);
  doUndoRef.current = doUndo;
  if (undoRef) undoRef.current = doUndo;
  const prevUndoScopeRef = useRef<string | null>(null);

  useEffect(() => {
    setSelectedPath(null);
    setMoveFromPath(null);
    setLinkFromId(null);
    setHint("");
    setEditTool("select");
    setSearchQuery("");
    setSearchOpen(false);
    setForceOpenPath(null);
    const prev = prevUndoScopeRef.current;
    const switchedOrFirst = prev === null || prev !== undoScopeKey;
    prevUndoScopeRef.current = undoScopeKey;
    if (switchedOrFirst) {
      const restored = undoScopeKey ? loadMindmapUndoStack(undoScopeKey) : [];
      historyRef.current = restored;
      setHistory(restored);
      onHistoryChange?.(toHistoryItems(restored));
    } else {
      if (undoScopeKey) clearMindmapUndoStack(undoScopeKey);
      historyRef.current = [];
      setHistory([]);
      onHistoryChange?.([]);
    }
  }, [key, undoScopeKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (!historyRef.current.length) return;
      e.preventDefault();
      doUndoRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!searchRef.current?.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    bumpLayout();
    const t = window.setTimeout(() => bumpLayout(), 160);
    return () => window.clearTimeout(t);
  }, [key, bumpLayout, expandDepth, openOverrides]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => bumpLayout());
    ro.observe(el);
    return () => ro.disconnect();
  }, [bumpLayout, key]);

  useEffect(() => {
    const root = canvasRef.current;
    if (!root) {
      setSegs([]);
      setTreeEdges([]);
      setNodeUnderlines([]);
      return;
    }

    // 清掉可能残留的漂移 transform
    root.querySelectorAll<HTMLElement>("[data-mind-bubble]").forEach((el) => {
      el.style.removeProperty("transform");
    });

    const rr = root.getBoundingClientRect();
    const sx = root.offsetWidth > 0 ? rr.width / root.offsetWidth : 1;
    const sy = root.offsetHeight > 0 ? rr.height / root.offsetHeight : 1;
    const localBox = (el: HTMLElement) => {
      const er = el.getBoundingClientRect();
      return {
        left: (er.left - rr.left) / sx,
        top: (er.top - rr.top) / sy,
        width: er.width / sx,
        height: er.height / sy,
        right: (er.right - rr.left) / sx,
        bottom: (er.bottom - rr.top) / sy,
      };
    };

    const layout =
      (wrapRef.current?.getAttribute("data-layout") as "lr" | "tb") || "lr";

    const nextEdges: TreeEdge[] = [];
    const nextUnderlines: NodeUnderline[] = [];
    const seenUl = new Set<string>();

    root.querySelectorAll<HTMLElement>("[data-mind-bubble]").forEach((bubble) => {
      const path = bubble.getAttribute("data-node-path") || "";
      if (!path || seenUl.has(path)) return;
      const kind = bubble.getAttribute("data-kind") || "leaf";
      if (kind === "root") return;
      seenUl.add(path);
      const box = localBox(bubble);
      const y = underlineY(box.top, box.height, kind);
      const series = Math.max(
        1,
        Math.min(
          6,
          Number(bubble.closest("[data-series]")?.getAttribute("data-series") || 1)
        )
      );
      nextUnderlines.push({
        id: `ul-${path}`,
        x1: box.left,
        y1: y,
        x2: box.right,
        y2: y,
        series,
        kind,
        selected: bubble.getAttribute("data-selected") === "1",
        lecture: bubble.getAttribute("data-lecture") === "1",
        weak:
          bubble.closest("[data-mind-child-row]")?.getAttribute("data-weak") === "1",
      });
    });

    const nearer = (
      a: { x: number; y: number },
      b: { x: number; y: number },
      tx: number,
      ty: number
    ) => (Math.hypot(a.x - tx, a.y - ty) <= Math.hypot(b.x - tx, b.y - ty) ? a : b);

    root.querySelectorAll<HTMLElement>("[data-mind-branch='1']").forEach((branch, bi) => {
      const parentBubble = branch.querySelector<HTMLElement>(
        ":scope > [data-mind-branch-main] > [data-mind-bubble]"
      );
      if (!parentBubble) return;
      const childCols = branch.querySelectorAll<HTMLElement>(
        ":scope > [data-mind-child-col][data-open='1']"
      );
      if (!childCols.length) return;
      const parentKind = branch.getAttribute("data-kind");
      const depth = Number(branch.getAttribute("data-depth") || 0);
      const weight = edgeWeightForKind(parentKind, depth);
      const pb = localBox(parentBubble);
      const pKind = parentBubble.getAttribute("data-kind") || "topic";
      const pUy = underlineY(pb.top, pb.height, pKind);
      const pCx = pb.left + pb.width / 2;
      const pCy = pb.top + pb.height / 2;
      /** 根→子：从根节点中心引出，避免都挤在下划线左右端 */
      const fromRootCenter = pKind === "root" || parentKind === "root";

      childCols.forEach((childCol, ci) => {
        if (childCol.hidden) return;
        const colDir =
          (childCol.getAttribute("data-dir") as "ltr" | "rtl" | null) || "ltr";
        childCol.querySelectorAll<HTMLElement>(":scope > [data-mind-child-row]").forEach((row, ri) => {
          const childBubble = row.querySelector<HTMLElement>(
            ":scope > [data-mind-branch] > [data-mind-branch-main] > [data-mind-bubble]"
          );
          if (!childBubble) return;
          const cb = localBox(childBubble);
          const cKind = childBubble.getAttribute("data-kind") || "leaf";
          const cUy = underlineY(cb.top, cb.height, cKind);
          const cCx = cb.left + cb.width / 2;
          const cCy = cb.top + cb.height / 2;
          let parentPt: { x: number; y: number };
          let childPt: { x: number; y: number };
          if (layout === "tb") {
            parentPt = fromRootCenter
              ? { x: pCx, y: pCy }
              : { x: pCx, y: pb.bottom };
            childPt = { x: cCx, y: cb.top };
          } else if (colDir === "rtl") {
            parentPt = fromRootCenter
              ? { x: pCx, y: pCy }
              : { x: pb.left, y: pUy };
            childPt = nearer(
              { x: cb.left, y: cUy },
              { x: cb.right, y: cUy },
              parentPt.x,
              parentPt.y
            );
          } else {
            parentPt = fromRootCenter
              ? { x: pCx, y: pCy }
              : nearer(
                  { x: pb.left, y: pUy },
                  { x: pb.right, y: pUy },
                  cCx,
                  cCy
                );
            childPt = nearer(
              { x: cb.left, y: cUy },
              { x: cb.right, y: cUy },
              parentPt.x,
              parentPt.y
            );
          }
          nextEdges.push({
            id: `te-${bi}-${ci}-${ri}-${childBubble.getAttribute("data-node-path") || ri}`,
            d: handoffCubic(parentPt.x, parentPt.y, childPt.x, childPt.y),
            series: Math.max(1, Math.min(6, Number(row.getAttribute("data-series") || 1))),
            weight,
            weak: row.getAttribute("data-weak") === "1",
          });
        });
      });
    });
    setTreeEdges(nextEdges);
    setNodeUnderlines(nextUnderlines);

    if (!remoteLinks.length) {
      setSegs([]);
      return;
    }
    const next: Seg[] = [];
    for (const link of remoteLinks) {
      const a = root.querySelector(
        `[data-node-id="${CSS.escape(link.from)}"]`
      ) as HTMLElement | null;
      const b = root.querySelector(
        `[data-node-id="${CSS.escape(link.to)}"]`
      ) as HTMLElement | null;
      if (!a || !b) continue;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      next.push({
        id: link.id,
        x1: (ar.left + ar.width / 2 - rr.left) / sx,
        y1: (ar.top + ar.height / 2 - rr.top) / sy,
        x2: (br.left + br.width / 2 - rr.left) / sx,
        y2: (br.top + br.height / 2 - rr.top) / sy,
        label: link.label,
      });
    }
    setSegs(next);
  }, [
    remoteLinks,
    layoutTick,
    expandAll,
    trees,
    key,
    openOverrides,
    expandDepth,
    selectedId,
    selectedPath,
  ]);

  const focusPath = (node: MindmapTreeNode, path: number[]) => {
    setSelectedPath(path);
    setForceOpenPath(path);
    onSelect?.(node);
    bumpLayout();
    window.setTimeout(() => {
      const el = canvasRef.current?.querySelector(
        `[data-node-path="${CSS.escape(path.join("."))}"]`
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }, 60);
  };

  const onPick = (node: MindmapTreeNode, path: number[]) => {
    setSelectedPath(path);
    if (editMode) setHint(`已选「${node.zh}」`);
    else setHint("");
  };

  const onEditPick = (node: MindmapTreeNode, path: number[]) => {
    if (!editMode) return;
    if (editTool === "select") {
      onPick(node, path);
      onSelect?.(node);
      return;
    }
    if (editTool === "move") {
      if (!moveFromPath) {
        setMoveFromPath(path);
        setSelectedPath(path);
        setHint(`移动源「${node.zh}」→ 再点目标父节点`);
        return;
      }
      if (pathEquals(moveFromPath, path)) {
        setHint("不能移到自身，请另选父节点或取消");
        return;
      }
      const moved = moveSubtree(trees, moveFromPath, path);
      if (!moved) {
        setHint("无法移动（不能移入自己的子树）");
        return;
      }
      const fromNode = getAt(trees, moveFromPath);
      const nextDoc = withForest(doc, moved, remoteLinks);
      persist(nextDoc, {
        label: `移动「${shortOpName(fromNode?.zh || "子树")}」→「${shortOpName(node.zh)}」`,
      });
      bumpLayout();
      setMoveFromPath(null);
      setSelectedPath(path);
      setHint(`已将子树移到「${node.zh}」下`);
      setEditTool("select");
      return;
    }
  };

  const resolveEditPath = (pathOverride?: number[] | null) =>
    pathOverride && pathOverride.length ? pathOverride : selectedPath;

  const openNameDialog = (
    mode: NameDialogState["mode"],
    pathOverride?: number[] | null,
  ) => {
    const path = resolveEditPath(pathOverride);
    if (!path) {
      setHint(mode === "addChild" ? "请先选中父节点" : "请先选中节点");
      return;
    }
    const target = getAt(trees, path);
    if (!target) return;
    setSelectedPath(path);
    setConfirmDialog(null);
    setNameDialog({
      mode,
      path,
      value: mode === "rename" ? target.zh || "" : "",
    });
    setHint("");
    window.setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const applyNameDialog = () => {
    if (!nameDialog) return;
    const trimmed = nameDialog.value.trim();
    if (!trimmed) {
      setHint("名称不能为空");
      return;
    }
    const path = nameDialog.path;
    if (nameDialog.mode === "addChild") {
      const nextTrees = addChildNode(trees, path, makeLeafNode(trimmed));
      if (!nextTrees) {
        setHint("添加失败");
        return;
      }
      persist(withForest(doc, nextTrees, remoteLinks), {
        label: `添加子节点「${shortOpName(trimmed)}」`,
      });
      bumpLayout();
      setHint(`已添加子节点「${trimmed}」`);
      setNameDialog(null);
      return;
    }
    const target = getAt(trees, path);
    if (!target) {
      setNameDialog(null);
      return;
    }
    if (trimmed === (target.zh || "").trim()) {
      setHint("名称未改变");
      setNameDialog(null);
      return;
    }
    const nextTrees = renameNode(trees, path, trimmed);
    if (!nextTrees) {
      setHint("重命名失败");
      return;
    }
    persist(withForest(doc, nextTrees, remoteLinks), {
      label: `重命名「${shortOpName(target.zh)}」→「${shortOpName(trimmed)}」`,
    });
    bumpLayout();
    setHint(`已重命名为「${trimmed}」`);
    setNameDialog(null);
  };

  const doAddChild = (pathOverride?: number[] | null) => {
    openNameDialog("addChild", pathOverride);
  };

  const doRename = (pathOverride?: number[] | null) => {
    openNameDialog("rename", pathOverride);
  };

  const executeDeleteSubtree = (path: number[]) => {
    const target = getAt(trees, path);
    if (!target) return;
    if (isVirtualNode(target.id) && path.length === 1 && trees.length === 1) {
      setHint("不能删除唯一虚根");
      return;
    }
    const nextTrees = deleteSubtree(trees, path);
    if (!nextTrees) {
      setHint("删除失败");
      return;
    }
    const gone = collectSubtreeIds(target);
    const canonical =
      parentIdAtPath(trees, path) || nextTrees[0]?.id || null;
    persist(withRetargetedIdentity(doc, nextTrees, gone, canonical, remoteLinks), {
      label: `删子树「${shortOpName(target.zh)}」`,
    });
    bumpLayout();
    setSelectedPath(null);
    setConfirmDialog(null);
    setHint(`已删除子树「${target.zh}」`);
  };

  const executeDetachNode = (path: number[]) => {
    const target = getAt(trees, path);
    if (!target) return;
    if (isVirtualNode(target.id) && path.length === 1 && trees.length === 1) {
      setHint("不能删除唯一虚根");
      return;
    }
    const nextTrees = deleteNodePromoteChildren(trees, path);
    if (!nextTrees) {
      setHint("删节点失败");
      return;
    }
    const canonical =
      parentIdAtPath(trees, path) || nextTrees[0]?.id || null;
    persist(
      withRetargetedIdentity(doc, nextTrees, [target.id], canonical, remoteLinks),
      {
        label: `删节点「${shortOpName(target.zh)}」`,
      }
    );
    bumpLayout();
    setSelectedPath(null);
    setConfirmDialog(null);
    setHint(`已删除「${target.zh}」，其子节点已挂到父节点`);
  };

  const doDeleteSubtree = (pathOverride?: number[] | null) => {
    const path = resolveEditPath(pathOverride);
    if (!path) {
      setHint("请先选中要删除的子树");
      return;
    }
    const target = getAt(trees, path);
    if (!target) return;
    if (isVirtualNode(target.id) && path.length === 1 && trees.length === 1) {
      setHint("不能删除唯一虚根");
      return;
    }
    setNameDialog(null);
    setSelectedPath(path);
    setConfirmDialog({
      mode: "deleteSubtree",
      path,
      label: target.zh || "节点",
    });
    setHint("");
  };

  const doDetachNode = (pathOverride?: number[] | null) => {
    const path = resolveEditPath(pathOverride);
    if (!path) {
      setHint("请先选中节点");
      return;
    }
    const target = getAt(trees, path);
    if (!target) return;
    if (isVirtualNode(target.id) && path.length === 1 && trees.length === 1) {
      setHint("不能删除唯一虚根");
      return;
    }
    setNameDialog(null);
    setSelectedPath(path);
    setConfirmDialog({
      mode: "deleteNode",
      path,
      label: target.zh || "节点",
    });
    setHint("");
  };

  const applyConfirmDialog = () => {
    if (!confirmDialog) return;
    if (confirmDialog.mode === "deleteSubtree") {
      executeDeleteSubtree(confirmDialog.path);
    } else {
      executeDetachNode(confirmDialog.path);
    }
  };

  const doCopy = (cut: boolean, pathOverride?: number[] | null) => {
    const path = resolveEditPath(pathOverride);
    if (!path) {
      setHint("请先选中子树");
      return;
    }
    const target = getAt(trees, path);
    if (!target) return;
    saveMindmapClipboard({
      subtree: target,
      sourceLectureId: lectureId || doc.lecture_id,
      cut,
    });
    setClipTick((n) => n + 1);
    if (cut) {
      if (isVirtualNode(target.id) && path.length === 1 && trees.length === 1) {
        setHint("不能剪切唯一虚根");
        clearMindmapClipboard();
        setClipTick((n) => n + 1);
        return;
      }
      const nextTrees = deleteSubtree(trees, path);
      if (!nextTrees) {
        setHint("剪切失败");
        return;
      }
      const gone = collectSubtreeIds(target);
      const canonical =
        parentIdAtPath(trees, path) || nextTrees[0]?.id || null;
      persist(withRetargetedIdentity(doc, nextTrees, gone, canonical, remoteLinks), {
        label: `剪切「${shortOpName(target.zh)}」`,
      });
      setSelectedPath(null);
      bumpLayout();
      setHint(`已剪切「${target.zh}」，可到其他导图粘贴`);
    } else {
      setHint(`已复制「${target.zh}」，可跨导图粘贴`);
    }
  };

  const doPaste = (pathOverride?: number[] | null) => {
    const path = resolveEditPath(pathOverride);
    if (!path) {
      setHint("请先选中粘贴目标父节点");
      return;
    }
    const clip = loadMindmapClipboard();
    if (!clip?.subtree) {
      setHint("剪贴板为空");
      return;
    }
    const pasted = cloneSubtreeWithNewIds(clip.subtree);
    const nextTrees = addChildNode(trees, path, pasted);
    if (!nextTrees) {
      setHint("粘贴失败");
      return;
    }
    persist(withForest(doc, nextTrees, remoteLinks), {
      label: `粘贴「${shortOpName(pasted.zh)}」`,
    });
    bumpLayout();
    if (clip.cut) {
      clearMindmapClipboard();
      setClipTick((n) => n + 1);
    }
    setHint(`已粘贴「${pasted.zh}」到当前节点下`);
  };

  const doExport = async () => {
    const host = canvasRef.current;
    if (!host) {
      window.alert("导出失败：当前导图尚未就绪，请稍后重试");
      return;
    }
    setExportingPng(true);
    try {
      // 导出前强制重测连线，避免布局滞后导致线与节点错位/缺失
      bumpLayout();
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const ok = await exportMindmapPng(host, {
        filename: `mindmap-${String(lectureId || doc.lecture_id).replace(/[^\w\u4e00-\u9fff-]+/g, "_")}.png`,
        background: "transparent",
        scale: 2,
      });
      if (!ok) window.alert("导出失败：无法生成图片，请稍后重试或缩小展开范围后再试");
    } finally {
      setExportingPng(false);
    }
  };

  /** 关闭编辑条；改动已在每次操作时写入本地补丁 / 磁盘 */
  const doSaveEdits = () => {
    setHint("已保存修改");
    setEditMode(false);
    setEditTool("select");
    setMoveFromPath(null);
    setLinkFromId(null);
    setNameDialog(null);
    setConfirmDialog(null);
    setCtxMenu(null);
  };

  const doResetEdits = () => {
    if (courseId && lectureId) clearMindmapEditPatch(courseId, lectureId);
    if (undoScopeKey) clearMindmapUndoStack(undoScopeKey);
    setHint("");
    setEditMode(false);
    setSelectedPath(null);
    setMoveFromPath(null);
    setLinkFromId(null);
    setNameDialog(null);
    setConfirmDialog(null);
    setCtxMenu(null);
    historyRef.current = [];
    setHistory([]);
    onHistoryChange?.([]);
    onResetEdits?.();
  };

  const doReorder = (delta: -1 | 1, pathOverride?: number[] | null) => {
    const path = resolveEditPath(pathOverride);
    if (!path) {
      setHint("请先选中要调整顺序的节点");
      return;
    }
    const target = getAt(trees, path);
    const result = reorderSibling(trees, path, delta);
    if (!result) {
      setHint(delta < 0 ? "已经是同级第一个" : "已经是同级最后一个");
      return;
    }
    persist(withForest(doc, result.trees, remoteLinks), {
      label: `${delta < 0 ? "上移" : "下移"}「${shortOpName(target?.zh || "节点")}」`,
    });
    bumpLayout();
    setSelectedPath(result.path);
    setHint(delta < 0 ? "已上移" : "已下移");
  };

  const openNodeContextMenu = (
    e: ReactMouseEvent,
    node: MindmapTreeNode,
    path: number[],
    handlers: { hasKids: boolean; open: boolean }
  ) => {
    if (!editEnabled) return;
    setSelectedPath(path);
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      node,
      path,
      hasKids: handlers.hasKids,
      open: handlers.open,
    });
  };

  return (
    <div
      ref={wrapRef}
      className={[styles.mindCanvasWrap, className].filter(Boolean).join(" ")}
      data-layout="lr"
      data-edit={editMode ? "1" : "0"}
    >
      <div className={styles.chromeBar} data-mind-chrome="1">
        <div className={styles.entitySearch} ref={searchRef}>
          <div className={styles.entitySearchField}>
            <input
              type="search"
              className={styles.entitySearchInput}
              value={searchQuery}
              placeholder="搜索节点…"
              aria-label="搜索节点"
              autoComplete="off"
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  return;
                }
                if (e.key === "Enter" && searchMatches[0]) {
                  e.preventDefault();
                  focusPath(searchMatches[0].node, searchMatches[0].path);
                  setSearchOpen(false);
                }
              }}
            />
            {searchQuery.trim() ? (
              <button
                type="button"
                className={styles.entitySearchClear}
                aria-label="清除搜索"
                title="清除"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchQuery("");
                  setSearchOpen(false);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
          {searchOpen && searchQuery.trim() ? (
            <div className={styles.entitySearchMenu} role="listbox">
              {searchMatches.length === 0 ? (
                <div className={styles.entitySearchEmpty}>无匹配节点</div>
              ) : (
                searchMatches.map(({ node, path }) => (
                  <button
                    key={`${node.id}-${path.join(".")}`}
                    type="button"
                    role="option"
                    className={styles.entitySearchItem}
                    onClick={() => {
                      focusPath(node, path);
                      setSearchOpen(false);
                    }}
                    title={node.id}
                  >
                    <span>{node.zh}</span>
                    <em>{node.id.includes("/") ? node.id.split("/").slice(0, 2).join("/") : `L${path.length}`}</em>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        <div className={styles.chromeEnd}>
          <div
            className={styles.layerMode}
            role="group"
            aria-label="展开收起范围"
            title="展开/收起作用范围：全部层或当前最外层（一层）"
          >
            <button
              type="button"
              className={`${styles.layerModeBtn} ${layerMode === "all" ? styles.layerModeOn : ""}`}
              aria-pressed={layerMode === "all"}
              onClick={() => setLayerMode("all")}
            >
              全部层
            </button>
            <button
              type="button"
              className={`${styles.layerModeBtn} ${layerMode === "frontier" ? styles.layerModeOn : ""}`}
              aria-pressed={layerMode === "frontier"}
              onClick={() => setLayerMode("frontier")}
            >
              当前最外层
            </button>
          </div>
          <button
            type="button"
            className={styles.editBtn}
            title={
              layerMode === "all"
                ? "展开全部层"
                : "多展开一层（当前最外层）"
            }
            onClick={doChromeExpand}
          >
            展开
          </button>
          <button
            type="button"
            className={styles.editBtn}
            title={
              layerMode === "all"
                ? "收起全部层"
                : "收起一层（当前最外层）"
            }
            onClick={doChromeCollapse}
          >
            收起
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={exportingPng}
            title="导出当前导图画布为 PNG"
            onClick={() => void doExport()}
          >
            {exportingPng ? "导出中…" : "导出图片"}
          </button>
        </div>
      </div>

      {editEnabled && editMode ? (
        <div className={styles.editBar} data-mind-edit="1">
          <button
            type="button"
            className={`${styles.editBtn} ${editTool === "select" ? styles.editBtnOn : ""}`}
            onClick={() => {
              setEditTool("select");
              setMoveFromPath(null);
              setLinkFromId(null);
            }}
          >
            选择
          </button>
          <button type="button" className={styles.editBtn} disabled={!selectedPath} onClick={() => doAddChild()}>
            添加子节点
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={!selectedPath}
            title="修改选中节点名称"
            onClick={() => doRename()}
          >
            重命名
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={!siblingOrder.up}
            title="同级上移"
            onClick={() => doReorder(-1)}
          >
            上移
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={!siblingOrder.down}
            title="同级下移"
            onClick={() => doReorder(1)}
          >
            下移
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={!selectedPath}
            onClick={() => doDeleteSubtree()}
            title="删除整棵子树"
          >
            删子树
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={!selectedPath}
            onClick={() => doDetachNode()}
            title="删除节点，其子节点挂到原父节点"
          >
            删节点
          </button>
          <button
            type="button"
            className={`${styles.editBtn} ${editTool === "move" ? styles.editBtnOn : ""}`}
            onClick={() => {
              setEditTool("move");
              setLinkFromId(null);
              setMoveFromPath(selectedPath);
              setHint(
                selectedPath
                  ? "已带上当前选中为移动源，再点目标父节点"
                  : "先点移动源节点，再点目标父节点"
              );
            }}
          >
            移子树
          </button>
          <button
            type="button"
            className={`${styles.editBtn} ${styles.editBtnOn}`}
            title="关闭编辑工具条（改动已随操作自动保存）"
            onClick={doSaveEdits}
          >
            保存修改
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={!history.length}
            title="撤销上一步编辑（Ctrl+Z）"
            onClick={doUndo}
          >
            撤销{history.length ? ` (${history.length})` : ""}
          </button>
          {hint ? <span className={styles.editHint}>{hint}</span> : null}
          {nameDialog ? (
            <div className={styles.nameDialog} data-mind-edit="1">
              <span className={styles.nameDialogLabel}>
                {nameDialog.mode === "addChild" ? "子节点名称" : "节点名称"}
              </span>
              <input
                ref={nameInputRef}
                className={styles.nameDialogInput}
                value={nameDialog.value}
                placeholder={nameDialog.mode === "addChild" ? "输入名称后回车" : "修改名称"}
                onChange={(e) =>
                  setNameDialog((prev) =>
                    prev ? { ...prev, value: e.target.value } : prev,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyNameDialog();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNameDialog(null);
                  }
                }}
              />
              <button type="button" className={styles.editBtn} onClick={applyNameDialog}>
                确定
              </button>
              <button
                type="button"
                className={styles.editBtn}
                onClick={() => setNameDialog(null)}
              >
                取消
              </button>
            </div>
          ) : null}
          {confirmDialog ? (
            <div className={styles.nameDialog} data-mind-edit="1">
              <span className={styles.nameDialogLabel}>
                {confirmDialog.mode === "deleteSubtree"
                  ? `确认删除子树「${confirmDialog.label}」及全部子孙？`
                  : `确认删除节点「${confirmDialog.label}」？子节点将挂到父节点下`}
              </span>
              <button
                type="button"
                className={`${styles.editBtn} ${styles.ctxMenuDanger}`}
                onClick={applyConfirmDialog}
              >
                确认删除
              </button>
              <button
                type="button"
                className={styles.editBtn}
                onClick={() => setConfirmDialog(null)}
              >
                取消
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <PanViewport
        resetKey={key}
        recenterToken={
          expandHydrated ? `${key}:${expandDepth}:${trees.length}` : `${key}:pending`
        }
        focusRequest={focusRequest}
        onViewChange={bumpLayout}
      >
        <div
          className={styles.canvas}
          key={key}
          data-forest={trees.length > 1 ? "1" : "0"}
          ref={canvasRef}
          onClick={(e) => {
            const t = e.target as HTMLElement | null;
            if (
              t?.closest?.(
                "[data-mind-bubble], [data-mind-toggle], [data-mind-resize], [data-mind-chrome], [data-mind-ctx], [data-mind-zoom], [data-mind-edit]"
              )
            ) {
              return;
            }
            setSelectedPath(null);
            setHint("");
            onClearSelect?.();
          }}
        >
          {treeEdges.length || segs.length || nodeUnderlines.length ? (
            <svg className={styles.remoteSvg} aria-hidden>
              {treeEdges.map((e) => {
                const weightCls =
                  e.weight === "trunk"
                    ? styles.treeEdgeTrunk
                    : e.weight === "major"
                      ? styles.treeEdgeMajor
                      : e.weight === "branch"
                        ? styles.treeEdgeBranch
                        : styles.treeEdgeTwig;
                return (
                  <path
                    key={e.id}
                    d={e.d}
                    className={`${styles.treeEdge} ${weightCls}`}
                    data-series={e.series}
                    data-weak={e.weak ? "1" : "0"}
                    fill="none"
                  />
                );
              })}
              {nodeUnderlines.map((u) => (
                <line
                  key={u.id}
                  x1={u.x1}
                  y1={u.y1}
                  x2={u.x2}
                  y2={u.y2}
                  className={styles.nodeUnderline}
                  data-series={u.series}
                  data-kind={u.kind}
                  data-selected={u.selected ? "1" : "0"}
                  data-lecture={u.lecture ? "1" : "0"}
                  data-weak={u.weak ? "1" : "0"}
                />
              ))}
              {segs.map((s) => {
                const mx = (s.x1 + s.x2) / 2;
                const my = (s.y1 + s.y2) / 2 - 18;
                return (
                  <g key={s.id}>
                    <path
                      d={`M ${s.x1} ${s.y1} Q ${mx} ${my} ${s.x2} ${s.y2}`}
                      className={styles.remotePath}
                      fill="none"
                    />
                  </g>
                );
              })}
            </svg>
          ) : null}
          {trees.map((tree, i) => (
            <DraggableTree
              key={`${tree.id}-${i}`}
              id={`${tree.id}-${i}`}
              resetKey={key}
              disabled={editMode}
              onLayout={bumpLayout}
            >
              <MapBranch
                node={tree}
                path={[i]}
                depth={0}
                maxImp={maxImp}
                defaultOpen
                expandDepth={expandDepth}
                selectedId={selectedId}
                onSelect={onSelect}
                editMode={editMode}
                editTool={editTool}
                editActions={editEnabled}
                selectedPath={selectedPath}
                moveFromPath={moveFromPath}
                linkFromId={linkFromId}
                remoteLinkedIds={remoteLinkedIds}
                onEditPick={editEnabled ? onEditPick : undefined}
                onPick={onPick}
                onNodeContextMenu={editEnabled ? openNodeContextMenu : undefined}
                layerMode={layerMode}
                openCmd={openCmd}
                onOpenCmd={emitOpenCmd}
                openOverrides={openOverrides}
                onLayout={bumpLayout}
                nodeSizes={nodeSizes}
                onNodeResize={editEnabled ? onNodeResize : undefined}
                forceOpenPath={forceOpenPath}
                series={(i % 6) + 1}
                growDir="ltr"
                balanceRoot={balanceRoot}
              />
            </DraggableTree>
          ))}
        </div>
      </PanViewport>

      {ctxMenu ? (
        <div
          className={styles.ctxMenu}
          data-mind-ctx="1"
          role="menu"
          style={{
            left: Math.min(ctxMenu.x, typeof window !== "undefined" ? window.innerWidth - 220 : ctxMenu.x),
            top: Math.min(ctxMenu.y, typeof window !== "undefined" ? window.innerHeight - 360 : ctxMenu.y),
          }}
          onWheel={(e) => {
            // 阻断冒泡，避免画布把滚轮当成缩放
            e.stopPropagation();
          }}
        >
          <div className={styles.ctxMenuTitle} title={ctxMenu.node.id}>
            {ctxMenu.node.zh}
          </div>
          {editEnabled ? (
            <button
              type="button"
              className={styles.ctxMenuItem}
              role="menuitem"
              onClick={() => {
                const { path, node } = ctxMenu;
                setCtxMenu(null);
                setSelectedPath(path);
                setEditMode(true);
                setEditTool("select");
                setMoveFromPath(null);
                setLinkFromId(null);
                setNameDialog(null);
                setConfirmDialog(null);
                onSelect?.(node);
                setHint(`编辑「${node.zh}」：用顶部按钮操作`);
              }}
            >
              编辑
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
