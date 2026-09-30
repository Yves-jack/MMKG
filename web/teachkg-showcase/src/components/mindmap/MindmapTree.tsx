import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  addChildNode,
  addRemoteLink,
  addSiblingNode,
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
  pathEquals,
  removeRemoteLink,
  reorderSibling,
  saveMindmapClipboard,
  saveMindmapEditPatch,
  saveMindmapUndoStack,
  withForest,
  type MindmapHistoryItem,
  type MindmapUndoEntry,
} from "@/lib/apps/mindmapEdits";
import { exportMindmapPng } from "@/lib/kg/exportMindmapPng";
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
  meta?: {
    chapter?: string;
    root_zh?: string;
    virtual_root?: boolean;
    n_trees?: number;
    n_entities_raw?: number;
    n_edges_raw?: number;
    attached_orphans?: number;
    n_chapters?: number;
    /** course | chapter | lecture */
    scope?: "course" | "chapter" | "lecture";
    lecture_ids?: string[];
    source?: "kg" | "summary+kg" | "review+kg";
    /** course=chapters 拼接；lecture=从章裁剪 */
    composed_from?: "chapters" | "chapter_slice";
    /** textbook_toc | summary | manual */
    skeleton_source?: string;
    n_sections?: number;
  };
};

function nodeKind(id: string, depth: number): "root" | "chapter" | "topic" | "leaf" {
  if (id.startsWith("__course__/") || depth === 0) return "root";
  if (id.startsWith("__chapter__/")) return "chapter";
  if (id.startsWith("__section__/") || id.startsWith("__topic__/")) return "topic";
  if (depth <= 2) return "topic";
  return "leaf";
}

function collectMaxImp(node: MindmapTreeNode): number {
  let m = node.importance || 0;
  for (const c of node.children || []) m = Math.max(m, collectMaxImp(c));
  return m;
}

function collectForestMaxImp(trees: MindmapTreeNode[]): number {
  return trees.reduce((m, n) => Math.max(m, collectMaxImp(n)), 0);
}

function docTrees(doc: MindmapDoc): MindmapTreeNode[] {
  return doc.roots?.length ? doc.roots : doc.root ? [doc.root] : [];
}

export type MindmapLayout = "lr";

function isVirtualNode(id: string): boolean {
  return (
    id.startsWith("__course__/") ||
    id.startsWith("__chapter__/") ||
    id.startsWith("__lecture__/") ||
    id.startsWith("__section__/") ||
    id.startsWith("__topic__/") ||
    id.startsWith("__salvage__/")
  );
}

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 2.8;
const ZOOM_STEP = 1.12;

function clampZoom(v: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
}

/** 画布平移 + 滚轮缩放；移动超过阈值时吞掉随后的 click，避免误触展开 */
function PanViewport({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey: string | number;
}) {
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const [moved, setMoved] = useState(false);
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

  const zoomAt = (nextScale: number, clientX: number, clientY: number) => {
    const host = hostRef.current;
    if (!host) {
      setView((v) => ({ ...v, scale: clampZoom(nextScale) }));
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
  };

  const zoomBy = (factor: number) => {
    const host = hostRef.current;
    const rect = host?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    zoomAt(viewRef.current.scale * factor, cx, cy);
  };

  const resetView = () => setView({ x: 0, y: 0, scale: 1 });

  useEffect(() => {
    setView({ x: 0, y: 0, scale: 1 });
    dragRef.current = null;
    setDragging(false);
    setMoved(false);
    suppressClickRef.current = false;
  }, [resetKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
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
            "[data-mind-bubble], [data-mind-toggle], [data-mind-zoom], [data-mind-resize], [data-mind-edit], [data-mind-chrome]"
          )
        )
          return;
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
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (d.moved) suppressClickRef.current = true;
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
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest?.("[data-mind-bubble], [data-mind-toggle], [data-mind-zoom]")) {
          return;
        }
        resetView();
      }}
      title="空白处拖动画布 · 拖动一棵树可单独挪开 · 滚轮缩放 · 双击空白复位"
    >
      <div
        className={styles.panLayer}
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
        <button type="button" className={styles.zoomBtn} onClick={resetView} title="复位">
          复位
        </button>
      </div>
    </div>
  );
}

function MapBranch({
  node,
  path,
  depth,
  maxImp,
  defaultOpen,
  expandDepth,
  selectedId,
  onSelect,
  editMode,
  editTool,
  selectedPath,
  moveFromPath,
  linkFromId,
  remoteLinkedIds,
  onEditPick,
  onPick,
  onLayout,
  nodeSizes,
  onNodeResize,
  forceOpenPath,
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
  editTool?: "select" | "move" | "link";
  selectedPath?: number[] | null;
  moveFromPath?: number[] | null;
  linkFromId?: string | null;
  remoteLinkedIds?: Set<string>;
  onEditPick?: (node: MindmapTreeNode, path: number[]) => void;
  /** 浏览/选择态：始终点选高亮 */
  onPick?: (node: MindmapTreeNode, path: number[]) => void;
  onLayout?: () => void;
  nodeSizes?: Record<string, { w: number; h: number }>;
  onNodeResize?: (nodeId: string, size: { w: number; h: number } | null) => void;
  /** 搜索定位时强制展开到该路径 */
  forceOpenPath?: number[] | null;
}) {
  const shouldForceOpen =
    !!forceOpenPath &&
    forceOpenPath.length > path.length &&
    path.every((v, i) => v === forceOpenPath[i]);
  const initialOpen = Boolean(shouldForceOpen || defaultOpen || depth < expandDepth);
  const [open, setOpen] = useState(initialOpen);
  /** 展开过一次就保留子树挂载，避免收起再点 + 时按 expandDepth 把深层一并打开 */
  const [revealed, setRevealed] = useState(initialOpen);
  const hasKids = (node.children?.length || 0) > 0;
  const kind = nodeKind(node.id, depth);
  const imp = Math.max(0.15, Math.min(1, (node.importance || 0) / (maxImp || 1)));
  const pathKey = path.join(".");
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
    // 响应「全部展开 / 收起导图 / 初始深度」：浅层保持展开，深层强制收起并卸挂载
    const want = Boolean(shouldForceOpen || defaultOpen || depth < expandDepth);
    setOpen(want);
    if (want) setRevealed(true);
    else setRevealed(false);
  }, [expandDepth, defaultOpen, shouldForceOpen, depth]);

  useEffect(() => {
    if (shouldForceOpen) {
      setOpen(true);
      setRevealed(true);
    }
  }, [shouldForceOpen, forceOpenPath?.join(".")]);

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

  const toggleOpen = () => {
    if (!hasKids) return;
    setOpen((v) => {
      const next = !v;
      if (next) setRevealed(true);
      return next;
    });
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

  return (
    <div className={styles.branch} data-depth={depth} data-kind={kind}>
      <div className={styles.branchMain}>
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
          data-selected={selected ? "1" : "0"}
          data-move-src={moveSource ? "1" : "0"}
          data-link-src={linkSource ? "1" : "0"}
          data-sized={nodeSize ? "1" : "0"}
          data-open={hasKids ? (open ? "1" : "0") : undefined}
          role="button"
          tabIndex={0}
          onClick={select}
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
                setRevealed(true);
                setOpen(true);
              } else setOpen(false);
            }
          }}
          title={
            [
              editMode
                ? editTool === "move"
                  ? moveSource
                    ? "已选为移动源，再点目标父节点"
                    : "点此作为移动目标父节点"
                  : editTool === "link"
                    ? linkSource
                      ? "已选起点，再点终点建立横向连接"
                      : "点此作为横向连接端点"
                    : `编辑选中「${node.zh}」`
                : isVirtualNode(node.id)
                  ? node.zh
                  : `查看「${node.zh}」详情`,
              hasKids ? "双击展开/收起" : "",
              "右下角拖拽调大小；双击手柄复位",
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
              title={open ? "折叠子节点" : "展开子节点"}
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
          <span
            className={styles.resizeHandle}
            data-mind-resize="1"
            title="拖拽调整大小（双击复位）"
            onPointerDown={onResizePointerDown}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onNodeResize?.(node.id, null);
            }}
          />
        </div>
        {hasKids && open ? <span className={styles.elbow} aria-hidden /> : null}
      </div>

      {hasKids && revealed ? (
        <div
          className={styles.childCol}
          data-open={open ? "1" : "0"}
          hidden={!open}
          aria-hidden={!open}
        >
          {node.children.map((c, i) => (
            <div
              key={`${c.id}-${c.relation || ""}-${c.copy ? "c" : "p"}-${c.weak ? "w" : "s"}-${i}`}
              className={styles.childRow}
              data-first={i === 0 ? "1" : "0"}
              data-last={i === node.children.length - 1 ? "1" : "0"}
              data-weak={c.weak || c.copy || c.salvaged ? "1" : "0"}
            >
              <span className={styles.rail} aria-hidden />
              <MapBranch
                node={c}
                path={[...path, i]}
                depth={depth + 1}
                maxImp={maxImp}
                defaultOpen={false}
                expandDepth={expandDepth}
                selectedId={selectedId}
                onSelect={onSelect}
                editMode={editMode}
                editTool={editTool}
                selectedPath={selectedPath}
                moveFromPath={moveFromPath}
                linkFromId={linkFromId}
                remoteLinkedIds={remoteLinkedIds}
                onEditPick={onEditPick}
                onPick={onPick}
                onLayout={onLayout}
                nodeSizes={nodeSizes}
                onNodeResize={onNodeResize}
                forceOpenPath={forceOpenPath}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DraggableTree({
  id,
  resetKey,
  disabled,
  children,
}: {
  id: string;
  resetKey: string | number;
  disabled?: boolean;
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

  useEffect(() => {
    setPos({ x: 0, y: 0 });
    dragRef.current = null;
    setDragging(false);
    suppressClickRef.current = false;
  }, [resetKey]);

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
        if (d.moved) setPos({ x: d.origX + dx, y: d.origY + dy });
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        if (d.moved) suppressClickRef.current = true;
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
      }}
    >
      {children}
    </div>
  );
}

type MindmapTreeProps = {
  doc: MindmapDoc;
  resetKey?: string | number;
  expandAll?: boolean;
  selectedId?: string | null;
  onSelect?: (node: MindmapTreeNode) => void;
  className?: string;
  /** 开启后显示编辑工具条（删节点 / 移子树 / 横向连接） */
  editEnabled?: boolean;
  courseId?: string;
  lectureId?: string;
  onDocChange?: (doc: MindmapDoc) => void;
  /** 清除本地编辑后回调（父级应重新拉取原始导图） */
  onResetEdits?: () => void;
  /** 操作历史（右栏卡片）；不含完整快照 */
  onHistoryChange?: (items: MindmapHistoryItem[]) => void;
  /** 父级调用逐步撤销（与 Ctrl+Z / 工具条一致） */
  undoRef?: { current: (() => void) | null };
};

function shortOpName(zh: string, max = 10): string {
  const t = String(zh || "").trim() || "节点";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function toHistoryItems(stack: MindmapUndoEntry[]): MindmapHistoryItem[] {
  return stack.map((e) => ({ label: e.label, at: e.at }));
}

type EditTool = "select" | "move" | "link";

type Seg = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
};

export function MindmapTree({
  doc,
  resetKey = 0,
  expandAll = false,
  selectedId = null,
  onSelect,
  className,
  editEnabled = false,
  courseId,
  lectureId,
  onDocChange,
  onResetEdits,
  onHistoryChange,
  undoRef,
}: MindmapTreeProps) {
  const [editMode, setEditMode] = useState(false);
  const [editTool, setEditTool] = useState<EditTool>("select");
  const [selectedPath, setSelectedPath] = useState<number[] | null>(null);
  const [moveFromPath, setMoveFromPath] = useState<number[] | null>(null);
  const [linkFromId, setLinkFromId] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [layoutTick, setLayoutTick] = useState(0);
  const [segs, setSegs] = useState<Seg[]>([]);
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
  const remoteLinks = doc.remoteLinks || [];
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
    return flatNodes
      .filter(({ node }) => {
        const zh = String(node.zh || "").toLowerCase();
        const id = String(node.id || "").toLowerCase();
        return zh.includes(q) || id.includes(q);
      })
      .slice(0, 24);
  }, [flatNodes, searchQuery]);

  const hasClipboard = useMemo(() => Boolean(loadMindmapClipboard()), [clipTick, key]);

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
  // 默认/收起：展开 depth 0–1，可见节点到 depth 2（即 0–2 层）；不再默认打开第 3 层
  const expandDepth = expandAll ? 8 : 2;

  const persistDisk = (next: MindmapDoc) => {
    if (!courseId) return;
    const chapter =
      doc.meta?.scope === "chapter"
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
      }),
    }).catch(() => null);
  };

  const bumpLayout = useMemo(() => {
    let t: number | null = null;
    return () => {
      if (t != null) window.clearTimeout(t);
      t = window.setTimeout(() => setLayoutTick((n) => n + 1), 40);
    };
  }, []);

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
          (cur.remoteLinks || []).map((l) => ({ ...l }))
        ),
        opts?.label || "编辑"
      );
    }
    onDocChange?.(next);
    if (courseId && lectureId) {
      saveMindmapEditPatch(courseId, lectureId, {
        trees: docTrees(next),
        remoteLinks: next.remoteLinks || [],
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
    const root = canvasRef.current;
    if (!root || !remoteLinks.length) {
      setSegs([]);
      return;
    }
    const rr = root.getBoundingClientRect();
    const sx = root.offsetWidth > 0 ? rr.width / root.offsetWidth : 1;
    const sy = root.offsetHeight > 0 ? rr.height / root.offsetHeight : 1;
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
  }, [remoteLinks, layoutTick, expandAll, trees, key]);

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
    setHint(`已选「${node.zh}」`);
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
    if (editTool === "link") {
      if (!linkFromId) {
        setLinkFromId(node.id);
        setSelectedPath(path);
        setHint(`连接起点「${node.zh}」→ 再点终点`);
        return;
      }
      if (linkFromId === node.id) {
        setHint("不能连接到自身");
        return;
      }
      const links = addRemoteLink(remoteLinks, linkFromId, node.id, "相关");
      const nextDoc = withForest(doc, trees, links);
      persist(nextDoc, { label: `横向连接 →「${shortOpName(node.zh)}」` });
      bumpLayout();
      setLinkFromId(null);
      setHint(`已添加横向连接 →「${node.zh}」`);
      setEditTool("select");
    }
  };

  const doAddChild = () => {
    if (!selectedPath) {
      setHint("请先选中父节点");
      return;
    }
    const name = window.prompt("子节点名称");
    if (!name?.trim()) return;
    const nextTrees = addChildNode(trees, selectedPath, makeLeafNode(name.trim()));
    if (!nextTrees) {
      setHint("添加失败");
      return;
    }
    persist(withForest(doc, nextTrees, remoteLinks), {
      label: `添加子节点「${shortOpName(name)}」`,
    });
    bumpLayout();
    setHint(`已添加子节点「${name.trim()}」`);
  };

  const doAddSibling = () => {
    if (!selectedPath) {
      setHint("请先选中节点");
      return;
    }
    const name = window.prompt("同级节点名称");
    if (!name?.trim()) return;
    const nextTrees = addSiblingNode(trees, selectedPath, makeLeafNode(name.trim()));
    if (!nextTrees) {
      setHint("添加失败");
      return;
    }
    persist(withForest(doc, nextTrees, remoteLinks), {
      label: `添加同级「${shortOpName(name)}」`,
    });
    bumpLayout();
    setHint(`已添加同级「${name.trim()}」`);
  };

  const doDeleteSubtree = () => {
    if (!selectedPath) {
      setHint("请先选中要删除的子树");
      return;
    }
    const target = getAt(trees, selectedPath);
    if (!target) return;
    if (isVirtualNode(target.id) && selectedPath.length === 1 && trees.length === 1) {
      setHint("不能删除唯一虚根");
      return;
    }
    if (!window.confirm(`删除子树「${target.zh}」及其全部子孙？`)) return;
    const nextTrees = deleteSubtree(trees, selectedPath);
    if (!nextTrees) {
      setHint("删除失败");
      return;
    }
    const gone = new Set<string>();
    const mark = (n: MindmapTreeNode) => {
      gone.add(n.id);
      (n.children || []).forEach(mark);
    };
    mark(target);
    const links = remoteLinks.filter((l) => !gone.has(l.from) && !gone.has(l.to));
    persist(withForest(doc, nextTrees, links), {
      label: `删子树「${shortOpName(target.zh)}」`,
    });
    bumpLayout();
    setSelectedPath(null);
    setHint(`已删除子树「${target.zh}」`);
  };

  const doDetachNode = () => {
    if (!selectedPath) {
      setHint("请先选中节点");
      return;
    }
    const target = getAt(trees, selectedPath);
    if (!target) return;
    if (isVirtualNode(target.id) && selectedPath.length === 1 && trees.length === 1) {
      setHint("不能删除唯一虚根");
      return;
    }
    const nextTrees = deleteNodePromoteChildren(trees, selectedPath);
    if (!nextTrees) {
      setHint("拆节点失败");
      return;
    }
    const links = remoteLinks.filter((l) => l.from !== target.id && l.to !== target.id);
    persist(withForest(doc, nextTrees, links), {
      label: `拆节点「${shortOpName(target.zh)}」`,
    });
    bumpLayout();
    setSelectedPath(null);
    setHint(`已拆掉「${target.zh}」，其子节点已挂到父节点`);
  };

  const doCopy = (cut: boolean) => {
    if (!selectedPath) {
      setHint("请先选中子树");
      return;
    }
    const target = getAt(trees, selectedPath);
    if (!target) return;
    saveMindmapClipboard({
      subtree: target,
      sourceLectureId: lectureId || doc.lecture_id,
      cut,
    });
    setClipTick((n) => n + 1);
    if (cut) {
      if (isVirtualNode(target.id) && selectedPath.length === 1 && trees.length === 1) {
        setHint("不能剪切唯一虚根");
        clearMindmapClipboard();
        setClipTick((n) => n + 1);
        return;
      }
      const nextTrees = deleteSubtree(trees, selectedPath);
      if (!nextTrees) {
        setHint("剪切失败");
        return;
      }
      const gone = new Set<string>();
      const mark = (n: MindmapTreeNode) => {
        gone.add(n.id);
        (n.children || []).forEach(mark);
      };
      mark(target);
      const links = remoteLinks.filter((l) => !gone.has(l.from) && !gone.has(l.to));
      persist(withForest(doc, nextTrees, links), {
        label: `剪切「${shortOpName(target.zh)}」`,
      });
      setSelectedPath(null);
      bumpLayout();
      setHint(`已剪切「${target.zh}」，可到其他导图粘贴`);
    } else {
      setHint(`已复制「${target.zh}」，可跨导图粘贴`);
    }
  };

  const doPaste = () => {
    if (!selectedPath) {
      setHint("请先选中粘贴目标父节点");
      return;
    }
    const clip = loadMindmapClipboard();
    if (!clip?.subtree) {
      setHint("剪贴板为空");
      return;
    }
    const pasted = cloneSubtreeWithNewIds(clip.subtree);
    const nextTrees = addChildNode(trees, selectedPath, pasted);
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
      const ok = await exportMindmapPng(host, {
        filename: `mindmap-${String(lectureId || doc.lecture_id).replace(/[^\w\u4e00-\u9fff-]+/g, "_")}.png`,
      });
      if (!ok) window.alert("导出失败：当前导图尚未就绪，请稍后重试");
    } finally {
      setExportingPng(false);
    }
  };

  const doResetEdits = () => {
    if (courseId && lectureId) clearMindmapEditPatch(courseId, lectureId);
    if (undoScopeKey) clearMindmapUndoStack(undoScopeKey);
    setHint("");
    setEditMode(false);
    setSelectedPath(null);
    setMoveFromPath(null);
    setLinkFromId(null);
    historyRef.current = [];
    setHistory([]);
    onHistoryChange?.([]);
    onResetEdits?.();
  };

  const doReorder = (delta: -1 | 1) => {
    if (!selectedPath) {
      setHint("请先选中要调整顺序的节点");
      return;
    }
    const target = getAt(trees, selectedPath);
    const result = reorderSibling(trees, selectedPath, delta);
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

  const removeLink = (id: string) => {
    persist(withForest(doc, trees, removeRemoteLink(remoteLinks, id)), {
      label: "删除横向连接",
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
          {editEnabled ? (
            <label className={styles.editToggle}>
              <input
                type="checkbox"
                checked={editMode}
                onChange={(e) => {
                  const on = e.target.checked;
                  setEditMode(on);
                  setEditTool("select");
                  setMoveFromPath(null);
                  setLinkFromId(null);
                  setHint(on ? "编辑已开：选节点后可增删移 / 复制粘贴" : "");
                }}
              />
              <span>编辑</span>
            </label>
          ) : null}
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
          <button type="button" className={styles.editBtn} disabled={!selectedPath} onClick={doAddChild}>
            添加子节点
          </button>
          <button type="button" className={styles.editBtn} disabled={!selectedPath} onClick={doAddSibling}>
            添加同级
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
            onClick={doDeleteSubtree}
            title="删除整棵子树"
          >
            删子树
          </button>
          <button
            type="button"
            className={styles.editBtn}
            disabled={!selectedPath}
            onClick={doDetachNode}
            title="删除节点，其子节点挂到原父节点"
          >
            拆节点
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
          <button type="button" className={styles.editBtn} disabled={!selectedPath} onClick={() => doCopy(false)}>
            复制
          </button>
          <button type="button" className={styles.editBtn} disabled={!selectedPath} onClick={() => doCopy(true)}>
            剪切
          </button>
          <button type="button" className={styles.editBtn} disabled={!selectedPath || !hasClipboard} onClick={doPaste}>
            粘贴
          </button>
          <button
            type="button"
            className={`${styles.editBtn} ${editTool === "link" ? styles.editBtnOn : ""}`}
            onClick={() => {
              setEditTool("link");
              setMoveFromPath(null);
              setLinkFromId(null);
              setHint("先点起点，再点终点，添加横向远程连接");
            }}
          >
            横向连接
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
          <button type="button" className={styles.editBtn} onClick={doResetEdits}>
            清除编辑
          </button>
          {hint ? <span className={styles.editHint}>{hint}</span> : null}
          {remoteLinks.length ? (
            <div className={styles.linkList}>
              {remoteLinks.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={styles.linkChip}
                  title="点击删除此横向连接"
                  onClick={() => removeLink(l.id)}
                >
                  {l.from.split("/")[0]} ↔ {l.to.split("/")[0]} ×
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : hint && !editMode ? (
        <div className={styles.editBar}>
          <span className={styles.editHint}>{hint}</span>
        </div>
      ) : null}

      <PanViewport resetKey={key}>
        <div
          className={styles.canvas}
          key={key}
          data-forest={trees.length > 1 ? "1" : "0"}
          ref={canvasRef}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedPath(null);
              setHint("");
            }
          }}
        >
          {segs.length ? (
            <svg className={styles.remoteSvg} aria-hidden>
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
                selectedPath={selectedPath}
                moveFromPath={moveFromPath}
                linkFromId={linkFromId}
                remoteLinkedIds={remoteLinkedIds}
                onEditPick={onEditPick}
                onPick={onPick}
                onLayout={bumpLayout}
                nodeSizes={nodeSizes}
                onNodeResize={onNodeResize}
                forceOpenPath={forceOpenPath}
              />
            </DraggableTree>
          ))}
        </div>
      </PanViewport>
    </div>
  );
}
