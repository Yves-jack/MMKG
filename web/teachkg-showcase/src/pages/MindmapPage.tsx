import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CollapsiblePanel } from "@/components/graph/CollapsiblePanel";
import { RelatedAssetsPanel, countRelatedAssets } from "@/components/graph/SelectionPanels";
import { ResizableShell } from "@/components/graph/ResizableShell";
import {
  MindmapTree,
  type MindmapDoc,
  type MindmapTreeNode,
} from "@/components/mindmap/MindmapTree";
import { bindMasteryToMindmap, masteryScore, type MasteryPayload } from "@/lib/kg/mindmapMasteryBinding.mjs";
import details from "@/components/mindmap/MasteryNodeDetails.module.css";
import { loadPersonalMasteryProgress, personalMasteryLectureLimit, type LectureKnowledgeSource } from "@/lib/kg/masteryLectureProgress.mjs";
import { StudentMasteryMindmap } from "@/components/mindmap/StudentMasteryMindmap";
import {
  ensureAssetsLibraryIndexes,
  groupChaptersByPart,
  mindmapNodeAssetPolicy,
  RELATED_ASSET_KINDS,
  type AssetsChapterCatalog,
  type AssetsLibrary,
} from "@/lib/kg/assetsLibrary";
import { loadReviewLectureMindmap } from "@/lib/review/loadReviewClassroomGraph";
import {
  pairLecturesIntoSessions,
  parseSessionRouteId,
  sessionIndexFromLectureIds,
} from "@/lib/review/reviewSession";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import { ChapterOutlinePanel } from "@/components/mindmap/ChapterOutlinePanel";
import {
  buildChapterMindmapDoc,
  mergeMindmapIndexWithChapters,
} from "@/lib/kg/mindmapChapterMerge";
import {
  buildChapterMindmapFromSkeleton,
  leavesFromReviewPoints,
  parseOutlineText,
} from "@/lib/kg/mindmapChapterSkeleton";
import {
  loadChapterCatalog,
  loadCourseMindmapStitched,
  tryLoadMindmapSlicedFromChapters,
} from "@/lib/kg/mindmapComposeLoad";
import { pruneMindmapRedundancy } from "@/lib/kg/mindmapPruneRedundancy";
import { loadWrappedLectureMindmap } from "@/lib/kg/mindmapLectureTree";
import {
  readSharedEntitySelection,
  SHARED_PANEL_KEYS,
  writeSharedEntitySelection,
} from "@/lib/kg/sharedEntitySelection";
import {
  LinkedResourceCardList,
  LinkedResourceJumpBar,
  ResourceCardFold,
} from "@/components/graph/LinkedResourceCards";
import {
  applyMindmapEditPatch,
  clearMindmapEditPatch,
  isStaleMindmapEditPatch,
  loadMindmapEditPatch,
} from "@/lib/review/mindmapEdits";
import {
  chapterFileSlug,
  chapterNavId,
  displayChapterName,
  isAnyCourseNavId,
  isCourseNavId,
  isCourseSkeletonNavId,
  parseChapterNavId,
  type MindmapIndexDoc,
  type MindmapIndexItem,
} from "@/lib/kg/mindmapTypes";
import { canEditKnowledgeGraph } from "@/lib/integration/editPermission";
import {
  emitKnowledgeResourceOpen,
  fetchLinkedKnowledgeResources,
  matchedKnowledgePointId,
  matchedKnowledgePointLabel,
  mmkgCachedRole,
  mmkgLogin,
  resolvePracticeSeedKp,
  type LinkedKnowledgeResource,
} from "@/lib/integration/knowledgeResources";
import { knowledgeResourceIdentity, isStructuralMindmapNode } from "@/lib/kg/mindmapResourceIdentity.mjs";
import { withBase } from "@/lib/withBase";
import pipe from "@/styles/panels.module.css";
import assetsNav from "@/pages/AssetsPage.module.css";
import kg from "@/pages/KgPage.module.css";
import shell from "@/styles/shell.module.css";

const EMPTY_MASTERY: Readonly<Record<string, number>> = Object.freeze({});

async function loadStaticLectureMindmap(
  courseId: string,
  lectureId: string,
  chapterHint?: string | null,
  chapterOrder?: string[] | null,
  variant?: string | null
): Promise<MindmapDoc | null> {
  const file =
    variant === "deep"
      ? `mindmaps/lecture_${lectureId}.deep.json`
      : `mindmaps/lecture_${lectureId}.json`;
  try {
    const r = await fetch(
      `${courseDataUrl(courseId, file)}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!r.ok) {
      if (variant === "deep") {
        return loadStaticLectureMindmap(
          courseId,
          lectureId,
          chapterHint,
          chapterOrder,
          null
        );
      }
      return null;
    }
    const d = (await r.json()) as MindmapDoc;
    if (!d?.root && !d?.roots?.length) return null;
    return loadWrappedLectureMindmap(courseId, lectureId, d, {
      chapterHint: chapterHint || d.meta?.chapter,
      chapterOrder: chapterOrder || null,
    });
  } catch {
    return null;
  }
}

async function loadMindmapDoc(
  courseId: string,
  navId: string,
  items: MindmapIndexItem[],
  catalog?: AssetsChapterCatalog | null,
  lectureVariant?: string | null
): Promise<MindmapDoc> {
  if (isCourseSkeletonNavId(navId)) {
    return loadCourseMindmapStitched(courseId, items, {
      catalog,
      skeletonOnly: true,
    });
  }
  if (isCourseNavId(navId)) {
    return loadCourseMindmapStitched(courseId, items, { catalog });
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
        return pruneMindmapRedundancy({
          ...d,
          meta: {
            ...d.meta,
            scope: "chapter",
            chapter: chapterTitle,
            lecture_ids: d.meta?.lecture_ids || item?.lecture_ids,
            source: d.meta?.source || item?.source || "kg",
          },
        });
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
      const staticDoc = await loadStaticLectureMindmap(
        courseId,
        String(lid),
        chapterTitle,
        undefined,
        lectureVariant
      );
      if (staticDoc) {
        // 章导图合并用裸主题树：若已包成讲次→章，则只取匹配本章的子树
        const roots = staticDoc.roots?.length
          ? staticDoc.roots
          : staticDoc.root
            ? [staticDoc.root]
            : [];
        let body = roots;
        if (
          roots.length === 1 &&
          String(roots[0].id).startsWith("__lecture__/")
        ) {
          const bare = chapterTitle.replace(/^第\s*\d+\s*章\s*/, "").trim();
          const chKids = (roots[0].children || []).filter(
            (c) =>
              c.zh === chapterTitle ||
              String(c.id).includes(bare) ||
              String(c.zh || "").includes(bare)
          );
          body = chKids.length
            ? chKids.flatMap((c) => c.children || [])
            : [];
          // 本讲包装里没有本章枝：若 index 把该讲标成此章，则用整讲主题森林兜底
          if (!body.length) {
            body = (roots[0].children || []).flatMap((c) => {
              if (String(c.id || "").startsWith("__chapter__/")) {
                return c.children || [];
              }
              return [c];
            });
          }
        }
        lectures.push({
          lectureId: String(lid),
          doc: {
            ...staticDoc,
            root: body[0] || {
              id: `__tmp__/${lid}`,
              zh: chapterTitle,
              importance: 0.4,
              relation: null,
              related: [],
              children: body,
            },
            roots: body.length
              ? body
              : [
                  {
                    id: `__tmp__/${lid}`,
                    zh: chapterTitle,
                    importance: 0.4,
                    relation: null,
                    related: [],
                    children: [],
                  },
                ],
          },
        });
        continue;
      }
      const doc = await loadReviewLectureMindmap(courseId, lid, {
        chapter: chapterTitle,
        preferChapterSlice: false,
      });
      lectures.push({ lectureId: lid, doc: pruneMindmapRedundancy(doc) });
    }
    const hasReview = lectures.some((l) => l.doc.meta?.source === "review+kg");
    return pruneMindmapRedundancy(
      buildChapterMindmapDoc(chapterTitle, lectures, {
        source: hasReview ? "review+kg" : "kg",
      })
    );
  }

  // 课次（1_2）或单讲：优先从章导图裁剪，否则投影/静态
  const sessionParsed = parseSessionRouteId(navId);
  if (sessionParsed) {
    const lids = sessionParsed.lectureIds;
    const sliced = await tryLoadMindmapSlicedFromChapters(courseId, lids, {
      items,
      sessionId: sessionParsed.id,
    });
    if (sliced) return pruneMindmapRedundancy(sliced);

    if (lids.length === 1) {
      const lid = lids[0];
      const lectureItem = items.find((i) => i.lecture_id === lid);
      const staticLec = await loadStaticLectureMindmap(
        courseId,
        lid,
        lectureItem?.chapter,
        catalog?.chapter_order || null,
        lectureVariant
      );
      if (staticLec) return staticLec;
      const projected = await loadReviewLectureMindmap(courseId, lid, {
        chapter: lectureItem?.chapter,
        preferChapterSlice: false,
      });
      return loadWrappedLectureMindmap(
        courseId,
        lid,
        pruneMindmapRedundancy(projected),
        {
          chapterHint: lectureItem?.chapter,
          chapterOrder: catalog?.chapter_order || null,
        }
      );
    }

    // 双讲课次：合并两讲静态/投影树
    const kids: MindmapTreeNode[] = [];
    for (const lid of lids) {
      const lectureItem = items.find((i) => i.lecture_id === lid);
      const staticLec = await loadStaticLectureMindmap(
        courseId,
        lid,
        lectureItem?.chapter,
        catalog?.chapter_order || null,
        lectureVariant
      );
      if (staticLec) {
        const roots = staticLec.roots?.length
          ? staticLec.roots
          : staticLec.root
            ? [staticLec.root]
            : [];
        kids.push(...roots);
        continue;
      }
      try {
        const projected = await loadReviewLectureMindmap(courseId, lid, {
          chapter: lectureItem?.chapter,
          preferChapterSlice: false,
        });
        const wrapped = await loadWrappedLectureMindmap(
          courseId,
          lid,
          pruneMindmapRedundancy(projected),
          {
            chapterHint: lectureItem?.chapter,
            chapterOrder: catalog?.chapter_order || null,
          }
        );
        const roots = wrapped.roots?.length
          ? wrapped.roots
          : wrapped.root
            ? [wrapped.root]
            : [];
        kids.push(...roots);
      } catch {
        /* skip */
      }
    }
    const label = `第 ${sessionIndexFromLectureIds(lids)} 次课`;
    const root: MindmapTreeNode = {
      id: `__lecture__/${sessionParsed.id}`,
      zh: label,
      importance: 0.7,
      relation: null,
      related: [],
      children: kids,
    };
    return pruneMindmapRedundancy({
      lecture_id: sessionParsed.id,
      root,
      roots: [root],
      n_nodes: 1,
      max_depth: 1,
      orphan_count: 0,
      meta: {
        root_zh: label,
        virtual_root: true,
        scope: "lecture",
        lecture_ids: lids,
        source: "kg",
        composed_from: "chapters",
      },
    });
  }

  // 兜底：未知导航键
  throw new Error(`无法加载导图：${navId || "(空)"}`);
}

function isSyntheticMindmapNode(node: MindmapTreeNode) {
  return isStructuralMindmapNode(node);
}

function shortEntityKey(id: string) {
  return String(id || "").split("/")[0]?.trim() || "";
}

function matchKgEntityId(
  node: MindmapTreeNode,
  kgIds: Set<string>,
  kgByShort: Map<string, string>,
  redirects?: Record<string, string> | null
): string | null {
  if (isSyntheticMindmapNode(node)) return null;
  const tryIds = [node.id, node.zh, redirects?.[node.id], redirects?.[node.zh]]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const lowerMap = new Map<string, string>();
  for (const id of kgIds) {
    lowerMap.set(id.toLowerCase(), id);
    const zh = shortEntityKey(id);
    if (zh) lowerMap.set(zh.toLowerCase(), id);
  }
  for (const raw of tryIds) {
    if (kgIds.has(raw)) return raw;
    const short = shortEntityKey(raw);
    if (short && kgIds.has(short)) return short;
    const hit =
      kgByShort.get(raw) ||
      (short ? kgByShort.get(short) : undefined) ||
      lowerMap.get(raw.toLowerCase()) ||
      (short ? lowerMap.get(short.toLowerCase()) : undefined);
    if (hit) return hit;
  }
  return null;
}

function findMindmapNodeByFocus(
  doc: MindmapDoc,
  raw: string
): MindmapTreeNode | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(String(raw || "").trim()).trim();
    } catch {
      return String(raw || "").trim();
    }
  })();
  if (!decoded) return null;
  const zh = shortEntityKey(decoded).toLowerCase();
  const roots = doc.roots?.length ? doc.roots : doc.root ? [doc.root] : [];
  let hit: MindmapTreeNode | null = null;
  const walk = (n: MindmapTreeNode) => {
    if (hit) return;
    if (!isSyntheticMindmapNode(n)) {
      const id = String(n.id || "");
      const label = String(n.zh || "");
      if (
        id === decoded ||
        label === decoded ||
        shortEntityKey(id).toLowerCase() === zh ||
        shortEntityKey(label).toLowerCase() === zh
      ) {
        hit = n;
        return;
      }
    }
    for (const c of n.children || []) walk(c);
  };
  for (const r of roots) walk(r);
  return hit;
}

export function MindmapPage() {
  const courseId = useCourseId();
  const [sp, setSp] = useSearchParams();
  const [index, setIndex] = useState<MindmapIndexDoc | null>(null);
  const [catalog, setCatalog] = useState<AssetsChapterCatalog | null>(null);
  const [doc, setDoc] = useState<MindmapDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapKey, setMapKey] = useState(0);
  const [selected, setSelected] = useState<MindmapTreeNode | null>(null);
  const [assetsPanelOpen, setAssetsPanelOpen] = useState(true);
  const focusAppliedRef = useRef("");
  const [library, setLibrary] = useState<AssetsLibrary | null>(null);
  const [kgIds, setKgIds] = useState<Set<string>>(() => new Set());
  const [kgByShort, setKgByShort] = useState<Map<string, string>>(() => new Map());
  const [sideLinkedResources, setSideLinkedResources] = useState<{
    nodeId: string;
    loading: boolean;
    resources: LinkedKnowledgeResource[];
    error: string;
    matchedKpId?: string;
    matchedKpLabel?: string;
  } | null>(null);
  const sideResourceSeq = useRef(0);
  const [lectureNavOpen, setLectureNavOpen] = useState(true);
  const [chapterNavOpen, setChapterNavOpen] = useState(true);
  const [partOpen, setPartOpen] = useState<Record<string, boolean>>({});
  const [detailCollapsed, setDetailCollapsed] = useState(true);
  const [studentMastery, setStudentMastery] = useState<{
    identity: string;
    scores: Record<string, number>;
    scope?: "personal" | "class_average";
    learnerCount?: number;
  }>({ identity: "", scores: Object.create(null) });
  const [masteryMessage, setMasteryMessage] = useState("");
  const [masteryRefresh, setMasteryRefresh] = useState(0);
  /** 大纲重建后更新 index 时跳过一次磁盘重载，避免缓存旧文件盖掉新图 */
  const skipNextDocLoadRef = useRef(false);

  const requestedNavId = sp.get("lecture") || "";
  const focusParam = String(sp.get("focus") || "").trim();
  const lectureVariant = sp.get("deep") === "1" ? "deep" : null;
  const lectureQuery = (lecture: string) => {
    const next = new URLSearchParams(sp);
    next.set("lecture", lecture);
    if (lectureVariant === "deep") next.set("deep", "1");
    else next.delete("deep");
    return next;
  };
  const embedMode = String(sp.get("embed") || "").trim();
  const isAiTeachingEmbed = embedMode === "ai-teaching";
  const integrationCourseId = String(sp.get("course_id") || "").trim();
  const resourceCourseId = String(sp.get("resource_course_id") || integrationCourseId).trim();
  const kgLaunchToken = String(sp.get("kg_token") || "").trim();
  const masteryIdentity = `${resourceCourseId}\u0000${kgLaunchToken}`;
  const roleParam = String(sp.get("role") || "").trim();
  const requestedParentOrigin = String(sp.get("parent_origin") || "").trim();
  const [verifiedRole, setVerifiedRole] = useState("");
  const isMasteryEmbed = isAiTeachingEmbed && sp.get("mastery_view") === "1" &&
    ["student", "studentenrollment", "ta", "taenrollment", "teacher", "teacherenrollment"].includes(verifiedRole.toLowerCase().trim());
  const compactMastery = isMasteryEmbed && sp.get("compact") === "1";
  const completedMasteryLecture = isMasteryEmbed && ["student", "studentenrollment"].includes(verifiedRole.toLowerCase().trim())
    ? personalMasteryLectureLimit(courseId) : null;
  const navId = isMasteryEmbed ? "course" : requestedNavId;
  const canEditMindmap = useMemo(
    () =>
      !isMasteryEmbed && canEditKnowledgeGraph({
        embedMode,
        role: embedMode ? verifiedRole || mmkgCachedRole(kgLaunchToken) : roleParam,
        kgToken: kgLaunchToken,
      }),
    [isMasteryEmbed, embedMode, roleParam, verifiedRole, kgLaunchToken],
  );
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
      items
        .filter(
          (i) =>
            i.lecture_id !== "course" &&
            i.scope !== "course" &&
            i.scope !== "chapter" &&
            !String(i.lecture_id).startsWith("chapter:")
        )
        .sort(
          (a, b) =>
            Number(a.lecture_id) - Number(b.lecture_id) ||
            String(a.lecture_id).localeCompare(String(b.lecture_id), "zh")
        ),
    [items]
  );

  const chapterGroups = useMemo(() => {
    // 只列本学期有导图的章（有讲次内容），不把目录里未讲的空章塞进侧栏
    const names = new Set<string>();
    for (const it of chapterItems) {
      const n = String(it.chapter || it.root_zh || "").trim();
      if (!n) continue;
      const nodes = Number(it.n_nodes) || 0;
      const lids = it.lecture_ids?.length || 0;
      if (nodes <= 1 && lids === 0) continue;
      names.add(n);
    }
    return groupChaptersByPart([...names], catalog || library?.chapter_catalog);
  }, [chapterItems, catalog, library?.chapter_catalog]);

  useEffect(() => {
    if (!chapterGroups.length) return;
    setPartOpen((prev) => {
      const next = { ...prev };
      for (const p of chapterGroups) {
        if (next[p.id] === undefined) next[p.id] = true;
      }
      return next;
    });
  }, [chapterGroups]);

  useEffect(() => {
    if (!embedMode || !kgLaunchToken) {
      setVerifiedRole("");
      return;
    }
    let cancelled = false;
    mmkgLogin(kgLaunchToken)
      .then((claims) => {
        if (!cancelled) setVerifiedRole(claims.role || "");
      })
      .catch(() => {
        if (!cancelled) setVerifiedRole("");
      });
    return () => {
      cancelled = true;
    };
  }, [embedMode, kgLaunchToken]);

  useEffect(() => {
    if (isMasteryEmbed) setDetailCollapsed(true);
  }, [isMasteryEmbed]);

  useEffect(() => {
    if (!isMasteryEmbed) return;
    setStudentMastery((previous) => previous.identity === masteryIdentity ? previous : { identity: "", scores: Object.create(null) });
    if (!resourceCourseId || !kgLaunchToken) {
      setMasteryMessage("缺少课程或访问凭据，无法读取掌握分数");
      return;
    }
    let cancelled = false;
    setMasteryMessage("正在读取掌握分数…");
    fetch(withBase(`/api/student-mastery?course_id=${encodeURIComponent(resourceCourseId)}`), {
      headers: { "X-KG-Token": kgLaunchToken },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`掌握分数接口返回 ${response.status}`);
        return response.json() as Promise<MasteryPayload>;
      })
      .then((payload) => {
        if (cancelled) return;
        const next = bindMasteryToMindmap(payload);
        setStudentMastery({ identity: masteryIdentity, scores: next, scope: payload.scope, learnerCount: payload.learner_count });
        setMasteryMessage(Object.keys(payload.mastery || {}).length ? "" : "当前课程暂无掌握度记录，完成练习后将在这里显示");
      })
      .catch((reason) => {
        if (cancelled) return;
        setStudentMastery({ identity: "", scores: Object.create(null) });
        setMasteryMessage(`掌握分数暂不可用：${reason instanceof Error ? reason.message : String(reason)}`);
      });
    return () => { cancelled = true; };
  }, [isMasteryEmbed, resourceCourseId, kgLaunchToken, masteryIdentity, masteryRefresh]);

  useEffect(() => {
    if (!isMasteryEmbed) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setMasteryRefresh((value) => value + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [isMasteryEmbed]);

  /** 仅在选中「章」导图时高亮对应章；选讲次不高亮章 */
  const selectedChapterNav = parseChapterNavId(navId) || "";

  const sessionNavItems = useMemo(() => {
    const lids = lectureItems.map((i) => String(i.lecture_id));
    return pairLecturesIntoSessions(lids).map((s) => {
      const idx = sessionIndexFromLectureIds(s.lectureIds);
      return {
        id: s.id,
        lectureIds: s.lectureIds,
        index: idx,
        label: `第 ${idx} 次课`,
        title:
          s.lectureIds.length === 2
            ? `第 ${idx} 次课（第 ${s.lectureIds[0]}–${s.lectureIds[1]} 讲）`
            : `第 ${idx} 次课（第 ${s.lectureIds[0]} 讲）`,
      };
    });
  }, [lectureItems]);

  /** 章/整课：不按讲次收窄；单讲/session：传讲次仅作排序优先 */
  const lectureIdForLinks = useMemo(() => {
    if (!navId || isAnyCourseNavId(navId) || parseChapterNavId(navId)) {
      return "";
    }
    const parsed = parseSessionRouteId(navId);
    return parsed?.lectureIds[0] || navId;
  }, [navId]);

  const parentOrigin = useMemo(() => {
    if (typeof document === "undefined" || !document.referrer) return "";
    try {
      const referrerOrigin = new URL(document.referrer).origin;
      if (!requestedParentOrigin) return referrerOrigin;
      return new URL(requestedParentOrigin).origin === referrerOrigin
        ? referrerOrigin
        : "";
    } catch {
      return "";
    }
  }, [requestedParentOrigin]);

  const kgEntityId = useMemo(() => {
    if (!selected) return null;
    return matchKgEntityId(selected, kgIds, kgByShort, doc?.id_redirects);
  }, [selected, kgIds, kgByShort, doc?.id_redirects]);

  const linkedEntityId = knowledgeResourceIdentity(selected, kgEntityId);

  const assetPolicy = useMemo(
    () => (selected ? mindmapNodeAssetPolicy(selected.id) : "none"),
    [selected]
  );

  /**
   * 叶：KG 全名 + 标题 + redirect，概念/边挂载（不含卡名乱撞）。
   * topic：仅标题索引精确命中。
   * 章节：不匹配。
   */
  const mindmapAssetQuery = useMemo(() => {
    if (!selected || assetPolicy === "none") {
      return { entityId: null as string | null, aliases: [] as string[] };
    }
    const zh = String(selected.zh || "").trim();
    if (assetPolicy === "strict") {
      const label =
        zh ||
        String(selected.id || "")
          .split("/")
          .filter((p) => p && !p.startsWith("__"))
          .pop() ||
        "";
      return { entityId: label || null, aliases: [] as string[] };
    }
    // leaf：优先规范实体 id；补标题与 redirect，避免只靠短名乱扩
    const rawId = String(selected.id || "").trim();
    const looksEntity =
      Boolean(rawId) &&
      !rawId.startsWith("__") &&
      !rawId.startsWith("chapter:") &&
      !rawId.startsWith("part:");
    const out = new Set<string>();
    for (const v of [
      kgEntityId || "",
      zh,
      looksEntity ? rawId : "",
      doc?.id_redirects?.[rawId],
      zh ? doc?.id_redirects?.[zh] : "",
    ]) {
      const t = String(v || "").trim();
      if (t) out.add(t);
    }
    const entityId = kgEntityId || (looksEntity ? rawId : "") || zh || null;
    const aliases = [...out].filter((a) => a && a !== entityId);
    return { entityId, aliases };
  }, [selected, assetPolicy, kgEntityId, doc?.id_redirects]);

  const selectMindmapNode = (node: MindmapTreeNode | null) => {
    setSelected(node);
    if (!node) {
      writeSharedEntitySelection(null);
      return;
    }
    setDetailCollapsed(false);
    if (compactMastery) setAssetsPanelOpen(true);
    const eid = matchKgEntityId(node, kgIds, kgByShort, doc?.id_redirects);
    writeSharedEntitySelection({
      id: eid || node.id,
      label: node.zh || shortEntityKey(eid || node.id),
    });
  };

  /** 章 / 课次：用关联章做大纲；整课与骨架不展示输入框 */
  const chapterForOutline = useMemo(() => {
    if (!navId || isAnyCourseNavId(navId)) return "";
    const chNav = parseChapterNavId(navId);
    if (chNav) return chNav;
    const sess = parseSessionRouteId(navId);
    const lids = sess?.lectureIds || [navId];
    for (const lid of lids) {
      const item = items.find((i) => String(i.lecture_id) === String(lid));
      const ch = String(item?.chapter || "").trim();
      if (ch) return ch;
    }
    return String(doc?.meta?.chapter || "").trim();
  }, [navId, items, doc?.meta?.chapter]);

  const rebuildChapterFromOutline = async (
    outlineText: string,
    meta?: { source?: string | null }
  ) => {
    if (!canEditMindmap) {
      throw new Error("当前角色无导图编辑权限");
    }
    if (!chapterForOutline || !index) {
      throw new Error("请先在左侧选中具体「章」或「课次」再更新大纲");
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
        const d = await loadReviewLectureMindmap(courseId, String(lid), {
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

    // 若当前在课次视图，重建章后重新裁剪课次图
    const sess = parseSessionRouteId(navId);
    if (sess) {
      skipNextDocLoadRef.current = true;
      // 先落盘章导图，再按课次重载
    } else {
      setDoc(next);
      setMapKey((k) => k + 1);
      setSelected(null);
    }

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
        throw new Error(
          String((err as { error?: string })?.error || "章导图写入磁盘失败")
        );
      }
      if (index) {
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
      if (sess) {
        const sliced = await loadMindmapDoc(
          courseId,
          navId,
          index?.items || items,
          catalog,
          lectureVariant
        );
        setDoc(sliced);
        setMapKey((k) => k + 1);
        setSelected(null);
      }
    } catch (e) {
      console.warn("persist chapter mindmap failed", e);
      throw e;
    }
  };

  useEffect(() => {
    fetch(`${courseDataUrl(courseId, "assets_library.json")}?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) =>
        setLibrary(
          d && Array.isArray(d.cards) ? ensureAssetsLibraryIndexes(d) : null
        )
      )
      .catch(() => setLibrary(null));
  }, [courseId]);

  useEffect(() => {
    fetch(`${courseDataUrl(courseId, "entity_importance_lookup.json")}?t=${Date.now()}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (j: {
          scores?: Record<string, number>;
          classroom?: Record<string, number>;
        } | null) => {
          const scores = j?.scores && typeof j.scores === "object" ? j.scores : {};
          const ids = new Set(Object.keys(scores));
          const byShort = new Map<string, string>();
          for (const id of ids) {
            const short = shortEntityKey(id);
            if (short && !byShort.has(short)) byShort.set(short, id);
          }
          setKgIds(ids);
          setKgByShort(byShort);
        }
      )
      .catch(() => {
        setKgIds(new Set());
        setKgByShort(new Map());
      });
  }, [courseId]);

  const openLinkedResource = (resource: LinkedKnowledgeResource) => {
    const selectedKp = String(linkedEntityId || selected?.id || "").trim();
    const seedKp = resolvePracticeSeedKp({
      matchedKpId: sideLinkedResources?.matchedKpId,
      selectedNodeId: selectedKp,
    });
    const matchedLabel =
      String(sideLinkedResources?.matchedKpLabel || "").trim() ||
      String(selected?.zh || "").trim();
    const baseMeta: Record<string, unknown> = {
      ...(resource.metadata || {}),
      course_id:
        (resource.metadata as Record<string, unknown> | undefined)?.course_id ||
        resourceCourseId ||
        courseId,
    };
    const enriched: LinkedKnowledgeResource =
      seedKp &&
      (resource.resource_type === "video" || resource.resource_type === "exercise")
        ? {
            ...resource,
            course_id: resource.course_id || resourceCourseId || courseId,
            resource_id:
              resource.resource_type === "exercise" ? seedKp : resource.resource_id,
            knowledge_point_ids:
              resource.resource_type === "exercise" ? [seedKp] : resource.knowledge_point_ids,
            metadata: {
              ...baseMeta,
              knowledge_point_id: seedKp,
              seed_knowledge_point_id: seedKp,
              seed_knowledge_point_label: matchedLabel || undefined,
              knowledge_point_ids: [seedKp],
              kp: seedKp,
              practice_mode:
                resource.resource_type === "exercise"
                  ? "knowledge_point"
                  : baseMeta.practice_mode,
              graph_node_id: selectedKp || undefined,
            },
          }
        : {
            ...resource,
            course_id: resource.course_id || resourceCourseId || courseId,
            metadata: baseMeta,
          };
    if (embedMode === "ai-teaching" && parentOrigin) {
      emitKnowledgeResourceOpen(enriched, parentOrigin);
      return;
    }
    if (enriched.url) {
      window.open(enriched.url, "_blank", "noopener,noreferrer");
      return;
    }
    window.alert("该资源需要从交学伴嵌入页面打开");
  };

  useEffect(() => {
    if (!linkedEntityId) {
      setSideLinkedResources(null);
      return;
    }
    const nodeId = linkedEntityId;
    if (!isAiTeachingEmbed) {
      setSideLinkedResources({
        nodeId,
        loading: false,
        resources: [],
        error: "",
      });
      return;
    }
    if (!resourceCourseId || !kgLaunchToken) {
      setSideLinkedResources({
        nodeId,
        loading: false,
        resources: [],
        error: resourceCourseId ? "缺少知识图谱访问凭据" : "嵌入地址缺少 course_id",
      });
      return;
    }
    const seq = ++sideResourceSeq.current;
    setSideLinkedResources({
      nodeId,
      loading: true,
      resources: [],
      error: "",
    });
    void fetchLinkedKnowledgeResources({
      courseId: resourceCourseId,
      knowledgePointId: nodeId,
      kgToken: kgLaunchToken,
      nodeName: selected?.zh || shortEntityKey(nodeId),
      nodeAliases: selected?.zh ? [selected.zh] : [],
    })
      .then((result) => {
        if (seq !== sideResourceSeq.current) return;
        setSideLinkedResources({
          nodeId,
          loading: false,
          resources: result.resources,
          error: "",
          matchedKpId: matchedKnowledgePointId(result.match) || undefined,
          matchedKpLabel: matchedKnowledgePointLabel(result.match) || undefined,
        });
      })
      .catch((reason) => {
        if (seq !== sideResourceSeq.current) return;
        setSideLinkedResources({
          nodeId,
          loading: false,
          resources: [],
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
  }, [
    linkedEntityId,
    isAiTeachingEmbed,
    resourceCourseId,
    kgLaunchToken,
    selected?.zh,
  ]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(courseDataUrl(courseId, "mindmaps/index.json")).then((r) => {
        if (!r.ok) throw new Error("缺少 mindmaps/index.json，请先运行导图流水线");
        return r.json();
      }),
      loadChapterCatalog(courseId),
    ])
      .then(([d, cat]: [MindmapIndexDoc, AssetsChapterCatalog | null]) => {
        if (cancelled) return;
        setCatalog(cat);
        const merged: MindmapIndexDoc = {
          ...d,
          items: mergeMindmapIndexWithChapters(d.items || [], {
            chapterOrder: cat?.chapter_order,
          }),
        };
        setIndex(merged);
        const preferred =
          navId ||
          merged.items.find((i) => i.lecture_id === "course")?.lecture_id ||
          merged.items.find((i) => i.scope === "chapter")?.lecture_id ||
          merged.items[0]?.lecture_id;
        if (preferred && !navId) {
          setSp(lectureQuery(preferred), { replace: true });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e));
      });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    if (!navId || !index) return;
    if (skipNextDocLoadRef.current) {
      skipNextDocLoadRef.current = false;
      return;
    }
    setError(null);
    // 先清空旧图，避免整课↔骨架切换时用旧树 hydrate 新 expandStorageKey
    setDoc(null);
    setMapKey((k) => k + 1);
    setSelected(null);
    focusAppliedRef.current = "";
    let cancelled = false;
    const loadForNav = navId;
    (async () => {
      if (isMasteryEmbed && isCourseNavId(navId)) {
        const response = await fetch(courseDataUrl(courseId, "mindmaps/student_mastery_course.json"), { cache: "no-store" });
        if (response.ok) {
          const uploaded = await response.json() as MindmapDoc;
          if (uploaded?.root && uploaded.meta?.scope === "course") return uploaded;
        }
      }
      return loadMindmapDoc(courseId, navId, index.items, catalog, lectureVariant);
    })()
      .then(async (loaded) => {
        const d = completedMasteryLecture == null ? loaded : await loadPersonalMasteryProgress(
          loaded, completedMasteryLecture, async (path) => {
            try {
              const response = await fetch(courseDataUrl(courseId, path), { cache: "no-store" });
              return response.ok ? await response.json() as LectureKnowledgeSource : null;
            } catch { return null; }
          },
          courseId,
        );
        if (cancelled) return;
        if (isMasteryEmbed) {
          setDoc(d);
          return;
        }
        if (lectureVariant === "deep") {
          setDoc(applyMindmapEditPatch(d, null));
          return;
        }
        const patch = loadMindmapEditPatch(courseId, loadForNav);
        // 整课结构以服务器为准：有分册层时清掉易把课图压成「两章」的旧本地补丁
        if (
          isAnyCourseNavId(loadForNav) ||
          isStaleMindmapEditPatch(d, patch)
        ) {
          const root = d.roots?.[0] || d.root;
          const hasParts = (root?.children || []).some((c) =>
            String(c.id || "").startsWith("__part__/")
          );
          if (isAnyCourseNavId(loadForNav) && (hasParts || isCourseSkeletonNavId(loadForNav))) {
            clearMindmapEditPatch(courseId, loadForNav);
            setDoc(applyMindmapEditPatch(d, null));
            return;
          }
          if (isStaleMindmapEditPatch(d, patch)) {
            clearMindmapEditPatch(courseId, loadForNav);
            setDoc(applyMindmapEditPatch(d, null));
            return;
          }
        }
        setDoc(applyMindmapEditPatch(d, patch));
      })
      .catch((e) => {
        if (cancelled) return;
        setDoc(null);
        setError(String(e.message || e));
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, navId, index, catalog, lectureVariant, isMasteryEmbed, completedMasteryLecture]);

  // URL ?focus= / 图谱共享选中 → 选中同名导图节点并展开右栏
  useEffect(() => {
    if (!doc) return;
    const shared = readSharedEntitySelection();
    const raw = String(focusParam || shared?.id || shared?.label || "").trim();
    if (!raw) return;
    const applyKey = `${navId}|${mapKey}|${raw}`;
    if (focusAppliedRef.current === applyKey) return;
    const hit = findMindmapNodeByFocus(doc, raw);
    if (!hit) return;
    focusAppliedRef.current = applyKey;
    selectMindmapNode(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only restore on doc/focus
  }, [doc, mapKey, navId, focusParam, kgIds, kgByShort]);

  // 匹配到图谱实体 id 后回写共享选中，便于再跳回图谱定位
  useEffect(() => {
    if (!selected || !kgEntityId) return;
    writeSharedEntitySelection({
      id: kgEntityId,
      label: selected.zh || shortEntityKey(kgEntityId),
    });
  }, [selected, kgEntityId]);

  const selectedAssetCount = selected && assetPolicy !== "none"
    ? countRelatedAssets(mindmapAssetQuery.entityId, library, {
        entityAliases: mindmapAssetQuery.aliases,
        lectureId: lectureIdForLinks || null,
        lectureOnly: false,
        kinds: [...RELATED_ASSET_KINDS],
        matchMode: assetPolicy === "strict" ? "strict" : "concept",
      })
    : 0;
  const selectedAnimationResources = (sideLinkedResources?.resources || []).filter(
    (resource) => resource.resource_type === "animation",
  );
  const selectedResourceCount = selectedAssetCount + selectedAnimationResources.length;

  const titleText = (() => {
    if (isMasteryEmbed) return studentMastery.scope === "class_average" ? "全班平均掌握思维导图" : "知识点掌握思维导图";
    if (isCourseSkeletonNavId(navId)) return "整课骨架展示";
    if (isCourseNavId(navId)) return "整课知识导图";
    const ch = parseChapterNavId(navId);
    if (ch) return displayChapterName(ch);
    const sess = sessionNavItems.find((s) => s.id === navId);
    if (sess) return `第 ${sess.index} 次课`;
    const parsed = parseSessionRouteId(navId);
    if (parsed) {
      return `第 ${sessionIndexFromLectureIds(parsed.lectureIds)} 次课`;
    }
    if (navId) return `第 ${navId} 次课`;
    return "知识导图";
  })();

  return (
    <ResizableShell
      storagePrefix="shell-mindmap"
      detailOverlay={compactMastery}
      detailFixedRightPx={detailCollapsed ? 32 : undefined}
      detailMinRightPx={220}
      detailInitialRightPx={340}
      nav={!isMasteryEmbed ? (
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            {isAiTeachingEmbed ? (
              <Link
                className={`${kg.kgChip} ${kg.kgChipAccent}`}
                style={{ textDecoration: "none", marginBottom: 10 }}
                to={(() => {
                  const q = new URLSearchParams(sp);
                  const fid = kgEntityId || selected?.id || "";
                  if (fid) q.set("focus", String(fid));
                  const search = q.toString();
                  return {
                    pathname: coursePath(courseId, "/kg/course"),
                    search: search ? `?${search}` : "",
                  };
                })()}
                onClick={() => {
                  const fid = kgEntityId || selected?.id || "";
                  if (!fid) return;
                  writeSharedEntitySelection({
                    id: String(fid),
                    label: selected?.zh || shortEntityKey(String(fid)),
                  });
                }}
                title="查看知识图谱"
              >
                查看知识图谱
              </Link>
            ) : (
              <Link className={shell.back} to={coursePath(courseId)} title="返回课程">
                <span className={shell.backIcon} aria-hidden>
                  ←
                </span>
                <span className={shell.backBrand}>
                  Edu<em>KG</em>
                </span>
              </Link>
            )}
            <p className={shell.eyebrow}>Mindmap</p>
            <h1 className={shell.sideTitle}>知识导图</h1>
          </div>

          <div className={shell.navBlock}>
              <p className={shell.navLabel}>课程</p>
              <button
                type="button"
                className={
                  isCourseNavId(navId) ? shell.navItemActive : shell.navItem
                }
                onClick={() => setSp(lectureQuery("course"))}
              >
                <span>整课总览</span>
              </button>
              <button
                type="button"
                className={
                  isCourseSkeletonNavId(navId)
                    ? shell.navItemActive
                    : shell.navItem
                }
                onClick={() => setSp(lectureQuery("course:skeleton"))}
                title="最外层为章节，仅大纲层级"
              >
                <span>骨架展示</span>
              </button>
            </div>

          {sessionNavItems.length > 0 && (
            <div
              className={`${shell.navBlock} ${shell.navBlockCollapsible} ${
                lectureNavOpen ? "" : shell.navBlockCollapsed
              }`}
            >
              <button
                type="button"
                className={shell.navLabelToggle}
                aria-expanded={lectureNavOpen}
                onClick={() => setLectureNavOpen((v) => !v)}
              >
                <span>课次</span>
                <em>{lectureNavOpen ? "收起" : "展开"}</em>
              </button>
              {lectureNavOpen ? (
                <div className={shell.navScroll} style={{ maxHeight: 280 }}>
                  {sessionNavItems.map((it) => {
                    const active = it.id === navId;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        className={active ? shell.navItemActive : shell.navItem}
                        onClick={() => setSp(lectureQuery(it.id))}
                        title={it.title}
                      >
                        <span>{it.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}

          {chapterGroups.length > 0 && (
            <div
              className={`${shell.navBlock} ${shell.navBlockGrow} ${
                chapterNavOpen ? "" : shell.navBlockCollapsed
              }`}
            >
              <button
                type="button"
                className={shell.navLabelToggle}
                aria-expanded={chapterNavOpen}
                onClick={() => setChapterNavOpen((v) => !v)}
              >
                <span>章节</span>
                <em>{chapterNavOpen ? "收起" : "展开"}</em>
              </button>
              {chapterNavOpen ? (
                <div className={shell.navScroll}>
                  {chapterGroups.map((part) => {
                    const open = partOpen[part.id] !== false;
                    return (
                      <div key={part.id} className={assetsNav.partGroup}>
                        <button
                          type="button"
                          className={assetsNav.partToggle}
                          aria-expanded={open}
                          onClick={() =>
                            setPartOpen((prev) => ({
                              ...prev,
                              [part.id]: !open,
                            }))
                          }
                        >
                          <span>分册 · {part.title}</span>
                          <em>{open ? "收起" : "展开"}</em>
                        </button>
                        {open ? (
                          <div className={assetsNav.partChapterList}>
                            {part.chapters.map((chName) => {
                              const it = chapterItems.find(
                                (c) => c.chapter === chName
                              );
                              const active = selectedChapterNav === chName;
                              const n = it?.n_nodes || 0;
                              return (
                                <button
                                  key={chName}
                                  type="button"
                                  className={
                                    active ? shell.navItemActive : shell.navItem
                                  }
                                  onClick={() =>
                                    setSp(lectureQuery(chapterNavId(chName)))
                                  }
                                  title={`${part.title} · ${displayChapterName(chName)}${
                                    n ? ` · ${n} 节点` : " · 骨架"
                                  }`}
                                >
                                  <span>{displayChapterName(chName)}</span>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}
        </aside>
      ) : undefined}
      main={
        <main className={shell.main} style={compactMastery ? { height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" } : undefined}>
          {!compactMastery && <header className={kg.kgTopbar}>
            <div className={kg.kgTopbarPrimary}>
              <div className={kg.kgTitleBlock}>
                <h2>{titleText}</h2>
              </div>
              {doc ? (
                <div className={kg.kgStats}>
                  <div>
                    <strong>{doc.n_nodes}</strong>
                    <span>节点</span>
                  </div>
                  <div>
                    <strong>{doc.max_depth}</strong>
                    <span>深度</span>
                  </div>
                </div>
              ) : null}
            </div>
          </header>}

          {error && <p className="empty-hint">{error}</p>}
          {!doc && !error && <p className="empty-hint">加载导图…</p>}

          {doc && (
            <div className={isMasteryEmbed ? shell.canvasPlain : shell.canvasWrap} style={compactMastery ? { flex: 1, minHeight: 0, display: "flex" } : undefined}>
              {isMasteryEmbed ? <StudentMasteryMindmap
                key={masteryIdentity}
                doc={doc}
                mastery={studentMastery.identity === masteryIdentity ? studentMastery.scores : EMPTY_MASTERY}
                selectedId={selected?.id || null}
                selectedPath={(selected as (MindmapTreeNode & { __sourcePath?: number[] }) | null)?.__sourcePath}
                onSelect={selectMindmapNode}
                onClearSelect={() => selectMindmapNode(null)}
                resources={sideLinkedResources?.nodeId === linkedEntityId ? sideLinkedResources.resources : []}
                resourcesLoading={Boolean(linkedEntityId && (sideLinkedResources?.nodeId !== linkedEntityId || sideLinkedResources.loading))}
                resourcesError={sideLinkedResources?.nodeId === linkedEntityId ? sideLinkedResources.error : ""}
                onOpenResource={openLinkedResource}
                message={masteryMessage}
                scope={studentMastery.scope || (verifiedRole.toLowerCase().includes("student") ? "personal" : "class_average")}
                compact={compactMastery}
              /> : <MindmapTree
                key={`mm-expand:${courseId}:${navId || "none"}:${doc.lecture_id || ""}:${lectureVariant || ""}:${mapKey}`}
                doc={doc}
                balanceRoot={isAnyCourseNavId(navId) || Boolean(parseChapterNavId(navId))}
                resetKey={mapKey}
                selectedId={selected?.id || null}
                onSelect={(node) => selectMindmapNode(node)}
                onClearSelect={() => selectMindmapNode(null)}
                editEnabled={canEditMindmap}
                expandAll={lectureVariant === "deep"}
                expandPreset={
                  isCourseSkeletonNavId(navId)
                    ? "course"
                    : isCourseNavId(navId)
                      ? "course"
                      : "full"
                }
                // 整课废弃旧展开记录，首次恢复章的下一层，之后仍记住手动调整。
                expandStorageKey={`teachkg.mindmap.expand.${isCourseNavId(navId) ? "v5" : "v4"}:${courseId}:${encodeURIComponent(navId || "none")}${
                  lectureVariant === "deep" ? ":deep" : ""
                }`}
                courseId={courseId}
                lectureId={navId}
                onDocChange={setDoc}
                onResetEdits={() => {
                  setMapKey((k) => k + 1);
                  if (!index) return;
                  loadMindmapDoc(courseId, navId, index.items, catalog, lectureVariant)
                    .then((d) => setDoc(d))
                    .catch(() => null);
                }}
              />}
            </div>
          )}
        </main>
      }
      detail={isMasteryEmbed ? undefined :
        detailCollapsed ? (
          <aside className={kg.kgSideRail} aria-label="详情栏（已收起）">
            <button
              type="button"
              className={kg.kgSideRailBtn}
              title="展开详情"
              aria-label="展开详情"
              onClick={() => setDetailCollapsed(false)}
            >
              <span aria-hidden>‹</span>
            </button>
          </aside>
        ) : (
        <aside className={`${pipe.side} ${kg.kgSidePanel} ${compactMastery ? details.panel : ""}`} aria-label={compactMastery ? "知识点详情" : undefined}>
          {!compactMastery && <button
            type="button"
            className={kg.kgSideEdgeBtn}
            style={compactMastery ? { left: 12, top: 24, transform: "none" } : undefined}
            title="收起详情"
            aria-label="收起详情"
            onClick={() => setDetailCollapsed(true)}
          >
            <span aria-hidden>›</span>
          </button>}
          <div className={`${kg.kgSideScroll} ${compactMastery ? details.scroll : ""}`}>
          {selected ? (
            <CollapsiblePanel
              title={`相关资源 · ${selectedResourceCount}`}
              storageKey={SHARED_PANEL_KEYS.assets}
              className={compactMastery ? details.resourceSection : undefined}
              defaultOpen
              open={assetsPanelOpen}
              onOpenChange={setAssetsPanelOpen}
              bodyClassName={`${kg.sideCardBody} ${compactMastery ? details.resourceBody : ""}`}
            >
              {isAiTeachingEmbed && linkedEntityId ? (
                <LinkedResourceJumpBar
                  className={compactMastery ? details.actions : undefined}
                  loading={!!sideLinkedResources?.loading}
                  resources={sideLinkedResources?.resources || []}
                  selectedNodeId={linkedEntityId}
                  courseId={courseId}
                  resourceCourseId={resourceCourseId || courseId}
                  onOpen={openLinkedResource}
                  showAnimation
                />
              ) : null}
              <RelatedAssetsPanel
                entityId={mindmapAssetQuery.entityId}
                entityAliases={mindmapAssetQuery.aliases}
                library={assetPolicy === "none" ? null : library}
                lectureId={lectureIdForLinks || null}
                lectureOnly={false}
                kinds={[...RELATED_ASSET_KINDS]}
                maxItems={12}
                matchMode={assetPolicy === "strict" ? "strict" : "concept"}
                emptyHint={
                  compactMastery ? (assetPolicy === "none" ? "选择具体知识点查看学习资源" : "暂无相关资源，可先查看相关练习或视频。") : assetPolicy === "none"
                    ? "章节节点不匹配资源"
                    : assetPolicy === "strict"
                    ? "主题节点仅按标题精确匹配资源；暂无同名挂载"
                    : null
                }
              />
              {isAiTeachingEmbed && linkedEntityId ? (
                <ResourceCardFold title="动画" count={selectedAnimationResources.length}>
                  {sideLinkedResources?.loading ? (
                    <div className={kg.resourceMenuState}>正在查询动画…</div>
                  ) : sideLinkedResources?.error ? (
                    <div className={kg.resourceMenuError}>{sideLinkedResources.error}</div>
                  ) : selectedAnimationResources.length ? (
                    <LinkedResourceCardList
                      resources={selectedAnimationResources}
                      kind="animation"
                      nodeLabel={selected.zh || ""}
                      onOpen={openLinkedResource}
                    />
                  ) : (
                    <div className={pipe.sideEmpty}>暂无关联动画</div>
                  )}
                </ResourceCardFold>
              ) : null}
            </CollapsiblePanel>
          ) : null}
          {canEditMindmap && chapterForOutline ? (
            <CollapsiblePanel
              title="大纲 / 总结输入"
              storageKey="mindmap-panel-outline-v2"
              defaultOpen
              bodyClassName={kg.sideCardBody}
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

          </div>
        </aside>
        )
      }
    />
  );
}
