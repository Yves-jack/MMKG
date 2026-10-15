import {
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
  type CSSProperties,
} from "react";
import type { MindmapDoc, MindmapTreeNode } from "./MindmapTree";
import { filterMindmapByMastery } from "@/lib/kg/mindmapMasteryFilter.mjs";
import {
  collapseMindmap,
  masteryScore,
  masteryVisual,
} from "@/lib/kg/mindmapMasteryBinding.mjs";
import { preparePackedMindmap } from "@/lib/kg/packedMindmapLayout.mjs";
import { usePackedMindmapLayout } from "@/lib/kg/usePackedMindmapLayout";
import styles from "./StudentMasteryMindmap.module.css";

type ViewNode = MindmapTreeNode & {
  __sourcePath?: number[];
  __hasChildren?: boolean;
  __open?: boolean;
};

type Bounds = { x: number; y: number; width: number; height: number };
const FONT_FAMILY =
  '"Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif';
let measurementContext: CanvasRenderingContext2D | null = null;
const textMeasurements = new Map<string, number>();
function textWidth(label: string, size: number): number {
  const key = `${size}:${label}`;
  const cached = textMeasurements.get(key);
  if (cached != null) return cached;
  measurementContext ||= document.createElement("canvas").getContext("2d");
  if (measurementContext)
    measurementContext.font = `${size >= 34 ? 600 : 400} ${size}px ${FONT_FAMILY}`;
  const width =
    measurementContext?.measureText(label).width ?? [...label].length * size;
  textMeasurements.set(key, width);
  return width;
}

function branchClass(node: MindmapTreeNode, index: number): string {
  // Domain names only choose paint; placement is driven solely by subtree size.
  if (node.zh.includes("图论")) return styles.branchGraph;
  if (node.zh.includes("集合论")) return styles.branchSet;
  if (node.zh.includes("逻辑")) return styles.branchLogic;
  return [
    styles.branch0,
    styles.branch1,
    styles.branch2,
    styles.branch3,
    styles.branch4,
    styles.branch5,
  ][index % 6];
}

export function StudentMasteryMindmap({
  doc,
  mastery,
  selectedId,
  selectedPath,
  onSelect,
  onClearSelect,
  message,
  scope = "personal",
  learnerCount,
  compact = false,
  onRefresh,
}: {
  doc: MindmapDoc;
  mastery: Readonly<Record<string, number>>;
  selectedId?: string | null;
  selectedPath?: readonly number[] | null;
  onSelect?: (node: MindmapTreeNode) => void;
  onClearSelect?: () => void;
  message?: string;
  scope?: "personal" | "class_average";
  learnerCount?: number;
  compact?: boolean;
  onRefresh?: () => void;
}) {
  const [percent, setPercent] = useState(100);
  const [expandDepth, setExpandDepth] = useState(2);
  const [openPaths, setOpenPaths] = useState<Record<string, boolean>>({});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<{
    id: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const filtered = useMemo(
    () =>
      filterMindmapByMastery(doc, mastery, percent, {
        selectedId,
        selectedPath,
        balanceDomains: true,
      }),
    [doc, mastery, percent, selectedId, selectedPath],
  );
  const collapsedDoc = useMemo(
    () => collapseMindmap(filtered.doc, expandDepth, openPaths),
    [filtered.doc, expandDepth, openPaths],
  );
  const packedInput = useMemo(
    () => preparePackedMindmap(collapsedDoc, textWidth),
    [collapsedDoc],
  );
  const packed = usePackedMindmapLayout(packedInput);
  const layout = packed.layout || {
    nodes: [],
    edges: [],
    domains: [],
    bounds: { x: -500, y: -300, width: 1000, height: 600 },
  };

  const counts = filtered.stats.totalByStatus;
  const setDepth = (depth: number) => {
    setExpandDepth(depth);
    setOpenPaths({});
  };
  const toggleNode = (node: ViewNode) => {
    if (!node.__hasChildren) return;
    const key = node.__sourcePath?.join(".") || "";
    setOpenPaths((previous) => ({ ...previous, [key]: !node.__open }));
  };
  const fitted: Bounds = {
    x: layout.bounds.x + pan.x + (layout.bounds.width * (1 - 1 / zoom)) / 2,
    y: layout.bounds.y + pan.y + (layout.bounds.height * (1 - 1 / zoom)) / 2,
    width: layout.bounds.width / zoom,
    height: layout.bounds.height / zoom,
  };
  const setRequestedPercent = (value: number) =>
    setPercent(Math.max(0, Math.min(100, Math.round(value))));
  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    pointer.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  };
  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const current = pointer.current;
    if (!current || current.id !== event.pointerId) return;
    if (
      !current.moved &&
      Math.hypot(
        event.clientX - current.startX,
        event.clientY - current.startY,
      ) >= 4
    ) {
      if (!current.moved)
        event.currentTarget.setPointerCapture(event.pointerId);
      current.moved = true;
      setDragging(true);
    }
    const matrix = event.currentTarget.getScreenCTM();
    if (current.moved && matrix) {
      const inverse = matrix.inverse();
      const before = new DOMPoint(current.x, current.y).matrixTransform(
        inverse,
      );
      const after = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        inverse,
      );
      setPan((previous) => ({
        x: previous.x - (after.x - before.x),
        y: previous.y - (after.y - before.y),
      }));
    }
    current.x = event.clientX;
    current.y = event.clientY;
  };
  const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    if (pointer.current.moved)
      window.setTimeout(() => {
        pointer.current = null;
      }, 0);
    else pointer.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom((previous) =>
      Math.max(
        0.5,
        Math.min(12, previous * (event.deltaY < 0 ? 1.12 : 1 / 1.12)),
      ),
    );
  };

  return (
    <div
      className={`${styles.root} ${compact ? styles.compact : ""}`}
      aria-busy={!packed.layout}
    >
      <div className={styles.toolbar}>
        <span className={styles.counts}>
          显示 {layout.nodes.length} / {filtered.stats.totalNodes} 个节点
        </span>
        <div className={styles.summary} role="status" aria-label="掌握情况统计">
          <span>
            {scope === "class_average"
              ? `全班平均 · ${learnerCount ?? 0} 名学生`
              : "我的掌握情况"}
          </span>
          <span>已掌握 {counts.mastered}</span>
          <span>学习中 {counts.learning}</span>
          <span>未学习 {counts.unlearned}</span>
          <span>暂无记录 {counts.unrecorded}</span>
        </div>
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={() =>
              setDepth(Math.min(doc.max_depth + 1, expandDepth + 1))
            }
          >
            展开一层
          </button>
          <button
            type="button"
            className={styles.controlButton}
            onClick={() => setDepth(Math.max(0, expandDepth - 1))}
          >
            收起一层
          </button>
          <button
            type="button"
            className={styles.controlButton}
            onClick={() => setDepth(doc.max_depth + 1)}
          >
            全部展开
          </button>
          {onRefresh ? (
            <button
              type="button"
              className={styles.controlButton}
              onClick={onRefresh}
            >
              刷新分数
            </button>
          ) : null}
          <label
            className={styles.controlLabel}
            htmlFor="mindmap-visible-percent"
          >
            显示比例
          </label>
          <input
            id="mindmap-visible-percent"
            className={styles.percentSlider}
            type="range"
            min="0"
            max="100"
            step="1"
            value={percent}
            onChange={(event) =>
              setRequestedPercent(Number(event.target.value))
            }
          />
          <input
            className={styles.controlSelect}
            aria-label="显示节点百分比"
            type="number"
            min="0"
            max="100"
            step="1"
            value={percent}
            onChange={(event) =>
              setRequestedPercent(Number(event.target.value))
            }
            style={{ width: 62 }}
          />
          <span className={styles.percentValue}>%</span>
          <button
            type="button"
            className={styles.controlButton}
            onClick={() => setZoom((value) => Math.min(12, value * 1.25))}
          >
            ＋
          </button>
          <button
            type="button"
            className={styles.controlButton}
            onClick={() => setZoom((value) => Math.max(0.5, value / 1.25))}
          >
            －
          </button>
          <button
            type="button"
            className={styles.controlButton}
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            适合窗口
          </button>
        </div>
      </div>
      {!packed.layout ? (
        <p className={styles.caption} role="status">
          {packed.error || "正在按子树轮廓优化布局…"}
        </p>
      ) : null}
      <div className={styles.canvas}>
        <svg
          className={`${styles.viewport} ${dragging ? styles.dragging : ""}`}
          viewBox={`${fitted.x} ${fitted.y} ${fitted.width} ${fitted.height}`}
          role="img"
          aria-label={`${scope === "class_average" ? "全班平均" : "学生"}知识点掌握思维导图，显示 ${layout.nodes.length} 个节点`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          onClick={(event) => {
            if (event.target === event.currentTarget && !pointer.current?.moved)
              onClearSelect?.();
          }}
        >
          {layout.edges.map((edge) => {
            const domain = layout.domains[edge.branch];
            return (
              <path
                key={edge.key}
                d={edge.path}
                className={`${styles.edge} ${edge.depth === 0 ? styles.edgeTrunk : edge.depth === 1 ? styles.edgeMajor : styles.edgeBranch} ${domain ? branchClass(domain, edge.branch) : ""}`}
              />
            );
          })}
          {layout.nodes.map((placed, index) => {
            const node = placed.node as ViewNode;
            const score = masteryScore(node, mastery);
            const visual = masteryVisual(score);
            const sourcePath = node.__sourcePath;
            const selected = selectedPath
              ? sourcePath?.join(".") === selectedPath.join(".")
              : node.id === selectedId;
            const domain = layout.domains[placed.branch];
            const nodeClass =
              placed.depth === 0
                ? styles.nodeRoot
                : placed.depth === 1
                  ? styles.nodeDomain
                  : placed.depth === 2
                    ? styles.nodeChapter
                    : "";
            const start =
              placed.side === -1 && placed.depth > 0 ? placed.extra + 12 : 12;
            const end = start + placed.textWidth;
            const badgeX = placed.side === -1 ? start - 31 : end + 31;
            const toggleX =
              placed.depth === 0
                ? end + 24
                : placed.side === -1
                  ? start - 80
                  : end + 80;
            const middleY = placed.height / 2;
            const marker = score == null ? "?" : score.toFixed(1);
            const ringRadius = visual.radius + 4;
            return (
              <g
                key={sourcePath?.join(".") || `${node.id}-${index}`}
                className={`${styles.node} ${nodeClass} ${domain ? branchClass(domain, placed.branch) : ""} ${selected ? styles.nodeSelected : ""}`}
                transform={`translate(${placed.left} ${placed.top})`}
                style={{ "--mastery-color": visual.color } as CSSProperties}
                data-node-id={node.id}
                data-node-path={sourcePath?.join(".")}
                data-mastery={visual.status}
                data-score={score}
              >
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.zh}，${visual.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!pointer.current?.moved) onSelect?.(node);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    toggleNode(node);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect?.(node);
                    }
                    if (
                      node.__hasChildren &&
                      ["ArrowRight", "ArrowLeft", "+", "-"].includes(event.key)
                    ) {
                      event.preventDefault();
                      setOpenPaths((previous) => ({
                        ...previous,
                        [sourcePath?.join(".") || ""]:
                          event.key === "ArrowRight" || event.key === "+",
                      }));
                    }
                  }}
                >
                  <title>{`${node.zh} · ${visual.label}${node.__hasChildren ? " · 双击展开/收起下层" : ""}`}</title>
                  {placed.depth === 0 ? (
                    <rect
                      className={styles.rootCard}
                      x={-18}
                      y={-12}
                      width={placed.width + 36}
                      height={placed.height + 24}
                      rx="12"
                    />
                  ) : null}
                  <rect
                    className={styles.hitTarget}
                    x={0}
                    y={0}
                    width={placed.width}
                    height={placed.height}
                  />
                  {placed.lines.map((line, lineIndex) => (
                    <text
                      key={lineIndex}
                      x={start}
                      y={placed.fontSize + lineIndex * (placed.fontSize + 9)}
                    >
                      {line}
                    </text>
                  ))}
                  {placed.depth > 0 ? (
                    <path
                      className={styles.underline}
                      d={`M 0 ${placed.height} L ${placed.width} ${placed.height}`}
                    />
                  ) : null}
                  {placed.depth > 0 ? (
                    <g transform={`translate(${badgeX} ${middleY})`}>
                      <circle
                        className={styles.masteryBadge}
                        r={visual.radius}
                      />
                      <circle className={styles.masteryTrack} r={ringRadius} />
                      {score != null && score > 0 ? (
                        <circle
                          className={styles.masteryArc}
                          r={ringRadius}
                          strokeDasharray={`${(2 * Math.PI * ringRadius * score) / 5} ${2 * Math.PI * ringRadius}`}
                          transform="rotate(-90)"
                        />
                      ) : null}
                      <text
                        className={styles.masteryText}
                        style={{
                          fontSize: `${Math.max(11, visual.radius * 0.8)}px`,
                        }}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {marker}
                      </text>
                    </g>
                  ) : null}
                </g>
                {node.__hasChildren ? (
                  <g
                    role="button"
                    tabIndex={0}
                    className={styles.collapseButton}
                    aria-label={`${node.__open ? "收起" : "展开"}${node.zh}的下层节点`}
                    aria-expanded={Boolean(node.__open)}
                    transform={`translate(${toggleX} ${middleY})`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleNode(node);
                    }}
                    onKeyDown={(event) => {
                      if (["Enter", " "].includes(event.key)) {
                        event.preventDefault();
                        toggleNode(node);
                      }
                    }}
                  >
                    <circle r="16" />
                    <text textAnchor="middle" dominantBaseline="middle">
                      {node.__open ? "−" : "+"}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          掌握分数 0–5：红色薄弱 → 绿色掌握，分数越高圆点越小；灰色 ? 为暂无记录
        </span>
        <span className={styles.legendItem}>
          双击节点或点 ＋/− 展开、折叠下层
        </span>
        {scope === "class_average" ? (
          <span className={styles.legendItem}>
            按全班在读学生平均；未记录学生按 0 计
          </span>
        ) : null}
        <span className={styles.legendItem}>
          各主分支按比例显示；分支内优先保留学习中的薄弱节点
        </span>
        {message ? <span className={styles.caption}>{message}</span> : null}
      </div>
    </div>
  );
}
