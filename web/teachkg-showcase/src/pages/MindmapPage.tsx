import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CollapsiblePanel } from "@/components/pipeline/CollapsiblePanel";
import { RelatedAssetsPanel } from "@/components/pipeline/SelectionPanels";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import {
  MindmapTree,
  type MindmapDoc,
  type MindmapTreeNode,
} from "@/components/mindmap/MindmapTree";
import { firstAssetWatch, type AssetsLibrary } from "@/lib/kg/assetsLibrary";
import { loadReviewLectureMindmap } from "@/lib/apps/loadReviewClassroomGraph";
import { reviewWatchPath } from "@/lib/apps/reviewSeek";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import { ChapterOutlinePanel } from "@/components/mindmap/ChapterOutlinePanel";
import { MindmapHistoryPanel } from "@/components/mindmap/MindmapHistoryPanel";
import {
  buildChapterMindmapDoc,
  mergeMindmapIndexWithChapters,
} from "@/lib/kg/mindmapChapterMerge";
import { loadCourseMindmapStitched } from "@/lib/kg/mindmapComposeLoad";
import {
  buildChapterMindmapFromSkeleton,
  leavesFromReviewPoints,
  parseOutlineText,
} from "@/lib/kg/mindmapChapterSkeleton";
import { withBase } from "@/lib/withBase";
import {
  applyMindmapEditPatch,
  loadMindmapEditPatch,
  type MindmapHistoryItem,
} from "@/lib/apps/mindmapEdits";
import {
  chapterFileSlug,
  chapterNavId,
  isCourseNavId,
  parseChapterNavId,
  type MindmapIndexDoc,
  type MindmapIndexItem,
} from "@/lib/kg/mindmapTypes";
import pipe from "@/pages/PipelinePage.module.css";
import shell from "@/styles/shell.module.css";

async function loadMindmapDoc(
  courseId: string,
  navId: string,
  items: MindmapIndexItem[]
): Promise<MindmapDoc> {
  if (isCourseNavId(navId)) {
    return loadCourseMindmapStitched(courseId, items);
  }

  const chapterTitle = parseChapterNavId(navId);
  if (chapterTitle) {
    const item = items.find(
      (i) =>
        i.lecture_id === navId ||
        ((i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")) &&
          i.chapter === chapterTitle)
    );
    const path =
      item?.path ||
      `mindmaps/chapter_${chapterFileSlug(chapterTitle)}.json`;
    try {
      const r = await fetch(`${courseDataUrl(courseId, path)}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (r.ok) {
        const d = (await r.json()) as MindmapDoc;
        return {
          ...d,
          meta: {
            ...d.meta,
            scope: "chapter",
            chapter: chapterTitle,
            lecture_ids: d.meta?.lecture_ids || item?.lecture_ids,
            source: d.meta?.source || item?.source || "kg",
          },
        };
      }
    } catch {
      /* fall through to runtime merge */
    }

    const lids =
      item?.lecture_ids ||
      items
        .filter(
          (i) =>
            i.scope !== "course" &&
            i.scope !== "chapter" &&
            i.chapter === chapterTitle
        )
        .map((i) => i.lecture_id)
        .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));

    // 无讲次且章文件也读不到时，给可编辑空骨架，避免整页报错
    if (!lids.length) {
      return {
        lecture_id: chapterNavId(chapterTitle),
        root: {
          id: `__chapter__/${chapterTitle}`,
          zh: chapterTitle,
          importance: 0.75,
          relation: null,
          related: [],
          children: [],
        },
        roots: [
          {
            id: `__chapter__/${chapterTitle}`,
            zh: chapterTitle,
            importance: 0.75,
            relation: null,
            related: [],
            children: [],
          },
        ],
        n_nodes: 1,
        max_depth: 0,
        orphan_count: 0,
        meta: {
          chapter: chapterTitle,
          root_zh: chapterTitle,
          virtual_root: true,
          scope: "chapter",
          lecture_ids: [],
          source: "summary+kg",
        },
      } satisfies MindmapDoc;
    }

    const lectures: { lectureId: string; doc: MindmapDoc }[] = [];
    for (const lid of lids) {
      const doc = await loadReviewLectureMindmap(courseId, lid, {
        chapter: chapterTitle,
        preferChapterSlice: false,
      });
      lectures.push({ lectureId: lid, doc });
    }
    const hasReview = lectures.some((l) => l.doc.meta?.source === "review+kg");
    return buildChapterMindmapDoc(chapterTitle, lectures, {
      source: hasReview ? "review+kg" : "kg",
    });
  }

  const lectureItem = items.find((i) => i.lecture_id === navId);
  return loadReviewLectureMindmap(courseId, navId, {
    chapter: lectureItem?.chapter,
  });
}

function sourceLabel(src?: string, composedFrom?: string) {
  if (composedFrom === "chapters") return "章拼接";
  if (composedFrom === "chapter_slice") return "章裁剪";
  if (src === "summary+kg") return "大纲+图谱";
  if (src === "review+kg") return "课堂复习+图谱";
  return "图谱投影";
}

export function MindmapPage() {
  const courseId = useCourseId();
  const [sp, setSp] = useSearchParams();
  const [index, setIndex] = useState<MindmapIndexDoc | null>(null);
  const [doc, setDoc] = useState<MindmapDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const [mapKey, setMapKey] = useState(0);
  const [selected, setSelected] = useState<MindmapTreeNode | null>(null);
  const [library, setLibrary] = useState<AssetsLibrary | null>(null);
  const [historyItems, setHistoryItems] = useState<MindmapHistoryItem[]>([]);
  const mindUndoRef = useRef<(() => void) | null>(null);
  /** 大纲重建后更新 index 时跳过一次磁盘重载，避免缓存旧文件盖掉新图 */
  const skipNextDocLoadRef = useRef(false);

  const navId = sp.get("lecture") || "";
  const items = index?.items || [];

  const courseItems = useMemo(
    () => items.filter((i) => i.scope === "course" || i.lecture_id === "course"),
    [items]
  );
  const chapterItems = useMemo(
    () =>
      items.filter(
        (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
      ),
    [items]
  );
  const lectureItems = useMemo(
    () =>
      items.filter(
        (i) =>
          i.lecture_id !== "course" &&
          i.scope !== "course" &&
          i.scope !== "chapter" &&
          !String(i.lecture_id).startsWith("chapter:")
      ),
    [items]
  );

  const activeChapter =
    parseChapterNavId(navId) ||
    items.find((i) => i.lecture_id === navId)?.chapter ||
    "";

  const lecturesForNav = useMemo(() => {
    if (!activeChapter) return lectureItems;
    const inChapter = lectureItems.filter((i) => i.chapter === activeChapter);
    return inChapter.length ? inChapter : lectureItems;
  }, [lectureItems, activeChapter]);

  const lectureIdForLinks = useMemo(() => {
    if (!navId || isCourseNavId(navId) || parseChapterNavId(navId)) {
      const lids = doc?.meta?.lecture_ids;
      return lids?.[0] || "";
    }
    return navId;
  }, [navId, doc]);

  useEffect(() => {
    fetch(`${courseDataUrl(courseId, "assets_library.json")}?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLibrary(d && Array.isArray(d.cards) ? d : null))
      .catch(() => setLibrary(null));
  }, [courseId]);

  useEffect(() => {
    fetch(courseDataUrl(courseId, "mindmap_showcase.json"))
      .then((r) => {
        if (!r.ok) throw new Error("缺少 mindmap_showcase.json，请先运行 run_mindmap_tree.py");
        return r.json();
      })
      .then((d: MindmapIndexDoc) => {
        const merged: MindmapIndexDoc = {
          ...d,
          items: mergeMindmapIndexWithChapters(d.items || []),
        };
        setIndex(merged);
        const preferred =
          navId ||
          merged.items.find((i) => i.lecture_id === "course")?.lecture_id ||
          merged.items.find((i) => i.scope === "chapter")?.lecture_id ||
          merged.items[0]?.lecture_id;
        if (preferred && !navId) {
          setSp({ lecture: preferred }, { replace: true });
        }
      })
      .catch((e) => setError(String(e.message || e)));
  }, [courseId]);

  useEffect(() => {
    if (!navId || !index) return;
    if (skipNextDocLoadRef.current) {
      skipNextDocLoadRef.current = false;
      return;
    }
    setError(null);
    setExpandAll(false);
    setMapKey((k) => k + 1);
    setSelected(null);
    let cancelled = false;
    loadMindmapDoc(courseId, navId, index.items)
      .then((d) => {
        if (cancelled) return;
        const patched = applyMindmapEditPatch(
          d,
          loadMindmapEditPatch(courseId, navId)
        );
        setDoc(patched);
      })
      .catch((e) => {
        if (cancelled) return;
        setDoc(null);
        setError(String(e.message || e));
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, navId, index]);

  const current = items.find((i) => i.lecture_id === navId);
  const chapterForOutline =
    parseChapterNavId(navId) ||
    (current?.scope === "chapter" ? current.chapter : "") ||
    current?.chapter ||
    "";
  const nodeWatch = useMemo(
    () =>
      selected && lectureIdForLinks
        ? firstAssetWatch(library, selected.id, {
            lectureId: lectureIdForLinks,
            lectureOnly: true,
          })
        : null,
    [selected, library, lectureIdForLinks]
  );

  const titleText = (() => {
    if (isCourseNavId(navId)) return "整课思维导图";
    const ch = parseChapterNavId(navId);
    if (ch) return ch;
    if (navId) return `第 ${navId} 讲`;
    return "思维导图";
  })();

  const rebuildChapterFromOutline = async (
    outlineText: string,
    meta?: { source?: string | null }
  ) => {
    if (!chapterForOutline || !index) {
      throw new Error("请先在左侧选中具体「章」（不是整课总览）再更新大纲");
    }
    const item = index.items.find(
      (i) =>
        i.lecture_id === navId ||
        (i.scope === "chapter" && i.chapter === chapterForOutline) ||
        i.chapter === chapterForOutline
    );
    const lids =
      item?.lecture_ids ||
      index.items
        .filter(
          (i) =>
            i.scope !== "course" &&
            i.scope !== "chapter" &&
            i.chapter === chapterForOutline
        )
        .map((i) => i.lecture_id);

    const lectures: { lectureId: string; doc: MindmapDoc }[] = [];
    const extraLeaves: MindmapTreeNode[] = [];
    for (const lid of lids) {
      try {
        const d = await loadReviewLectureMindmap(courseId, lid, {
          chapter: chapterForOutline,
          preferChapterSlice: false,
        });
        lectures.push({ lectureId: String(lid), doc: d });
      } catch {
        /* skip */
      }
      try {
        const rr = await fetch(
          `${courseDataUrl(courseId, `review/lecture_${lid}.json`)}?t=${Date.now()}`,
          { cache: "no-store" }
        );
        if (rr.ok) {
          const rev = await rr.json();
          extraLeaves.push(...leavesFromReviewPoints(rev?.points));
        }
      } catch {
        /* skip */
      }
    }
    if (!lectures.length && doc) {
      lectures.push({ lectureId: "0", doc });
    }
    const skSource =
      meta?.source === "manual_llm" || meta?.source === "manual"
        ? (meta.source as "manual" | "manual_llm")
        : "manual";
    const sk = parseOutlineText(chapterForOutline, outlineText, skSource);
    const next = buildChapterMindmapFromSkeleton(sk, lectures, {
      source: "summary+kg",
      extraLeaves,
    });
    setDoc(next);
    setMapKey((k) => k + 1);
    setSelected(null);

    // 落盘章导图（与 summaries 一并持久化，不依赖浏览器缓存）
    try {
      const r = await fetch(withBase("/api/mindmap-outline"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          chapter: chapterForOutline,
          mindmap: next,
          persist_mindmap: true,
          mindmap_only: true,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.warn("persist chapter mindmap failed", err);
        throw new Error(
          String((err as { error?: string })?.error || "章导图写入磁盘失败")
        );
      } else if (index) {
        skipNextDocLoadRef.current = true;
        setIndex({
          ...index,
          items: index.items.map((it) =>
            it.lecture_id === next.lecture_id ||
            (it.scope === "chapter" && it.chapter === chapterForOutline)
              ? {
                  ...it,
                  n_nodes: next.n_nodes,
                  max_depth: next.max_depth,
                  orphan_count: next.orphan_count,
                  source: next.meta?.source || it.source,
                  lecture_ids: next.meta?.lecture_ids || it.lecture_ids,
                }
              : it
          ),
        });
      }
    } catch (e) {
      console.warn("persist chapter mindmap failed", e);
      throw e;
    }
  };

  const isLeafish =
    selected &&
    !selected.id.startsWith("__") &&
    (selected.children?.length || 0) <= 2;

  return (
    <ResizableShell
      storagePrefix="shell-mindmap"
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to={coursePath(courseId)}>
              <span className={shell.backIcon} aria-hidden>
                ←
              </span>
              <span className={shell.backBrand}>
                Edu<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>Mindmap</p>
            <h1 className={shell.sideTitle}>知识导图</h1>
          </div>

          {courseItems.length > 0 && (
            <div className={shell.navBlock}>
              <p className={shell.navLabel}>课程</p>
              {courseItems.map((it) => (
                <button
                  key={it.lecture_id}
                  type="button"
                  className={
                    it.lecture_id === navId ? shell.navItemActive : shell.navItem
                  }
                  onClick={() => setSp({ lecture: it.lecture_id })}
                >
                  <span>整课总览</span>
                </button>
              ))}
            </div>
          )}

          {chapterItems.length > 0 && (
            <div className={shell.navBlock}>
              <p className={shell.navLabel}>章</p>
              <div className={shell.navScroll} style={{ maxHeight: 220 }}>
                {chapterItems.map((it) => (
                  <button
                    key={it.lecture_id}
                    type="button"
                    className={
                      it.lecture_id === navId || it.chapter === activeChapter
                        ? shell.navItemActive
                        : shell.navItem
                    }
                    onClick={() =>
                      setSp({
                        lecture: it.lecture_id.startsWith("chapter:")
                          ? it.lecture_id
                          : chapterNavId(it.chapter || it.root_zh || ""),
                      })
                    }
                  >
                    <span>{it.root_zh || it.chapter || it.lecture_id}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {lecturesForNav.length > 0 && (
            <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
              <p className={shell.navLabel}>
                讲次{activeChapter ? ` · ${activeChapter.replace(/^第\s*\d+\s*章\s*/, "")}` : ""}
              </p>
              <div className={shell.navScroll}>
                {lecturesForNav.map((it) => (
                  <button
                    key={it.lecture_id}
                    type="button"
                    className={
                      it.lecture_id === navId ? shell.navItemActive : shell.navItem
                    }
                    onClick={() => setSp({ lecture: it.lecture_id })}
                  >
                    <span>第 {it.lecture_id} 讲</span>
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
              <h2>{titleText}</h2>
              <p>
                {current?.chapter && !parseChapterNavId(navId)
                  ? current.chapter
                  : null}
                {doc?.meta?.source || doc?.meta?.composed_from ? (
                  <span style={{ marginLeft: current?.chapter ? 8 : 0, opacity: 0.75 }}>
                    {sourceLabel(doc.meta?.source, doc.meta?.composed_from)}
                  </span>
                ) : null}
              </p>
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
              </div>
            )}

            <div className={shell.tools}>
              <button
                type="button"
                className={shell.toolBtn}
                onClick={() => setExpandAll((v) => !v)}
              >
                {expandAll ? "收起导图" : "展开导图"}
              </button>
            </div>
          </header>

          {error && <p className="empty-hint">{error}</p>}
          {!doc && !error && <p className="empty-hint">加载导图…</p>}

          {doc && (
            <div className={shell.canvasWrap}>
              <MindmapTree
                doc={doc}
                resetKey={mapKey}
                expandAll={expandAll}
                selectedId={selected?.id || null}
                onSelect={setSelected}
                editEnabled
                courseId={courseId}
                lectureId={navId}
                onDocChange={setDoc}
                onHistoryChange={setHistoryItems}
                undoRef={mindUndoRef}
                onResetEdits={() => {
                  setMapKey((k) => k + 1);
                  if (!index) return;
                  loadMindmapDoc(courseId, navId, index.items)
                    .then((d) => setDoc(d))
                    .catch(() => null);
                }}
              />
            </div>
          )}
        </main>
      }
      detail={
        <aside className={pipe.side}>
          <CollapsiblePanel title="选中节点" storageKey="mindmap-panel-node" defaultOpen>
            {selected ? (
              <div className={pipe.detailCard}>
                <div className={pipe.detailBadge}>实体</div>
                <p style={{ margin: "8px 0 4px" }}>
                  <strong>{selected.zh}</strong>
                </p>
                <p className={pipe.sideEmpty} style={{ padding: 0 }}>
                  {selected.id}
                  {selected.relation ? ` · ${selected.relation}` : ""}
                </p>
                {lectureIdForLinks ? (
                  <div className={pipe.cueList} style={{ marginTop: 10 }}>
                    <Link
                      className={pipe.cueBtn}
                      to={reviewWatchPath(courseId, lectureIdForLinks, {
                        kp: selected.id,
                        t: nodeWatch?.startSec,
                      })}
                    >
                      在单课复习中查看
                    </Link>
                    <Link
                      className={pipe.cueBtn}
                      to={coursePath(
                        courseId,
                        `/kg/lecture/${lectureIdForLinks}?focus=${encodeURIComponent(selected.id)}`
                      )}
                    >
                      在课堂图谱中打开
                    </Link>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className={pipe.sideEmpty}>点击导图节点查看详情与资源</div>
            )}
          </CollapsiblePanel>

          <CollapsiblePanel
            title="操作历史"
            storageKey="mindmap-panel-history"
            defaultOpen
          >
            <MindmapHistoryPanel
              items={historyItems}
              onUndo={() => mindUndoRef.current?.()}
            />
          </CollapsiblePanel>

          {chapterForOutline ? (
            <CollapsiblePanel
              title="大纲 / 总结输入"
              storageKey="mindmap-panel-outline"
              defaultOpen
            >
              <ChapterOutlinePanel
                courseId={courseId}
                chapter={chapterForOutline}
                onApplied={async (outlineText, meta) => {
                  await rebuildChapterFromOutline(outlineText, meta);
                }}
              />
            </CollapsiblePanel>
          ) : null}

          <CollapsiblePanel
            title="局部关联"
            storageKey="mindmap-panel-local"
            defaultOpen={Boolean(isLeafish)}
          >
            {selected && !selected.id.startsWith("__") ? (
              <div className={pipe.detailCard}>
                {selected.deps?.length ? (
                  <div style={{ marginBottom: 10 }}>
                    <div className={pipe.detailBadge}>依赖</div>
                    <p className={pipe.sideEmpty} style={{ padding: "6px 0 0" }}>
                      {selected.deps.join("、")}
                    </p>
                  </div>
                ) : null}
                {selected.related?.length ? (
                  <div style={{ marginBottom: 10 }}>
                    <div className={pipe.detailBadge}>相关</div>
                    <p className={pipe.sideEmpty} style={{ padding: "6px 0 0" }}>
                      {selected.related.join("、")}
                    </p>
                  </div>
                ) : null}
                {selected.children?.length ? (
                  <div>
                    <div className={pipe.detailBadge}>树下附属</div>
                    <p className={pipe.sideEmpty} style={{ padding: "6px 0 0" }}>
                      {selected.children.map((c) => c.zh).join("、")}
                    </p>
                  </div>
                ) : null}
                {!selected.deps?.length &&
                !selected.related?.length &&
                !selected.children?.length ? (
                  <div className={pipe.sideEmpty}>无局部关联；见下方资产卡</div>
                ) : null}
              </div>
            ) : (
              <div className={pipe.sideEmpty}>选中概念叶查看依赖 / 相关 / 附属</div>
            )}
          </CollapsiblePanel>

          <CollapsiblePanel title="相关公式 · 例子 · 定理" storageKey="mindmap-panel-assets" defaultOpen>
            <RelatedAssetsPanel
              entityId={selected?.id || null}
              library={library}
              lectureId={lectureIdForLinks || null}
              lectureOnly={Boolean(lectureIdForLinks)}
            />
          </CollapsiblePanel>
        </aside>
      }
    />
  );
}
