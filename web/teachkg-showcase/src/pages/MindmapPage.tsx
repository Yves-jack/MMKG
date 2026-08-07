import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import shell from "@/styles/shell.module.css";
import styles from "./MindmapPage.module.css";

type TreeNode = {
  id: string;
  zh: string;
  importance: number;
  relation?: string | null;
  related?: string[];
  children: TreeNode[];
};

type MindmapDoc = {
  lecture_id: string;
  root: TreeNode;
  n_nodes: number;
  max_depth: number;
  orphan_count: number;
  meta: {
    chapter?: string;
    root_zh?: string;
    virtual_root?: boolean;
    n_entities_raw?: number;
    n_edges_raw?: number;
    attached_orphans?: number;
    n_chapters?: number;
  };
};

type IndexItem = {
  lecture_id: string;
  chapter?: string;
  root_zh?: string;
  n_nodes: number;
  max_depth: number;
  orphan_count: number;
  path: string;
  scope?: string;
};

type IndexDoc = {
  courseId: string;
  title: string;
  items: IndexItem[];
};

function relLabel(rel?: string | null) {
  if (!rel || rel === "attach") return "";
  const map: Record<string, string> = {
    part_of: "组成",
    belong_to: "属于",
    property_of: "属性",
    depend_on: "依赖",
    related_with: "相关",
    chapter_topic: "主题",
    toc_chapter: "章节",
  };
  return map[rel] || rel;
}

function nodeKind(id: string, depth: number): "root" | "chapter" | "topic" | "leaf" {
  if (id.startsWith("__course__/") || depth === 0) return "root";
  if (id.startsWith("__chapter__/")) return "chapter";
  if (depth <= 2) return "topic";
  return "leaf";
}

function collectMaxImp(node: TreeNode): number {
  let m = node.importance || 0;
  for (const c of node.children || []) m = Math.max(m, collectMaxImp(c));
  return m;
}

/** 画布整体拖动；移动超过阈值时吞掉随后的 click，避免误触展开 */
function PanViewport({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey: string | number;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [moved, setMoved] = useState(false);
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
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
    setDragging(false);
    setMoved(false);
  }, [resetKey]);

  useEffect(() => {
    const block = (e: MouseEvent) => {
      if (!suppressClickRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      suppressClickRef.current = false;
    };
    document.addEventListener("click", block, true);
    return () => document.removeEventListener("click", block, true);
  }, []);

  return (
    <div
      className={[
        styles.panViewport,
        dragging ? styles.panDragging : "",
        moved ? styles.panMoved : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origX: offset.x,
          origY: offset.y,
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
        setOffset({ x: d.origX + dx, y: d.origY + dy });
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
      onDoubleClick={() => setOffset({ x: 0, y: 0 })}
      title="拖动平移画布 · 双击复位"
    >
      <div
        className={styles.panLayer}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        {children}
      </div>
    </div>
  );
}

function MapBranch({
  node,
  depth,
  maxImp,
  defaultOpen,
  expandDepth,
}: {
  node: TreeNode;
  depth: number;
  maxImp: number;
  defaultOpen: boolean;
  expandDepth: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasKids = (node.children?.length || 0) > 0;
  const kind = nodeKind(node.id, depth);
  const imp = Math.max(0.15, Math.min(1, (node.importance || 0) / (maxImp || 1)));
  const rel = relLabel(node.relation);

  return (
    <div className={styles.branch} data-depth={depth} data-kind={kind}>
      <div className={styles.branchMain}>
        <button
          type="button"
          className={styles.bubble}
          style={{ ["--imp" as string]: String(imp) }}
          data-kind={kind}
          onClick={() => hasKids && setOpen((v) => !v)}
          title={hasKids ? (open ? "折叠" : "展开") : node.zh}
        >
          <span className={styles.bubbleText}>{node.zh}</span>
          {rel ? <span className={styles.bubbleRel}>{rel}</span> : null}
          {hasKids ? (
            <span className={styles.bubbleMeta}>
              {open ? "−" : "+"}
              {node.children.length}
            </span>
          ) : (
            <span className={styles.bubbleScore}>{node.importance.toFixed(2)}</span>
          )}
        </button>
        {hasKids && open ? <span className={styles.elbow} aria-hidden /> : null}
      </div>

      {hasKids && open ? (
        <div className={styles.childCol}>
          {node.children.map((c, i) => (
            <div
              key={`${c.id}-${c.relation || ""}-${i}`}
              className={styles.childRow}
              data-first={i === 0 ? "1" : "0"}
              data-last={i === node.children.length - 1 ? "1" : "0"}
            >
              <span className={styles.rail} aria-hidden />
              <MapBranch
                node={c}
                depth={depth + 1}
                maxImp={maxImp}
                defaultOpen={depth + 1 < expandDepth}
                expandDepth={expandDepth}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MindmapPage() {
  const [sp, setSp] = useSearchParams();
  const [index, setIndex] = useState<IndexDoc | null>(null);
  const [doc, setDoc] = useState<MindmapDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const [mapKey, setMapKey] = useState(0);

  const lecture = sp.get("lecture") || "";

  useEffect(() => {
    fetch("/data/mindmap_showcase.json")
      .then((r) => {
        if (!r.ok) throw new Error("缺少 mindmap_showcase.json，请先运行 run_mindmap_tree.py");
        return r.json();
      })
      .then((d: IndexDoc) => {
        setIndex(d);
        const preferred =
          lecture ||
          d.items.find((i) => i.lecture_id === "course")?.lecture_id ||
          d.items[0]?.lecture_id;
        if (preferred && !lecture) {
          setSp({ lecture: preferred }, { replace: true });
        }
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    if (!lecture) return;
    setError(null);
    setExpandAll(false);
    setMapKey((k) => k + 1);
    fetch(`/data/mindmaps/${lecture === "course" ? "course" : `lecture_${lecture}`}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`加载 ${lecture} 思维导图失败`);
        return r.json();
      })
      .then(setDoc)
      .catch((e) => {
        setDoc(null);
        setError(String(e.message || e));
      });
  }, [lecture]);

  const maxImp = useMemo(() => (doc ? collectMaxImp(doc.root) : 1), [doc]);
  const current = index?.items.find((i) => i.lecture_id === lecture);
  const courseItems = index?.items.filter((i) => i.lecture_id === "course") || [];
  const lectureItems = index?.items.filter((i) => i.lecture_id !== "course") || [];

  return (
    <ResizableShell
      storagePrefix="shell-mindmap"
      nav={
      <aside className={shell.sidebar}>
        <div className={shell.sideHead}>
          <Link className={shell.back} to="/">
            <span className={shell.backIcon} aria-hidden>
              ←
            </span>
            <span className={shell.backBrand}>
              Teach<em>KG</em>
            </span>
          </Link>
          <p className={shell.eyebrow}>Mindmap</p>
          <h1 className={shell.sideTitle}>知识导图</h1>
          <p className={shell.sideLead}>图谱投影为树 · 按讲次 / 整课浏览</p>
        </div>

        {courseItems.length > 0 && (
          <div className={shell.navBlock}>
            <p className={shell.navLabel}>课程</p>
            {courseItems.map((it) => (
              <button
                key={it.lecture_id}
                type="button"
                className={
                  it.lecture_id === lecture ? shell.navItemActive : shell.navItem
                }
                onClick={() => setSp({ lecture: it.lecture_id })}
              >
                <span>整课总览</span>
                <em>{it.n_nodes} 点</em>
              </button>
            ))}
          </div>
        )}

        {lectureItems.length > 0 && (
          <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
            <p className={shell.navLabel}>讲次</p>
            <div className={shell.navScroll}>
              {lectureItems.map((it) => (
                <button
                  key={it.lecture_id}
                  type="button"
                  className={
                    it.lecture_id === lecture ? shell.navItemActive : shell.navItem
                  }
                  onClick={() => setSp({ lecture: it.lecture_id })}
                >
                  <span>第 {it.lecture_id} 讲</span>
                  <em>{it.root_zh || `${it.n_nodes}点`}</em>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
      }
      main={
      <main className={shell.main}>
        <header className={shell.topbar}>
          <div className={shell.topbarText}>
            <h2>
              {lecture === "course"
                ? "整课思维导图"
                : lecture
                  ? `第 ${lecture} 讲`
                  : "思维导图"}
            </h2>
            {current?.chapter ? <p>{current.chapter}</p> : null}
          </div>

          {doc && (
            <div className={shell.stats}>
              <div>
                <strong>{doc.n_nodes}</strong>
                <span>节点</span>
              </div>
              <div>
                <strong>{doc.max_depth}</strong>
                <span>深度</span>
              </div>
              <div>
                <strong>{doc.meta.n_entities_raw ?? "—"}</strong>
                <span>原实体</span>
              </div>
              <div>
                <strong>{doc.orphan_count}</strong>
                <span>未挂入</span>
              </div>
            </div>
          )}

          <div className={shell.tools}>
            <button
              type="button"
              className={shell.toolBtn}
              onClick={() => {
                setExpandAll(true);
                setMapKey((k) => k + 1);
              }}
            >
              展开下层
            </button>
            <button
              type="button"
              className={shell.toolBtn}
              onClick={() => {
                setExpandAll(false);
                setMapKey((k) => k + 1);
              }}
            >
              收起
            </button>
          </div>
        </header>

        {error && <p className="empty-hint">{error}</p>}
        {!doc && !error && <p className="empty-hint">加载导图…</p>}

        {doc && (
          <div className={`${shell.canvasWrap} ${styles.mindCanvasWrap}`}>
            <PanViewport resetKey={`${lecture}-${mapKey}`}>
              <div className={styles.canvas} key={mapKey}>
                <MapBranch
                  node={doc.root}
                  depth={0}
                  maxImp={maxImp}
                  defaultOpen
                  expandDepth={expandAll ? 4 : 1}
                />
              </div>
            </PanViewport>
          </div>
        )}
      </main>
      }
    />
  );
}
