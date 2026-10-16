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
import {
  masteryLearningPath,
  visibleLearningPath,
} from "@/lib/kg/masteryLearningPath.mjs";
import { mindmapMarkerPositions } from "@/lib/kg/mindmapMarkerPositions.mjs";
import { preparePackedMindmap } from "@/lib/kg/packedMindmapLayout.mjs";
import { usePackedMindmapLayout } from "@/lib/kg/usePackedMindmapLayout";
import { useMasteryForceLayout } from "@/lib/kg/useMasteryForceLayout";
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
  compact = false,
}: {
  doc: MindmapDoc;
  mastery: Readonly<Record<string, number>>;
  selectedId?: string | null;
  selectedPath?: readonly number[] | null;
  onSelect?: (node: MindmapTreeNode) => void;
  onClearSelect?: () => void;
  message?: string;
  scope?: "personal" | "class_average";
  compact?: boolean;
}) {
  const [freeLayout, setFreeLayout] = useState(false);
  const [forceReset, setForceReset] = useState(0);
  const [percent, setPercent] = useState(100);
  const [showLabels, setShowLabels] = useState(true);
  const [expandDepth, setExpandDepth] = useState(3);
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
    nodeKey?: string;
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
    () => preparePackedMindmap(collapsedDoc, textWidth, { showLabels }),
    [collapsedDoc, showLabels],
  );
  const packed = usePackedMindmapLayout(packedInput, !freeLayout);
  const force = useMasteryForceLayout(packedInput, freeLayout, forceReset);
  const activeLayout = freeLayout ? force.layout : packed.layout;
  const layout = activeLayout || {
    nodes: [],
    edges: [],
    domains: [],
    bounds: { x: -500, y: -300, width: 1000, height: 600 },
  };

  const learningSequence = useMemo(
    () => (scope === "personal" ? masteryLearningPath(doc, mastery) : []),
    [doc, mastery, scope],
  );
  const learningEdges = visibleLearningPath(learningSequence, layout.nodes);
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
  const resetViewport = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    pointer.current = null;
  };
  const expandAll = () => {
    setPercent(100);
    setExpandDepth(doc.max_depth + 1);
    setOpenPaths({});
    resetViewport();
  };
  const resetMap = () => {
    setForceReset((previous) => previous + 1);
    setShowLabels(true);
    setPercent(100);
    setExpandDepth(3);
    setOpenPaths({});
    resetViewport();
    onClearSelect?.();
  };
  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if (freeLayout) force.freezeViewport();
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
      if (current.nodeKey && freeLayout)
        force.moveNode(current.nodeKey, after.x - before.x, after.y - before.y);
      else
        setPan((previous) => ({
          x: previous.x - (after.x - before.x),
          y: previous.y - (after.y - before.y),
        }));
    }
    current.x = event.clientX;
    current.y = event.clientY;
  };
  const handleNodePointerDown = (
    event: PointerEvent<SVGGElement>,
    nodeKey: string,
  ) => {
    if (!freeLayout || event.button !== 0) return;
    event.stopPropagation();
    force.freezeViewport();
    pointer.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      nodeKey,
    };
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
    if (freeLayout) force.freezeViewport();
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
      aria-busy={!activeLayout}
      data-layout-mode={freeLayout ? "free" : "strict"}
    >
      <div className={styles.toolbar} data-mastery-toolbar>
        <div className={styles.controls}>
          <label className={styles.layoutToggle}>
            <span>严格布局</span>
            <input
              type="checkbox"
              role="switch"
              aria-label="自由布局"
              checked={freeLayout}
              onChange={(event) => {
                setFreeLayout(event.target.checked);
                resetViewport();
              }}
            />
            <span>自由布局</span>
          </label>
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
            onClick={expandAll}
          >
            全部展开
          </button>
          <button
            type="button"
            className={styles.controlButton}
            onClick={resetMap}
          >
            重置
          </button>
          <label
            className={styles.labelToggle}
            title="课程标题始终显示；开关控制其他节点名称"
          >
            <input
              type="checkbox"
              role="switch"
              checked={showLabels}
              onChange={(event) => setShowLabels(event.target.checked)}
            />
            <span>显示节点文字</span>
          </label>
          {scope === "personal" ? (
            <span className={styles.learningLegend} title="沿紫色箭头，按章节顺序补强掌握度低于 2.5 分的知识点">
              <span className={styles.learningLegendArrow} aria-hidden="true">⟶</span>
              学习路径
            </span>
          ) : null}
        </div>
      </div>
      {!activeLayout ? (
        <p className={styles.caption} role="status">
          {freeLayout
            ? "正在计算自由布局…"
            : packed.error || "正在按子树轮廓优化布局…"}
        </p>
      ) : null}
      <div className={styles.canvas}>
        {message ? (
          <p className={styles.notice} role="status">
            {message}
          </p>
        ) : null}
        <svg
          className={`${styles.viewport} ${dragging ? styles.dragging : ""} ${freeLayout ? styles.freeLayout : ""}`}
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
          <defs>
            <marker
              id="mastery-learning-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerUnits="strokeWidth"
              markerWidth="3.5"
              markerHeight="3.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 Z" fill="#6440cf" />
            </marker>
          </defs>
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
          <g aria-label="个性化学习路径：按章节顺序，章内从根到叶，掌握度低于 2.5 分">
            {learningEdges.map((edge) => (
              <g key={`${edge.from}:${edge.to}`}>
                <path d={edge.path} className={styles.learningEdgeHalo} />
                <path
                  data-learning-from={edge.from}
                  data-learning-to={edge.to}
                  d={edge.path}
                  className={styles.learningEdge}
                  markerEnd="url(#mastery-learning-arrow)"
                />
              </g>
            ))}
          </g>
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
            const { start, badgeX, toggleX, middleY } =
              mindmapMarkerPositions(placed);
            const marker = score == null ? "?" : score.toFixed(1);
            const ringRadius = visual.radius + 3;
            return (
              <g
                key={sourcePath?.join(".") || `${node.id}-${index}`}
                className={`${styles.node} ${nodeClass} ${domain ? branchClass(domain, placed.branch) : ""} ${selected ? styles.nodeSelected : ""}`}
                transform={`translate(${placed.left} ${placed.top})`}
                style={{ "--mastery-color": visual.color } as CSSProperties}
                data-node-compact={placed.compact || undefined}
                data-node-free={placed.free || undefined}
                data-node-id={node.id}
                data-node-path={sourcePath?.join(".")}
                data-mastery={visual.status}
                data-score={score}
              >
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.zh}，${visual.label}`}
                  onPointerDown={(event) =>
                    handleNodePointerDown(event, placed.key)
                  }
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
                  {placed.depth > 0 && !placed.compact && !placed.free ? (
                    <rect
                      className={styles.labelBacking}
                      x={start - 4}
                      y={0}
                      width={placed.textWidth + 8}
                      height={placed.height - 3}
                    />
                  ) : null}
                  {placed.lines.map((line, lineIndex) => (
                    <text
                      className={styles.nodeLabel}
                      data-node-label=""
                      key={lineIndex}
                      x={start}
                      y={
                        (placed.free && placed.depth > 0 ? 72 : 0) +
                        placed.fontSize +
                        lineIndex * (placed.fontSize + 9)
                      }
                    >
                      {line}
                    </text>
                  ))}
                  {placed.depth > 0 && !placed.compact && !placed.free ? (
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
                          fontSize: "20px",
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
    </div>
  );
}
