import { useEffect, useRef, useState } from "react";
import type { AnimEdge, AnimFrame, AnimNode, AnimNodeState } from "@/lib/apps/animate/types";
import styles from "./AnimStage.module.css";

const STATE_FILL: Record<string, string> = {
  idle: "#3a3f4a",
  active: "#3ecf8e",
  done: "#2a9f6a",
  frontier: "#5b8def",
  blocked: "#e8898a",
};

const PALETTE = ["#3ecf8e", "#5b8def", "#e8b84a", "#e8898a", "#a78bfa", "#5eead4"];

const EDGE_STROKE: Record<string, string> = {
  idle: "rgba(160,170,185,0.35)",
  active: "#3ecf8e",
  done: "rgba(62,207,142,0.55)",
};

const MORPH_MS = 520;

type Props = {
  frame: AnimFrame | null;
  /** 知识点/动画条目 id；切换时瞬间对齐，不做跨条目插值 */
  specId?: string;
  frameKey?: string | number;
  onNodeClick?: (id: string) => void;
};

type VisualNode = AnimNode & { opacity: number };
type VisualEdge = AnimEdge & { opacity: number };

function easeOutCubic(t: number) {
  return 1 - (1 - t) ** 3;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function nodeRadius(n: AnimNode) {
  if (n.state === "active") return 20;
  if (n.state === "frontier") return 17;
  return 15;
}

function mergeMorph(
  fromNodes: VisualNode[],
  toNodes: AnimNode[],
  fromEdges: VisualEdge[],
  toEdges: AnimEdge[],
  t: number
): { nodes: VisualNode[]; edges: VisualEdge[] } {
  const e = easeOutCubic(t);
  const fromN = new Map(fromNodes.map((n) => [n.id, n]));
  const toN = new Map(toNodes.map((n) => [n.id, n]));
  const ids = new Set([...fromN.keys(), ...toN.keys()]);
  const nodes: VisualNode[] = [];
  for (const id of ids) {
    const a = fromN.get(id);
    const b = toN.get(id);
    if (a && b) {
      nodes.push({
        ...b,
        x: lerp(a.x, b.x, e),
        y: lerp(a.y, b.y, e),
        opacity: 1,
      });
    } else if (b && !a) {
      nodes.push({ ...b, opacity: e });
    } else if (a && !b) {
      nodes.push({ ...a, opacity: 1 - e });
    }
  }

  const fromE = new Map(fromEdges.map((x) => [x.id, x]));
  const toE = new Map(toEdges.map((x) => [x.id, x]));
  const eids = new Set([...fromE.keys(), ...toE.keys()]);
  const edges: VisualEdge[] = [];
  for (const id of eids) {
    const a = fromE.get(id);
    const b = toE.get(id);
    if (a && b) edges.push({ ...b, opacity: 1 });
    else if (b && !a) edges.push({ ...b, opacity: e });
    else if (a && !b) edges.push({ ...a, opacity: 1 - e });
  }
  return { nodes, edges };
}

function snapFrame(frame: AnimFrame) {
  return {
    nodes: (frame.nodes || []).map((n) => ({ ...n, opacity: 1 })),
    edges: (frame.edges || []).map((e) => ({ ...e, opacity: 1 })),
  };
}

function textFromFrame(frame: AnimFrame) {
  return {
    caption: frame.caption,
    analysis: frame.analysis || frame.definition || "",
    tip: frame.tip || "",
  };
}

const LEGEND: { state: AnimNodeState; label: string; color: string }[] = [
  { state: "idle", label: "其余", color: STATE_FILL.idle },
  { state: "frontier", label: "候选", color: STATE_FILL.frontier },
  { state: "active", label: "当前", color: STATE_FILL.active },
  { state: "done", label: "已完成", color: STATE_FILL.done },
];

/** 舞台：图元插值 + 结构 HUD，避免 PPT 式硬切 */
export function AnimStage({ frame, specId, frameKey, onNodeClick }: Props) {
  const [nodes, setNodes] = useState<VisualNode[]>([]);
  const [edges, setEdges] = useState<VisualEdge[]>([]);
  const [bars, setBars] = useState(frame?.bars || []);
  const [text, setText] = useState(() =>
    frame
      ? textFromFrame(frame)
      : { caption: "", analysis: "", tip: "" }
  );
  const [textIn, setTextIn] = useState(true);

  const visualRef = useRef({ nodes: [] as VisualNode[], edges: [] as VisualEdge[] });
  const rafRef = useRef<number | null>(null);
  const prevSpecRef = useRef<string | undefined>(specId);

  useEffect(() => {
    if (!frame) {
      setNodes([]);
      setEdges([]);
      setBars([]);
      return;
    }

    const toNodes = frame.nodes || [];
    const toEdges = frame.edges || [];
    setBars(frame.bars || []);

    const switchedSpec = prevSpecRef.current !== specId;
    prevSpecRef.current = specId;

    setTextIn(false);
    const textTimer = window.setTimeout(() => {
      setText(textFromFrame(frame));
      setTextIn(true);
    }, switchedSpec ? 0 : 160);

    if (switchedSpec || visualRef.current.nodes.length === 0) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      const snapped = snapFrame(frame);
      visualRef.current = snapped;
      setNodes(snapped.nodes);
      setEdges(snapped.edges);
      if (switchedSpec) {
        setText(textFromFrame(frame));
        setTextIn(true);
      }
      return () => window.clearTimeout(textTimer);
    }

    const fromN = visualRef.current.nodes;
    const fromE = visualRef.current.edges;
    const start = performance.now();

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / MORPH_MS);
      const next = mergeMorph(fromN, toNodes, fromE, toEdges, t);
      visualRef.current = next;
      setNodes(next.nodes);
      setEdges(next.edges);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        const final = snapFrame(frame);
        visualRef.current = final;
        setNodes(final.nodes);
        setEdges(final.edges);
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.clearTimeout(textTimer);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [frameKey, frame, specId]);

  if (!frame) {
    return <div className={styles.empty}>从左侧挑一个精制动画开始</div>;
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const hasGraph = nodes.length > 0 || edges.length > 0;
  const states = new Set(nodes.map((n) => n.state || "idle"));
  const hud = frame.hud;
  const usesColor = nodes.some((n) => n.colorIndex != null);

  return (
    <div className={styles.stage}>
      <div className={styles.viewport}>
        {hasGraph ? (
          <svg className={styles.svg} viewBox="0 0 400 260" role="img">
            <defs>
              <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2.5" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <radialGradient id="stageGlow" cx="50%" cy="40%" r="60%">
                <stop offset="0%" stopColor="rgba(62,207,142,0.12)" />
                <stop offset="100%" stopColor="rgba(0,0,0,0)" />
              </radialGradient>
            </defs>
            <rect width="400" height="260" fill="url(#stageGlow)" />
            {edges.map((e) => {
              const a = nodeMap.get(e.from);
              const b = nodeMap.get(e.to);
              if (!a || !b) return null;
              const active = e.state === "active";
              return (
                <g key={e.id} opacity={e.opacity}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={EDGE_STROKE[e.state || "idle"]}
                    strokeWidth={active ? 4 : e.state === "done" ? 2.5 : 1.8}
                    strokeLinecap="round"
                    className={active ? styles.edgePulse : styles.edgeLine}
                    filter={active ? "url(#glow)" : undefined}
                  />
                  {e.label ? (
                    <text
                      x={(a.x + b.x) / 2}
                      y={(a.y + b.y) / 2 - 8}
                      className={styles.edgeLabel}
                    >
                      {e.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {nodes.map((n) => {
              const fill =
                n.colorIndex != null
                  ? PALETTE[n.colorIndex % PALETTE.length]
                  : STATE_FILL[n.state || "idle"];
              const active = n.state === "active";
              const r = nodeRadius(n);
              return (
                <g
                  key={n.id}
                  className={styles.nodeHit}
                  opacity={n.opacity}
                  onClick={() => onNodeClick?.(n.id)}
                  style={{ cursor: onNodeClick ? "pointer" : "default" }}
                >
                  {active ? (
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={r + 8}
                      fill="none"
                      stroke="rgba(62,207,142,0.35)"
                      strokeWidth={2}
                      className={styles.ringPulse}
                    />
                  ) : null}
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={r}
                    fill={fill}
                    stroke={active ? "#9ff0c8" : "rgba(255,255,255,0.12)"}
                    strokeWidth={active ? 2 : 1}
                    filter={active ? "url(#glow)" : undefined}
                    className={styles.nodeCircle}
                  />
                  <text
                    x={n.x}
                    y={n.y + 4}
                    textAnchor="middle"
                    className={styles.nodeLabel}
                  >
                    {n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : null}

        {bars.length > 0 ? (
          <div className={styles.bars}>
            {bars.map((b) => (
              <div key={b.id} className={styles.barRow}>
                <span className={styles.barLabel}>{b.label}</span>
                <div className={styles.barTrack}>
                  <div
                    className={
                      b.state === "active"
                        ? styles.barFillActive
                        : b.state === "done"
                          ? styles.barFillDone
                          : styles.barFill
                    }
                    style={{
                      width: `${Math.min(100, Math.max(10, b.value * 9))}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!hasGraph && bars.length === 0 ? (
          <p className={styles.emptyInner}>{frame.detail || frame.caption}</p>
        ) : null}

        {hasGraph && !usesColor && states.size > 0 ? (
          <ul className={styles.legend} aria-hidden>
            {LEGEND.filter((x) => states.has(x.state)).map((x) => (
              <li key={x.state}>
                <i style={{ background: x.color }} />
                {x.label}
              </li>
            ))}
          </ul>
        ) : null}

        {hud ? (
          <div
            className={`${styles.hud} ${textIn ? styles.hudIn : styles.hudOut}`}
          >
            <span className={styles.hudLabel}>{hud.label}</span>
            <div className={styles.hudItems}>
              {hud.items.length === 0 ? (
                <span className={styles.hudEmpty}>空</span>
              ) : (
                hud.items.map((item, i) => (
                  <span
                    key={`${item}-${i}`}
                    className={
                      hud.active?.includes(i) ? styles.hudChipOn : styles.hudChip
                    }
                  >
                    {item}
                  </span>
                ))
              )}
            </div>
          </div>
        ) : null}

        <p
          className={`${styles.caption} ${textIn ? styles.subtitleIn : styles.subtitleOut}`}
        >
          {text.caption}
        </p>
      </div>

      <div
        className={`${styles.subtitle} ${textIn ? styles.subtitleIn : styles.subtitleOut}`}
      >
        {text.analysis ? <p className={styles.analysis}>{text.analysis}</p> : null}
        {text.tip ? <em>{text.tip}</em> : null}
      </div>
    </div>
  );
}
