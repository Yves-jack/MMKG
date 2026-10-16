import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { LectureReviewGraph } from "@/components/review/LectureReviewGraph";
import { LectureStudyNotes } from "@/components/review/LectureStudyNotes";
import { ResizableShell } from "@/components/graph/ResizableShell";
import { ResizableSplit } from "@/components/graph/ResizableSplit";
import {
  MindmapTree,
  type MindmapDoc,
  type MindmapTreeNode,
} from "@/components/mindmap/MindmapTree";
import {
  getCachedEntityEvidenceIndex,
  hitsFromEntityEvidenceIndex,
  loadEntityEvidenceIndex,
  loadReviewLecture,
  type AppReviewPoint,
} from "@/lib/review/data";
import {
  VideoChapterPlayer,
  type VideoSegment,
} from "@/components/review/VideoChapterPlayer";
import { toMediaUrl } from "@/lib/kg/adaptToPipeline";
import { saveFocus } from "@/lib/review/focus";
import { resolveVideoPracticeContext, buildVideoPracticeResource } from "@/lib/review/videoPracticeContext.mjs";
import { knowledgeResourceIdentity } from "@/lib/kg/mindmapResourceIdentity.mjs";
import {
  enrichVideoSegments,
  loadPipelineVideoSegments,
  overlaySpokenCaptionsFromPipeline,
} from "@/lib/review/enrichVideoSegments";
import { loadLectureAsrCaptions, type AsrCaption } from "@/lib/review/asrCaptions";
import { loadReviewLectureMindmap } from "@/lib/review/loadReviewClassroomGraph";
import { resolveConceptId } from "@/lib/review/conceptIdentity";
import {
  pairLecturesIntoSessions,
  parseSessionRouteId,
  resolveReviewSession,
  sessionTitle,
  type ReviewSession,
} from "@/lib/review/reviewSession";
import {
  WATCH_CLASSROOM_EVENT,
  type WatchClassroomDetail,
} from "@/lib/review/reviewSeek";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import { dedupeEntityMatchesByZh } from "@/lib/entitySearchDedupe";
import {
  emitKnowledgeResourceOpen,
  fetchLinkedKnowledgeResources,
  type LinkedKnowledgeResource,
} from "@/lib/integration/knowledgeResources";
import shell from "@/styles/shell.module.css";
import kgStyles from "@/pages/KgPage.module.css";
import styles from "./ReviewPage.module.css";

type EntitySegmentHit = {
  key: string;
  lectureId: string;
  start_sec: number;
  end_sec?: number | null;
  text: string;
  pointId: string;
  pointZh: string;
};

type ReviewNeighbor = {
  subject: string;
  predicate: string;
  object: string;
  label?: string;
  natural_statement?: string;
};

type ReviewEvidence = {
  cue_id: string;
  text: string;
  start_sec?: number | null;
  end_sec?: number | null;
  clip_path?: string | null;
  lecture_id?: string;
};

export type ReviewPoint = {
  id: string;
  zh: string;
  rank?: number;
  importance: number;
  mention_count?: number;
  origin: "shared" | "lecture_only" | "textbook_hint" | string;
  summary: string;
  definition?: string;
  neighbors?: ReviewNeighbor[];
  evidence?: ReviewEvidence[];
  asset_ids?: string[];
  source_lecture_ids?: string[];
};

type ReviewDoc = {
  course_id?: string;
  lecture_id: string;
  title?: string;
  n_points?: number;
  class_video?: string | null;
  ppt_video?: string | null;
  duration_sec?: number | null;
  segments?: VideoSegment[];
  points: ReviewPoint[];
};

type ReviewShowcaseItem = {
  lecture_id: string;
  title?: string;
  n_points?: number;
  path: string;
  class_video?: string | null;
  ppt_video?: string | null;
  duration_sec?: number | null;
};

type ReviewShowcase = {
  courseId?: string;
  title?: string;
  items?: ReviewShowcaseItem[];
};

type SessionPart = {
  lectureId: string;
  title?: string;
  class_video?: string | null;
  ppt_video?: string | null;
  duration_sec?: number | null;
  segments: VideoSegment[];
};

function zhName(name: string): string {
  return (name || "").split("/")[0].trim() || name;
}

function fmtDuration(sec?: number | null): string {
  if (sec == null || !(sec > 0)) return "";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}小时${m}分`;
  return `${m} 分钟`;
}

function fmtClock(sec?: number | null): string {
  if (sec == null || !Number.isFinite(Number(sec))) return "";
  const s = Math.max(0, Math.floor(Number(sec)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function clipSnippet(raw: string, maxLen = 100): string {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen).replace(/[，,。；;：:\s]+$/g, "")}…`;
}

/** 视频检索结果：精确匹配实体 id / 中文名（不做模糊包含） */
function matchesEntityFilter(
  point: ReviewPoint,
  kp: string | null,
  q: string,
): boolean {
  const needle = (kp || "").trim();
  const query = q.trim();
  const id = String(point.id || "");
  const zh = zhName(id);
  const label = String(point.zh || "").trim();
  if (needle) {
    const nZh = zhName(needle);
    return id === needle || zh === nZh || label === nZh || label === needle;
  }
  if (query) {
    const qZh = zhName(query);
    return (
      id === query ||
      zh === query ||
      zh === qZh ||
      label === query ||
      label === qZh
    );
  }
  return true;
}

type SearchEntity = { id: string; zh: string };

function resolveExactSearchEntity(
  catalog: SearchEntity[],
  raw: string,
): SearchEntity | null {
  const q = raw.trim();
  if (!q || !catalog.length) return null;
  const qZh = zhName(q);
  return (
    catalog.find((e) => e.id === q) ||
    catalog.find((e) => e.zh === q || e.zh === qZh || zhName(e.id) === qZh) ||
    null
  );
}

function hitsFromPoints(
  lecturePoints: { lectureId: string; points: ReviewPoint[] }[],
  kp: string | null,
  q: string,
): EntitySegmentHit[] {
  const out: EntitySegmentHit[] = [];
  const seen = new Set<string>();
  for (const { lectureId, points: pts } of lecturePoints) {
    for (const p of pts) {
      if (!matchesEntityFilter(p, kp, q)) continue;
      const evidence = p.evidence || [];
      const timed = evidence.filter((e) => Number.isFinite(Number(e.start_sec)));
      const rows = timed.length
        ? timed
        : [
            {
              cue_id: `${p.id}-fallback`,
              text: p.summary || p.definition || p.zh,
              start_sec: 0,
              end_sec: null,
              lecture_id: lectureId,
            } as ReviewEvidence,
          ];
      for (const e of rows) {
        const start = Number(e.start_sec) || 0;
        const lec = String(e.lecture_id || lectureId);
        const key = `${lec}:${Math.floor(start)}:${p.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text =
          clipSnippet(String(e.text || "")) ||
          clipSnippet(p.summary || "") ||
          clipSnippet(p.definition || "") ||
          p.zh;
        out.push({
          key,
          lectureId: lec,
          start_sec: start,
          end_sec: e.end_sec,
          text,
          pointId: p.id,
          pointZh: p.zh,
        });
      }
    }
  }
  out.sort(
    (a, b) =>
      Number(a.lectureId) - Number(b.lectureId) || a.start_sec - b.start_sec,
  );
  return out;
}

function mergeSessionPoints(
  parts: { lectureId: string; points: ReviewPoint[] }[]
): ReviewPoint[] {
  const byId = new Map<string, ReviewPoint>();
  for (const { lectureId, points } of parts) {
    for (const p of points) {
      const evidence = (p.evidence || []).map((e) => ({
        ...e,
        lecture_id: e.lecture_id || lectureId,
      }));
      const prev = byId.get(p.id);
      if (!prev) {
        byId.set(p.id, {
          ...p,
          evidence,
          source_lecture_ids: [lectureId],
        });
        continue;
      }
      prev.importance = Math.max(Number(prev.importance) || 0, Number(p.importance) || 0);
      prev.mention_count = Math.max(
        Number(prev.mention_count) || 0,
        Number(p.mention_count) || 0
      );
      prev.definition = prev.definition || p.definition;
      prev.summary = prev.summary || p.summary;
      prev.evidence = [...(prev.evidence || []), ...evidence];
      prev.neighbors = [...(prev.neighbors || []), ...(p.neighbors || [])];
      const ids = new Set([...(prev.source_lecture_ids || []), lectureId]);
      prev.source_lecture_ids = [...ids];
    }
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.importance || 0) - Number(a.importance || 0)
  );
}

function sessionMeta(
  session: ReviewSession,
  items: ReviewShowcaseItem[]
): { duration: number; missingVideo: boolean } {
  const parts = session.lectureIds
    .map((id) => items.find((it) => String(it.lecture_id) === id))
    .filter(Boolean) as ReviewShowcaseItem[];
  return {
    duration: parts.reduce((s, p) => s + Number(p.duration_sec || 0), 0),
    missingVideo: parts.every((p) => !p.class_video),
  };
}

export function ReviewPage() {
  const courseId = useCourseId();
  const { lectureId: paramId } = useParams();
  const location = useLocation();
  // 点击课次时先写入，规避 RR location 与 window.location 短暂/持续不同步
  const [forcedSessionId, setForcedSessionId] = useState<string | null>(null);
  const pathSessionId = useMemo(() => {
    const fromWindow = String(window.location.pathname || "").match(
      /\/apps\/review\/([^/?#]+)/,
    )?.[1];
    const fromRouter = String(location.pathname || "").match(
      /\/apps\/review\/([^/?#]+)/,
    )?.[1];
    const pick = fromWindow || fromRouter || "";
    try {
      return decodeURIComponent(pick);
    } catch {
      return pick;
    }
  }, [location.pathname, location.search, location.key]);
  const rawId =
    forcedSessionId || pathSessionId || String(paramId || "").trim();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    if (!forcedSessionId) return;
    if (pathSessionId === forcedSessionId) setForcedSessionId(null);
  }, [forcedSessionId, pathSessionId]);

  const [showcase, setShowcase] = useState<ReviewShowcase | null>(null);
  const [parts, setParts] = useState<SessionPart[]>([]);
  /** 与 parts 同步的课次 id；未对齐时禁止用旧 parts 播视频 */
  const [partsSessionId, setPartsSessionId] = useState("");
  const [points, setPoints] = useState<ReviewPoint[]>([]);
  const [sessionHeading, setSessionHeading] = useState<string>("");
  const [mindmap, setMindmap] = useState<MindmapDoc | null>(null);
  const [mindmapError, setMindmapError] = useState<string | null>(null);
  const [mindmapLoading, setMindmapLoading] = useState(false);
  const [mapKey, setMapKey] = useState(0);
  const [mapView, setMapView] = useState<"mindmap" | "graph">(() => {
    try {
      return window.localStorage.getItem("review-map-view") === "graph"
        ? "graph"
        : "mindmap";
    } catch {
      return "mindmap";
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMindNode, setSelectedMindNode] = useState<MindmapTreeNode | null>(null);
  const practiceSelectionRef = useRef<{ id: string; zh: string } | null>(null);
  const practiceRequestRef = useRef(0);
  const [practiceOpening, setPracticeOpening] = useState(false);
  // 交学伴：进入视频页默认同时展开课次列表与笔记栏
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [entitySearchDraft, setEntitySearchDraft] = useState(() =>
    String(searchParams.get("q") || searchParams.get("kp") || "").trim(),
  );
  const [seekToSec, setSeekToSec] = useState<number | null>(null);
  const [seekToken, setSeekToken] = useState(0);
  const [activePart, setActivePart] = useState<string>("");
  const [captions, setCaptions] = useState<AsrCaption[]>([]);
  const [captionsKey, setCaptionsKey] = useState("");
  const [entityHits, setEntityHits] = useState<EntitySegmentHit[]>([]);
  const [entityHitsLoading, setEntityHitsLoading] = useState(false);
  const [searchCatalog, setSearchCatalog] = useState<SearchEntity[]>([]);
  const [searchCatalogLoading, setSearchCatalogLoading] = useState(false);
  const [evidenceIndexReady, setEvidenceIndexReady] = useState(false);
  const [entitySearchOpen, setEntitySearchOpen] = useState(false);
  const [searchSubmitHint, setSearchSubmitHint] = useState<string | null>(null);
  const entitySearchWrapRef = useRef<HTMLDivElement | null>(null);
  const [showVideo, setShowVideo] = useState(() => {
    try {
      return window.localStorage.getItem("review-show-video") !== "0";
    } catch {
      return true;
    }
  });

  const kpParam = searchParams.get("kp");
  const tParam = searchParams.get("t");
  const lecParam = searchParams.get("lec");
  const qParam = String(searchParams.get("q") || "").trim();
  const videoIdParam = String(searchParams.get("video_id") || "").trim();
  const requestedParentOrigin = String(searchParams.get("parent_origin") || "").trim();
  const kgLaunchToken = String(searchParams.get("kg_token") || "").trim();
  // 检索提交瞬间先记 needle，避免 setSearchParams 尚未写回时空过滤匹配「整课所有片段」
  const [pendingSearch, setPendingSearch] = useState<{
    kp?: string;
    q?: string;
  } | null>(null);
  const effectiveKp = String(pendingSearch?.kp || kpParam || "").trim() || null;
  const effectiveQ = String(pendingSearch?.q || qParam || "").trim();
  const entityMode = Boolean(effectiveKp || effectiveQ);

  useEffect(() => {
    if (!pendingSearch) return;
    const pendingKp = String(pendingSearch.kp || "").trim();
    const pendingQ = String(pendingSearch.q || "").trim();
    if (pendingKp && String(kpParam || "").trim() === pendingKp) {
      setPendingSearch(null);
      return;
    }
    if (pendingQ && qParam === pendingQ) {
      setPendingSearch(null);
    }
  }, [pendingSearch, kpParam, qParam]);

  // URL 带 kp / q 时同步检索框（优先中文名）；无筛选时不打断用户正在输入
  useEffect(() => {
    if (qParam) {
      setEntitySearchDraft(qParam);
      return;
    }
    if (kpParam) {
      const hit = searchCatalog.find((e) => e.id === kpParam);
      setEntitySearchDraft(hit?.zh || String(kpParam));
    }
  }, [kpParam, qParam, searchCatalog]);

  const parentOrigin = useMemo(() => {
    if (typeof document === "undefined") return "";
    try {
      if (requestedParentOrigin) return new URL(requestedParentOrigin).origin;
      if (document.referrer) return new URL(document.referrer).origin;
    } catch {
      /* ignore */
    }
    return "";
  }, [requestedParentOrigin]);

  const canvasCourseId = String(searchParams.get("resource_course_id") || "").trim();
  const watchAccumRef = useRef({ lastSec: 0, watched: 0, reported: false });
  /** 当前播放头（秒），供「按知识点练习」回推知识点 */
  const playbackSecRef = useRef<number | null>(null);
  const practiceContextKey = `${courseId}\u0000${rawId}\u0000${activePart}\u0000${entitySearchDraft}\u0000${selectedId}`;
  const practiceContextRef = useRef(practiceContextKey);
  practiceContextRef.current = practiceContextKey;
  /** 视频元数据就绪后再拉检索目录 / 导图 / 笔记网络缓存，避免占满连接导致片源卡住 */
  const [mediaReady, setMediaReady] = useState(false);
  useEffect(() => {
    watchAccumRef.current = { lastSec: 0, watched: 0, reported: false };
    playbackSecRef.current = null;
    practiceSelectionRef.current = null;
    setMediaReady(false);
  }, [rawId, courseId, activePart]);
  const reportVideoWatch = useCallback(
    (sec: number, durationSec: number) => {
      if (!parentOrigin || window.parent === window) return;
      const state = watchAccumRef.current;
      const delta = Math.max(0, Math.min(2.5, sec - state.lastSec));
      if (delta > 0 && delta < 2.5) state.watched += delta;
      state.lastSec = sec;
      const completion = durationSec > 0 ? sec / durationSec : 0;
      if (state.reported) return;
      if (state.watched < 60 && completion < 0.5) return;
      state.reported = true;
      window.parent.postMessage(
        {
          type: "learner:video-progress",
          payload: {
            course_id: canvasCourseId || courseId,
            lecture_id: String(rawId || ""),
            kp: String(kpParam || "").trim(),
            watch_sec: Math.round(state.watched),
            completion: Number(completion.toFixed(3)),
            source_id: `video-${courseId}-${rawId || "0"}`,
          },
        },
        parentOrigin,
      );
    },
    [parentOrigin, canvasCourseId, courseId, rawId, kpParam],
  );

  const expandList = () => {
    setListCollapsed(false);
  };
  const expandNotes = () => {
    setDetailCollapsed(false);
  };
  const collapseList = () => setListCollapsed(true);
  const collapseNotes = () => setDetailCollapsed(true);

  const videoItems = useMemo(() => {
    const items = [...(showcase?.items || [])];
    items.sort((a, b) => Number(a.lecture_id) - Number(b.lecture_id));
    return items;
  }, [showcase]);

  const sessions = useMemo(
    () => pairLecturesIntoSessions(videoItems.map((v) => String(v.lecture_id))),
    [videoItems]
  );

  const sessionHasVideo = useMemo(() => {
    const byId = new Map(
      videoItems.map((v) => [String(v.lecture_id), Boolean(v.class_video || v.ppt_video)]),
    );
    return (s: { lectureIds: string[] }) =>
      s.lectureIds.some((id) => byId.get(String(id)));
  }, [videoItems]);

  const firstPlayableSessionId = useMemo(() => {
    const hit = sessions.find((s) => sessionHasVideo(s));
    return hit?.id || sessions[0]?.id || "";
  }, [sessions, sessionHasVideo]);

  const session = useMemo(
    () => resolveReviewSession(rawId, sessions),
    [rawId, sessions]
  );

  const sessionId = session?.id || "";

  useEffect(() => {
    if (mediaReady) return;
    const t = window.setTimeout(() => setMediaReady(true), 4500);
    return () => window.clearTimeout(t);
  }, [mediaReady, sessionId, activePart]);

  const parsedRoute = useMemo(() => parseSessionRouteId(rawId), [rawId]);

  const needsRedirect = Boolean(
    sessions.length && rawId && session && String(rawId) !== session.id
  );

  const redirectSearch = useMemo(() => {
    if (!needsRedirect || !session || !parsedRoute) return "";
    const next = new URLSearchParams(searchParams);
    if (parsedRoute.kind === "lecture") next.set("lec", parsedRoute.id);
    const qs = next.toString();
    return qs ? `?${qs}` : "";
  }, [needsRedirect, session, parsedRoute, searchParams]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const urls = [
        `${courseDataUrl(courseId, "review_showcase.json")}?t=${Date.now()}`,
        `${courseDataUrl(courseId, "review/index.json")}?t=${Date.now()}`,
      ];
      for (const url of urls) {
        try {
          const r = await fetch(url, { cache: "no-store" });
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "";
          if (ct.includes("text/html")) continue;
          const data = (await r.json()) as ReviewShowcase;
          if (!cancelled) {
            setShowcase({
              courseId: data.courseId || courseId,
              title: data.title,
              items: data.items || [],
            });
          }
          return;
        } catch {
          /* try next */
        }
      }
      if (!cancelled) setShowcase({ courseId, items: [] });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    if (!rawId && firstPlayableSessionId) {
      const qs = searchParams.toString();
      navigate(
        `${coursePath(courseId, `/apps/review/${firstPlayableSessionId}`)}${qs ? `?${qs}` : ""}`,
        { replace: true },
      );
    }
  }, [rawId, firstPlayableSessionId, courseId, navigate, searchParams]);

  useEffect(() => {
    if (!session) return;
    const fromQuery =
      lecParam && session.lectureIds.includes(lecParam) ? lecParam : "";
    if (fromQuery) {
      setActivePart(fromQuery);
      return;
    }
    if (videoIdParam) {
      const raw = String(videoIdParam);
      if (session.lectureIds.includes(raw)) {
        setActivePart(raw);
        return;
      }
      const n = Number(raw);
      if (Number.isFinite(n)) {
        const asLecture = String(Math.floor(n) + 1);
        if (session.lectureIds.includes(asLecture)) {
          setActivePart(asLecture);
          return;
        }
        if (session.lectureIds.includes(String(Math.floor(n)))) {
          setActivePart(String(Math.floor(n)));
          return;
        }
      }
    }
    setActivePart(session.lectureIds[0] || "");
  }, [session, lecParam, videoIdParam]);

  // 预计算索引：只缓存模块级 by_id；React 只存 catalog + ready（避免大对象 setState 卡死）
  useEffect(() => {
    if (!courseId) {
      setEvidenceIndexReady(false);
      setSearchCatalog([]);
      setSearchCatalogLoading(false);
      return;
    }
    let cancelled = false;
    setSearchCatalogLoading(true);
    void (async () => {
      try {
        const idx = await loadEntityEvidenceIndex(courseId);
        if (cancelled) return;
        setEvidenceIndexReady(true);
        if (idx?.entities?.length) {
          setSearchCatalog(idx.entities.map((e) => ({ id: e.id, zh: e.zh })));
        } else {
          // 无全课索引时，仅用当前课 points 作目录，绝不扫 40+ 讲
          const byId = new Map<string, SearchEntity>();
          for (const p of points as ReviewPoint[]) {
            const id = String(p.id || "").trim();
            if (!id || byId.has(id)) continue;
            byId.set(id, { id, zh: String(p.zh || zhName(id)).trim() || id });
          }
          setSearchCatalog(
            [...byId.values()].sort((a, b) => a.zh.localeCompare(b.zh, "zh")),
          );
        }
      } catch {
        if (!cancelled) setEvidenceIndexReady(true);
      } finally {
        if (!cancelled) setSearchCatalogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalog from index; points merge below
  }, [courseId]);

  // 当前课 points 到位后并入目录（不触发重扫）
  useEffect(() => {
    if (!points.length) return;
    setSearchCatalog((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      let changed = false;
      for (const p of points) {
        const id = String(p.id || "").trim();
        if (!id || byId.has(id)) continue;
        byId.set(id, { id, zh: String(p.zh || zhName(id)).trim() || id });
        changed = true;
      }
      if (!changed) return prev;
      return [...byId.values()].sort((a, b) => a.zh.localeCompare(b.zh, "zh"));
    });
  }, [points]);

  useEffect(() => {
    if (!entityMode || !courseId) {
      setEntityHits([]);
      setEntityHitsLoading(false);
      return;
    }
    // 尚无明确 needle 时绝不扫「整课命中」（matchesEntityFilter 空条件会返回 true）
    if (!effectiveKp && !effectiveQ) {
      setEntityHits([]);
      setEntityHitsLoading(true);
      return;
    }

    let cancelled = false;
    const toHits = (
      rows: {
        lecture_id?: string;
        lectureId?: string;
        start_sec: number;
        end_sec?: number | null;
        text: string;
        point_id?: string;
        pointId?: string;
        point_zh?: string;
        pointZh?: string;
      }[],
    ): EntitySegmentHit[] =>
      rows.map((h) => {
        const lectureId = String(h.lecture_id || h.lectureId || "");
        const pointId = String(h.point_id || h.pointId || effectiveKp || effectiveQ);
        const start = Number(h.start_sec) || 0;
        return {
          key: `${lectureId}:${Math.floor(start)}:${pointId}`,
          lectureId,
          start_sec: start,
          end_sec: h.end_sec,
          text: String(h.text || ""),
          pointId,
          pointZh: String(h.point_zh || h.pointZh || zhName(pointId)),
        };
      });

    const instant = hitsFromPoints(
      [
        {
          lectureId: activePart || sessionId || "",
          points: points as ReviewPoint[],
        },
      ],
      effectiveKp,
      effectiveQ,
    );
    // 先出当前课，避免等待索引时像卡住
    if (instant.length) {
      setEntityHits(instant);
      setEntityHitsLoading(false);
    } else {
      setEntityHitsLoading(true);
    }

    void (async () => {
      // 直接 await 索引（模块缓存命中则几乎瞬时），不依赖 ready/cache 竞态
      const idx =
        getCachedEntityEvidenceIndex(courseId) ||
        (await loadEntityEvidenceIndex(courseId));
      if (cancelled) return;
      if (idx && !evidenceIndexReady) setEvidenceIndexReady(true);
      if (idx?.entities?.length) {
        setSearchCatalog((prev) =>
          prev.length >= idx.entities.length
            ? prev
            : idx.entities.map((e) => ({ id: e.id, zh: e.zh })),
        );
      }
      const indexed = hitsFromEntityEvidenceIndex(idx, effectiveKp, effectiveQ);
      const hits = indexed ? toHits(indexed) : [];
      const shown = hits.length ? hits : instant;
      setEntityHits(shown);
      setEntityHitsLoading(false);

      if (!kgLaunchToken || !effectiveKp) return;
      try {
        const linked = await Promise.race([
          fetchLinkedKnowledgeResources({
            courseId,
            knowledgePointId: String(effectiveKp),
            kgToken: kgLaunchToken,
            nodeName: zhName(String(effectiveKp)),
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
        if (cancelled || !linked) return;
        const next = [...shown];
        const seen = new Set(next.map((h) => h.key));
        for (const res of linked.resources) {
          if (res.resource_type !== "video") continue;
          const start = Number(res.start_sec);
          if (!Number.isFinite(start)) continue;
          const videoId = String(
            res.metadata?.video_id || res.resource_id || "",
          ).trim();
          let lectureId = String(
            res.metadata?.lesson_id || res.metadata?.lecture_id || "",
          ).trim();
          if (!lectureId && videoId) {
            const n = Number(videoId);
            lectureId = Number.isFinite(n)
              ? String(Math.floor(n) + 1)
              : videoId;
          }
          if (!lectureId) continue;
          const key = `${lectureId}:${Math.floor(start)}:${effectiveKp}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const meta = res.metadata || {};
          const text =
            clipSnippet(String(meta.summary || "")) ||
            clipSnippet(String(meta.asr_text || meta.text || "")) ||
            clipSnippet(String(res.content || "")) ||
            clipSnippet(String(res.title || "")) ||
            zhName(String(effectiveKp));
          next.push({
            key,
            lectureId,
            start_sec: start,
            end_sec: res.end_sec,
            text,
            pointId: String(effectiveKp),
            pointZh: zhName(String(effectiveKp)),
          });
        }
        next.sort(
          (a, b) =>
            Number(a.lectureId) - Number(b.lectureId) ||
            a.start_sec - b.start_sec,
        );
        if (!cancelled) setEntityHits(next);
      } catch {
        /* keep local */
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityMode, courseId, effectiveKp, effectiveQ, kgLaunchToken, activePart, sessionId]);

  const sessionLectureKey = session?.lectureIds?.join("_") || "";

  useEffect(() => {
    if (!sessionId || !sessionLectureKey) {
      setLoading(false);
      setError(null);
      setParts([]);
      setPartsSessionId("");
      setPoints([]);
      return;
    }
    const loadForSessionId = sessionId;
    const lectureIds = sessionLectureKey.split("_").filter(Boolean);
    let cancelled = false;
    setError(null);
    setPoints([]);

    // 先用 showcase / 约定路径立刻挂上本堂视频，不阻塞在 review JSON / KG 合成上
    const headingSession: ReviewSession = {
      id: loadForSessionId,
      lectureIds,
      label: `第 ${Math.ceil(Number(lectureIds[0] || 1) / 2)} 次课`,
    };
    const bootParts: SessionPart[] = lectureIds.map((id) => {
      const item = videoItems.find((v) => String(v.lecture_id) === id);
      // 勿用约定路径兜底：无片源时 null，避免 404 URL 进播放器导致切换课次崩溃
      return {
        lectureId: id,
        title: item?.title,
        class_video: item?.class_video || null,
        ppt_video: item?.ppt_video || null,
        duration_sec: item?.duration_sec ?? null,
        segments: [],
      };
    });
    const bootHasVideo = bootParts.some((p) => Boolean(p.class_video || p.ppt_video));
    setParts(bootParts);
    setPartsSessionId(loadForSessionId);
    setSessionHeading(sessionTitle(headingSession, bootParts.find((p) => p.title)?.title));
    setLoading(false);
    if (!bootHasVideo) {
      setError("本堂课暂无课堂视频文件");
    }

    const load = async () => {
      try {
        const loaded = await Promise.all(
          lectureIds.map(async (id) => {
            const item = videoItems.find((v) => String(v.lecture_id) === id);
            try {
              const doc = (await loadReviewLecture(courseId, id)) as ReviewDoc | null;
              return { lectureId: id, doc, item };
            } catch {
              return { lectureId: id, doc: null as ReviewDoc | null, item };
            }
          })
        );
        if (cancelled) return;
        const ok = loaded.filter((x) => x.doc);
        const nextParts: SessionPart[] = await Promise.all(
          loaded.map(async ({ lectureId, doc, item }) => {
            let segments = doc?.segments || [];
            if (!segments.length) {
              segments = await loadPipelineVideoSegments(courseId, lectureId);
            } else {
              // review 里 title/summary 常来自教材 extract；用 pipeline 口播对齐悬停介绍
              segments = await overlaySpokenCaptionsFromPipeline(
                courseId,
                lectureId,
                segments,
              );
            }
            segments = enrichVideoSegments(segments, doc?.points || []);
            return {
              lectureId,
              title: doc?.title || item?.title,
              // 片源只信 showcase（已校验文件存在）；勿回落到 review JSON 里可能 404 的路径
              class_video: item?.class_video || null,
              ppt_video: item?.ppt_video || null,
              duration_sec: doc?.duration_sec ?? item?.duration_sec ?? null,
              segments,
            };
          }),
        );
        const merged = mergeSessionPoints(
          ok.map(({ lectureId, doc }) => ({
            lectureId,
            points: doc?.points || [],
          }))
        );
        const firstTitle =
          ok.map((x) => x.doc?.title).find(Boolean)
          || nextParts.map((p) => p.title).find(Boolean);
        setParts(nextParts);
        setPartsSessionId(loadForSessionId);
        setPoints(merged);
        setSessionHeading(sessionTitle(headingSession, firstTitle));
        if (!ok.length) {
          setError("本堂课暂无复习图谱/笔记导出，已回退展示课堂视频");
        } else {
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          // 视频已可播；仅提示复习数据失败
          setError(e instanceof Error ? e.message : "复习数据加载失败");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [courseId, sessionId, sessionLectureKey, videoItems]);

  // 默认不自动选中；仅 URL 带明确 kp（跳转意图）时选中
  useEffect(() => {
    if (kpParam && points.length) {
      const fromQuery = points.find(
        (p) =>
          p.id === kpParam ||
          zhName(p.id) === zhName(kpParam) ||
          p.zh === zhName(kpParam)
      );
      if (fromQuery) {
        setSelectedId(fromQuery.id);
        saveFocus(courseId, {
          lectureId: sessionId,
          entityId: fromQuery.id,
          zh: fromQuery.zh,
        });
        return;
      }
    }
    setSelectedId((cur) =>
      cur && points.some((p) => p.id === cur) ? cur : null
    );
  }, [points, kpParam, courseId, sessionId]);

  // 仅在 parts 已与当前课次对齐时使用；切换瞬间 partsSessionId 为空，不播旧视频
  const sessionParts = useMemo(() => {
    if (!session?.lectureIds?.length) return [] as SessionPart[];
    if (partsSessionId !== session.id) return [] as SessionPart[];
    const ids = new Set(session.lectureIds.map(String));
    return parts.filter((p) => ids.has(String(p.lectureId)));
  }, [parts, partsSessionId, session]);

  const activeVideo = useMemo(() => {
    if (!sessionParts.length) return null;
    const hit = sessionParts.find((p) => String(p.lectureId) === String(activePart));
    if (hit) return hit;
    // 不在这里改 activePart；仅先选本堂有片源的讲，避免跨课次回退
    return (
      sessionParts.find((p) => Boolean(toMediaUrl(p.class_video || null))) ||
      sessionParts[0] ||
      null
    );
  }, [sessionParts, activePart]);

  const classVideoUrl = useMemo(
    () => toMediaUrl(activeVideo?.class_video || null),
    [activeVideo?.class_video]
  );

  const anyClassVideo = useMemo(
    () => sessionParts.some((p) => Boolean(toMediaUrl(p.class_video || null))),
    [sessionParts]
  );

  // 本堂 parts 就绪后：若当前讲对不上，对齐到本堂第一讲（有视频优先）
  useEffect(() => {
    if (!session || partsSessionId !== session.id) return;
    if (!sessionParts.length || loading) return;
    const inSession = sessionParts.some(
      (p) => String(p.lectureId) === String(activePart),
    );
    if (inSession) return;
    const fallback =
      sessionParts.find((p) => Boolean(toMediaUrl(p.class_video || null))) ||
      sessionParts[0];
    if (!fallback) return;
    setActivePart(fallback.lectureId);
    const next = new URLSearchParams(searchParams);
    next.set("lec", fallback.lectureId);
    setSearchParams(next, { replace: true });
  }, [
    sessionParts,
    partsSessionId,
    activePart,
    loading,
    session,
    searchParams,
    setSearchParams,
  ]);

  useEffect(() => {
    setCaptions([]);
    setCaptionsKey("");
    if (!courseId || !activePart) {
      return;
    }
    let cancelled = false;
    loadLectureAsrCaptions(courseId, activePart).then((caps) => {
      if (!cancelled) {
        setCaptions(caps);
        setCaptionsKey(`${courseId}\u0000${activePart}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [courseId, activePart]);

  useEffect(() => {
    if (!activePart) return;
    if (tParam == null || tParam === "") return;
    if (lecParam && lecParam !== activePart) return;
    const sec = Number(tParam);
    if (!Number.isFinite(sec)) return;
    setSeekToSec(sec);
    setSeekToken((t) => t + 1);
  }, [sessionId, activePart, tParam, lecParam, classVideoUrl]);

  useEffect(() => {
    if (!sessionId) {
      setMindmap(null);
      setMindmapError(null);
      setMindmapLoading(false);
      return;
    }
    if (!mediaReady) {
      setMindmapLoading(true);
      return;
    }
    setMindmap(null);
    setMindmapError(null);
    setMindmapLoading(true);
    setSelectedMindNode(null);
    setMapKey((k) => k + 1);
    let cancelled = false;
    loadReviewLectureMindmap(courseId, sessionId)
      .then((d) => {
        if (cancelled) return;
        // 视频页导图只读，不套本地编辑补丁
        setMindmap(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setMindmap(null);
        setMindmapError(String(e.message || e));
      })
      .finally(() => {
        if (!cancelled) setMindmapLoading(false);
      });
    return () => {
      cancelled = true;
      setMindmapLoading(false);
    };
  }, [courseId, sessionId, mediaReady]);

  const graphPoints = points as AppReviewPoint[];
  const segments = activeVideo?.segments || [];
  const selected = points.find((p) => p.id === selectedId) || null;

  const switchPart = (lectureId: string, extra?: { t?: number; kp?: string | null }) => {
    setActivePart(lectureId);
    if (extra?.kp) {
      setSelectedId(extra.kp);
    } else {
      setSelectedId(null);
      setSelectedMindNode(null);
    }
    const next = new URLSearchParams(searchParams);
    next.set("lec", lectureId);
    if (extra?.kp) next.set("kp", extra.kp);
    else next.delete("kp");
    if (extra?.t != null && Number.isFinite(extra.t)) {
      next.set("t", String(Math.floor(extra.t)));
    } else {
      next.delete("t");
    }
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    const onWatch = (e: Event) => {
      const d = (e as CustomEvent<WatchClassroomDetail>).detail;
      if (!d || !session) return;
      const eventLec = String(d.lectureId);
      const inSession =
        session.lectureIds.includes(eventLec) || eventLec === session.id;
      if (!inSession) return;
      const part =
        session.lectureIds.includes(eventLec) ? eventLec : activePart || session.lectureIds[0];
      const sec = Number(d.startSec);
      if (!Number.isFinite(sec)) return;
      if (part && part !== activePart) switchPart(part, { t: sec, kp: d.entityId });
      else {
        const next = new URLSearchParams(searchParams);
        if (d.entityId) next.set("kp", d.entityId);
        next.set("t", String(Math.floor(sec)));
        if (part) next.set("lec", part);
        setSearchParams(next, { replace: true });
      }
      setSeekToSec(sec);
      setSeekToken((n) => n + 1);
      if (d.entityId) {
        const hit =
          points.find((p) => p.id === d.entityId) ||
          points.find((p) => zhName(p.id) === zhName(d.entityId || ""));
        if (hit) {
          setSelectedId(hit.id);
          setSelectedMindNode(null);
          saveFocus(courseId, {
            lectureId: sessionId,
            entityId: hit.id,
            zh: hit.zh,
          });
        }
      }
    };
    window.addEventListener(WATCH_CLASSROOM_EVENT, onWatch);
    return () => window.removeEventListener(WATCH_CLASSROOM_EVENT, onWatch);
  }, [courseId, session, sessionId, points, searchParams, setSearchParams, activePart]);

  useEffect(() => {
    try {
      window.localStorage.setItem("review-map-view", mapView);
    } catch {
      /* ignore */
    }
  }, [mapView]);

  useEffect(() => {
    try {
      window.localStorage.setItem("review-show-video", showVideo ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [showVideo]);

  const selectPoint = (id: string, opts?: { openNotes?: boolean }) => {
    const point = points.find((p) => p.id === id);
    practiceSelectionRef.current = { id, zh: point?.zh || zhName(id) };
    practiceRequestRef.current += 1;
    setSelectedId(id);
    if (opts?.openNotes) expandNotes();
    const next = new URLSearchParams(searchParams);
    next.set("kp", id);
    next.delete("t");
    setSearchParams(next, { replace: true });
    const hit = points.find((p) => p.id === id);
    if (hit) {
      saveFocus(courseId, {
        lectureId: sessionId,
        entityId: hit.id,
        zh: hit.zh,
      });
    }
  };

  const matchReviewPoint = (node: MindmapTreeNode): ReviewPoint | undefined => {
    const cid = resolveConceptId(node.id, mindmap?.id_redirects);
    const zh = (zhName(node.id) || node.zh || "").trim();
    return (
      points.find((p) => p.id === node.id || p.id === cid) ||
      points.find((p) => zhName(p.id) === zh) ||
      points.find((p) => p.zh === zh || p.zh === node.zh)
    );
  };

  const onMindmapSelect = (node: MindmapTreeNode) => {
    setSelectedMindNode(node);
    const hit = matchReviewPoint(node);
    const practiceId = knowledgeResourceIdentity(node, hit?.id);
    practiceSelectionRef.current = practiceId ? { id: practiceId, zh: hit?.zh || node.zh } : null;
    practiceRequestRef.current += 1;
    // 只高亮/对齐笔记，不写 kp：避免左侧误入「相关视频」检索态
    if (hit) {
      setSelectedId(hit.id);
      saveFocus(courseId, {
        lectureId: sessionId,
        entityId: hit.id,
        zh: hit.zh,
      });
    } else {
      setSelectedId(node.id);
    }
  };

  const goSession = (id: string) => {
    if (id === sessionId) return;
    const target = sessions.find((s) => s.id === id);
    // 先锁定课次，规避 RR location 与 window.location 短暂不同步
    setForcedSessionId(id);
    // 立刻清掉旧课次片源，避免切换瞬间用错视频 / 404 URL
    setParts([]);
    setPartsSessionId("");
    setPoints([]);
    setError(null);
    if (target?.lectureIds?.[0]) setActivePart(target.lectureIds[0]);
    setSeekToSec(null);
    setSelectedId(null);
    setSelectedMindNode(null);
    // 保留 embed / resource_course_id / role 等，否则交学伴浅色主题会掉回深色
    const next = new URLSearchParams(searchParams);
    next.delete("t");
    next.delete("kp");
    next.delete("q");
    next.delete("video_id");
    if (target?.lectureIds?.[0]) next.set("lec", target.lectureIds[0]);
    else next.delete("lec");
    if (parentOrigin) next.set("parent_origin", parentOrigin);
    if (kgLaunchToken) next.set("kg_token", kgLaunchToken);
    const qs = next.toString();
    const to = `${coursePath(courseId, `/apps/review/${id}`)}${qs ? `?${qs}` : ""}`;
    // 只用 RR navigate：勿对无 basename 的路径 pushState（/staging/kg 下会跳飞白屏）
    navigate(to);
  };

  const jumpToHit = (hit: EntitySegmentHit) => {
    const lectureId = String(hit.lectureId || "").trim();
    if (!lectureId) return;
    practiceSelectionRef.current = { id: hit.pointId, zh: hit.pointZh };
    practiceRequestRef.current += 1;
    setSelectedId(hit.pointId);
    const targetSession =
      sessions.find((s) => s.lectureIds.includes(lectureId)) || null;
    // 跨课次：与 goSession 一样先锁定 rawId，并清掉旧片源，否则 RR 路径短暂不同步时会停在原课
    if (targetSession && targetSession.id !== sessionId) {
      setForcedSessionId(targetSession.id);
      setParts([]);
      setPartsSessionId("");
      setPoints([]);
      setError(null);
      setActivePart(lectureId);
      setSelectedMindNode(null);
      setSeekToSec(hit.start_sec);
      setSeekToken((n) => n + 1);
      const next = new URLSearchParams(searchParams);
      next.set("lec", lectureId);
      next.set("kp", hit.pointId);
      next.set("t", String(Math.floor(hit.start_sec)));
      if (parentOrigin) next.set("parent_origin", parentOrigin);
      if (kgLaunchToken) next.set("kg_token", kgLaunchToken);
      const qs = next.toString();
      navigate(
        `${coursePath(courseId, `/apps/review/${targetSession.id}`)}${qs ? `?${qs}` : ""}`,
      );
      return;
    }
    // 索引讲次不在课次表里：仍尝试按讲次切分（同会话内上/下）
    if (!targetSession) {
      switchPart(lectureId, { t: hit.start_sec, kp: hit.pointId });
      setSeekToSec(hit.start_sec);
      setSeekToken((n) => n + 1);
      return;
    }
    switchPart(lectureId, { t: hit.start_sec, kp: hit.pointId });
    setSeekToSec(hit.start_sec);
    setSeekToken((n) => n + 1);
  };

  const openPractice = async () => {
    const resourceCourse = canvasCourseId || courseId;
    const context = resolveVideoPracticeContext({
      selected: practiceSelectionRef.current,
      search: entitySearchDraft,
      catalog: searchCatalog,
      points,
      captions: captionsKey === `${courseId}\u0000${activePart}` ? captions : [],
      sec: playbackSecRef.current ?? (Number.isFinite(seekToSec) ? Number(seekToSec) : 0),
    });
    if (!context) {
      window.alert("未定位到知识点：请选择或检索知识点，或播放到包含知识点的字幕后重试");
      return;
    }
    const request = ++practiceRequestRef.current;
    const contextKey = practiceContextRef.current;
    setPracticeOpening(true);
    try {
      const resource = await buildVideoPracticeResource(context, resourceCourse, (point) =>
        fetchLinkedKnowledgeResources({
          courseId: resourceCourse,
          knowledgePointId: point.id,
          nodeName: point.zh,
          kgToken: kgLaunchToken,
        }),
      );
      if (request !== practiceRequestRef.current || contextKey !== practiceContextRef.current) return;
      emitKnowledgeResourceOpen(resource, parentOrigin || "*");
    } catch (error) {
      if (request === practiceRequestRef.current && contextKey === practiceContextRef.current) {
        window.alert(error instanceof Error ? error.message : "知识点匹配失败，请稍后重试");
      }
    } finally {
      setPracticeOpening(false);
    }
  };

  const entitySearchCandidates = useMemo(() => {
    const q = entitySearchDraft.trim().toLowerCase();
    if (!q) return [] as SearchEntity[];
    const scored = searchCatalog
      .map((e) => {
        const zh = e.zh.toLowerCase();
        const id = e.id.toLowerCase();
        const idZh = zhName(e.id).toLowerCase();
        let score = 0;
        if (zh === q || id === q || idZh === q) score = 3;
        else if (zh.startsWith(q) || idZh.startsWith(q)) score = 2;
        else if (zh.includes(q) || id.includes(q) || idZh.includes(q)) score = 1;
        return { e, score, label: e.zh || e.id, id: e.id };
      })
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.e.zh.localeCompare(b.e.zh, "zh"),
      );
    return dedupeEntityMatchesByZh(scored)
      .slice(0, 12)
      .map((x) => x.e);
  }, [entitySearchDraft, searchCatalog]);

  const applyExactEntitySearch = (entity: SearchEntity) => {
    practiceSelectionRef.current = null;
    practiceRequestRef.current += 1;
    setEntitySearchDraft(entity.zh || entity.id);
    setEntitySearchOpen(false);
    setSearchSubmitHint(null);
    setPendingSearch({ kp: entity.id });
    const next = new URLSearchParams(searchParams);
    next.delete("q");
    next.set("kp", entity.id);
    setSearchParams(next, { replace: true });
  };

  const submitEntityVideoSearch = () => {
    const q = entitySearchDraft.trim();
    setEntitySearchOpen(false);
    const next = new URLSearchParams(searchParams);
    if (!q) {
      next.delete("kp");
      next.delete("q");
      setSearchSubmitHint(null);
      setPendingSearch(null);
      setSearchParams(next, { replace: true });
      return;
    }
    // 当前课 points 也可命中（目录尚未扫完时）
    const fromSessionPoints = (points as ReviewPoint[]).find((p) => {
      const zh = String(p.zh || "").trim();
      const idZh = zhName(p.id);
      return (
        p.id === q ||
        zh === q ||
        idZh === q ||
        zh.toLowerCase() === q.toLowerCase() ||
        idZh.toLowerCase() === q.toLowerCase()
      );
    });
    const hit =
      resolveExactSearchEntity(searchCatalog, q) ||
      (fromSessionPoints
        ? {
            id: fromSessionPoints.id,
            zh: String(fromSessionPoints.zh || zhName(fromSessionPoints.id)),
          }
        : null) ||
      entitySearchCandidates[0] ||
      null;
    if (hit) {
      setSearchSubmitHint(null);
      applyExactEntitySearch(hit);
      return;
    }
    if (searchCatalogLoading && searchCatalog.length < 8) {
      // 目录还很空：进入检索态并提示，避免「点了没反应」
      setSearchSubmitHint("索引仍在加载，稍后结果会补全…");
    } else {
      setSearchSubmitHint(null);
    }
    // 无精确实体：仍进入检索态（相关视频列表）
    setPendingSearch({ q });
    next.delete("kp");
    next.set("q", q);
    setSearchParams(next, { replace: true });
  };

  const clearEntityFilter = () => {
    practiceSelectionRef.current = null;
    practiceRequestRef.current += 1;
    setSelectedId(null);
    setSelectedMindNode(null);
    const next = new URLSearchParams(searchParams);
    next.delete("kp");
    next.delete("q");
    setEntitySearchDraft("");
    setEntitySearchOpen(false);
    setPendingSearch(null);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    if (!entitySearchOpen) return;
    const onDoc = (ev: MouseEvent) => {
      if (!entitySearchWrapRef.current?.contains(ev.target as Node)) {
        setEntitySearchOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [entitySearchOpen]);

  const sessionDateLabel = (s: { lectureIds: string[] }) => {
    for (const id of s.lectureIds) {
      const item = videoItems.find((v) => String(v.lecture_id) === id) as
        | (ReviewShowcaseItem & { date?: string; recorded_at?: string })
        | undefined;
      const raw = String(item?.date || item?.recorded_at || "").trim();
      if (raw) return raw;
    }
    return "";
  };

  if (!rawId && !videoItems.length && showcase) {
    return (
      <div className={styles.emptyPage}>
        <p>暂无复习数据。请先导出 review 并 sync-data。</p>
        <Link to={coursePath(courseId)}>返回课程</Link>
      </div>
    );
  }

  if (!rawId && firstPlayableSessionId) {
    return (
      <Navigate
        to={coursePath(courseId, `/apps/review/${firstPlayableSessionId}`)}
        replace
      />
    );
  }

  if (!rawId) {
    return <Navigate to={coursePath(courseId, "/apps/review/1")} replace />;
  }

  if (needsRedirect && session) {
    return (
      <Navigate
        to={`${coursePath(courseId, `/apps/review/${session.id}`)}${redirectSearch}`}
        replace
      />
    );
  }

  const jumpBar = (
    <header className={styles.workspaceTop}>
      <div className={styles.workspaceLeft}>
        {loading ? <p className={styles.workspaceHint}>加载中…</p> : null}
        {error ? <p className={styles.workspaceHint}>{error}</p> : null}
      </div>
      <div className={styles.workspaceRight}>
        <button type="button" className={styles.jump} disabled={practiceOpening} onClick={() => void openPractice()}>
          {practiceOpening ? "匹配知识点…" : "相关练习"}
        </button>
        {anyClassVideo ? (
          <button
            type="button"
            className={styles.jump}
            onClick={() => setShowVideo((v) => !v)}
          >
            {showVideo ? "隐藏视频" : "显示视频"}
          </button>
        ) : null}
      </div>
    </header>
  );

  const mapViewChips = (
    <div className={styles.mapViewChips} role="tablist" aria-label="导图与图谱">
      <button
        type="button"
        role="tab"
        aria-selected={mapView === "mindmap"}
        className={`${kgStyles.kgChip} ${
          mapView === "mindmap" ? kgStyles.kgChipActive : ""
        }`}
        onClick={() => setMapView("mindmap")}
      >
        思维导图
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mapView === "graph"}
        className={`${kgStyles.kgChip} ${
          mapView === "graph" ? kgStyles.kgChipActive : ""
        }`}
        onClick={() => setMapView("graph")}
      >
        关系图谱
      </button>
    </div>
  );

  const navPanel = listCollapsed ? (
    <aside className={kgStyles.kgSideRail} aria-label="课次列表（已收起）">
      <button
        type="button"
        className={kgStyles.kgSideRailBtn}
        title="展开列表"
        aria-label="展开列表"
        onClick={expandList}
      >
        <span aria-hidden>›</span>
      </button>
    </aside>
  ) : (
    <aside className={`${shell.sidebar} ${styles.navSide}`}>
      <button
        type="button"
        className={styles.navCollapseBtn}
        title="收起列表"
        aria-label="收起列表"
        onClick={collapseList}
      >
        <span aria-hidden>‹</span>
      </button>
      <div className={styles.navSearchRow}>
        <div className={styles.entitySearchWrap} ref={entitySearchWrapRef}>
          <form
            className={styles.entitySearchBar}
            onSubmit={(e) => {
              e.preventDefault();
              submitEntityVideoSearch();
            }}
          >
            <div className={styles.entitySearchField}>
              <input
                type="search"
                className={styles.entitySearchInput}
                value={entitySearchDraft}
                placeholder="检索视频"
                aria-label="检索视频"
                autoComplete="off"
                onFocus={() => setEntitySearchOpen(true)}
                onChange={(e) => {
                  practiceSelectionRef.current = null;
                  practiceRequestRef.current += 1;
                  const v = e.target.value;
                  setEntitySearchDraft(v);
                  setEntitySearchOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEntitySearchOpen(false);
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (entitySearchCandidates[0]) {
                      applyExactEntitySearch(entitySearchCandidates[0]);
                    } else {
                      submitEntityVideoSearch();
                    }
                  }
                }}
              />
              {entitySearchDraft.trim() ? (
                <button
                  type="button"
                  className={styles.entitySearchClear}
                  aria-label="清除搜索"
                  title="清除"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearEntityFilter();
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
            <button
              type="submit"
              className={styles.jump}
              onClick={(e) => {
                // 显式触发，避免个别环境下 form submit 被吞
                e.preventDefault();
                submitEntityVideoSearch();
              }}
            >
              {searchCatalogLoading && searchCatalog.length < 4 ? "索引中…" : "检索"}
            </button>
          </form>
          {entitySearchOpen && entitySearchDraft.trim() ? (
            <div className={styles.entitySearchMenu} role="listbox">
              {entitySearchCandidates.length === 0 ? (
                <div className={styles.entitySearchEmpty}>
                  {searchCatalogLoading
                    ? "索引加载中，可先点检索或稍后再试"
                    : "无匹配实体"}
                </div>
              ) : (
                entitySearchCandidates.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    className={styles.entitySearchItem}
                    onClick={() => applyExactEntitySearch(m)}
                    title={m.id}
                  >
                    <span>{m.zh}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        {mapViewChips}
      </div>
      <div className={shell.sideHead}>
        <p className={shell.eyebrow}>{entityMode ? "相关视频" : "课次列表"}</p>
      </div>
      {entityMode ? (
        <ul className={styles.videoList}>
          {searchSubmitHint ? (
            <li className={styles.listHint}>{searchSubmitHint}</li>
          ) : null}
          {entityHitsLoading ? (
            <li className={styles.listHint}>加载相关视频…</li>
          ) : null}
          {!entityHitsLoading && !entityHits.length ? (
            <li className={styles.listHint}>
              {searchCatalogLoading
                ? "索引加载中，正在查找相关片段…"
                : "暂无与该实体相关的视频"}
            </li>
          ) : null}
          {entityHits.map((hit) => {
            const active =
              hit.lectureId === activePart &&
              seekToSec != null &&
              Math.abs(Number(seekToSec) - hit.start_sec) < 1.5;
            const hitSession =
              sessions.find((s) => s.lectureIds.includes(String(hit.lectureId))) ||
              null;
            const hitPartIdx = hitSession
              ? hitSession.lectureIds.indexOf(String(hit.lectureId))
              : -1;
            const hitSessionLabel =
              hitSession?.label ||
              (() => {
                const n = Number(hit.lectureId);
                return Number.isFinite(n) && n > 0
                  ? `第 ${Math.ceil(n / 2)} 次课`
                  : `第 ${hit.lectureId} 讲`;
              })();
            const hitPartTag =
              hitSession && hitSession.lectureIds.length === 2
                ? hitPartIdx === 0
                  ? "上"
                  : "下"
                : hitSession && hitSession.lectureIds.length === 1
                  ? null
                  : (() => {
                      const n = Number(hit.lectureId);
                      if (!Number.isFinite(n) || n <= 0) return null;
                      return n % 2 === 1 ? "上" : "下";
                    })();
            const hitBadge = hitPartTag
              ? `${hitSessionLabel} · ${hitPartTag}`
              : hitSessionLabel;
            return (
              <li key={hit.key}>
                <button
                  type="button"
                  className={active ? styles.videoActive : styles.videoItem}
                  onClick={() => jumpToHit(hit)}
                >
                  <span className={styles.videoBadge}>
                    {hitBadge} · {fmtClock(hit.start_sec)}
                  </span>
                  <span className={styles.videoMeta}>
                    <strong>{hit.pointZh}</strong>
                    <span className={styles.videoSnippet}>{hit.text}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className={styles.videoList}>
          {sessions.map((s) => {
            const active = s.id === sessionId;
            const dateText = sessionDateLabel(s);
            const hasVid = sessionHasVideo(s);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={active ? styles.videoActive : styles.videoItem}
                  onClick={() => goSession(s.id)}
                >
                  <span className={styles.videoMeta}>
                    <strong>{s.label}</strong>
                    {!hasVid || dateText ? (
                      <span>
                        {!hasVid ? "暂无课堂视频" : ""}
                        {!hasVid && dateText ? " · " : ""}
                        {dateText || ""}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );

  return (
    <ResizableShell
      storagePrefix="shell-review-v3"
      nav={navPanel}
      navFixedLeftPx={listCollapsed ? 32 : undefined}
      detailFixedRightPx={detailCollapsed ? 32 : undefined}
      main={
        <main className={styles.mainCol}>
          {jumpBar}
          <div className={styles.centerPane}>
            <ResizableSplit
              className={styles.videoGraphSplit}
              orientation="vertical"
              storageKey="split-review-video-graph"
              sizedPane="left"
              initialLeftRatio={0.36}
              minLeftPx={200}
              minRightPx={160}
              enabled={Boolean(
                showVideo &&
                  (anyClassVideo || loading || partsSessionId !== sessionId),
              )}
              hideWhenDisabled="left"
              left={
                <div className={styles.playerBlock}>
                  {sessionParts.length > 1 ? (
                    <div className={styles.videoPartSwitch} role="tablist" aria-label="本堂课视频">
                      {sessionParts.map((p, i) => {
                        const url = toMediaUrl(p.class_video || null);
                        const on = String(p.lectureId) === String(activePart);
                        const sessionLabel = session?.label || "本次课";
                        const partTag =
                          sessionParts.length === 2
                            ? i === 0
                              ? "上"
                              : "下"
                            : `第 ${p.lectureId} 讲`;
                        return (
                          <button
                            key={p.lectureId}
                            type="button"
                            role="tab"
                            aria-selected={on}
                            className={on ? styles.videoPartActive : styles.videoPartBtn}
                            onClick={() => switchPart(p.lectureId)}
                          >
                            {sessionParts.length === 2
                              ? `${sessionLabel} · ${partTag}`
                              : partTag}
                            {!url ? "（无文件）" : ""}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {classVideoUrl ? (
                    <VideoChapterPlayer
                      key={`player-${sessionId}-${activePart}-${classVideoUrl}`}
                      src={classVideoUrl}
                      segments={segments}
                      durationHint={activeVideo?.duration_sec}
                      seekToSec={seekToSec}
                      seekNonce={seekToken}
                      captions={captions}
                      fill
                      onReady={() => setMediaReady(true)}
                      onTime={(sec) => {
                        playbackSecRef.current = sec;
                        reportVideoWatch(
                          sec,
                          Number(activeVideo?.duration_sec) || 0,
                        );
                      }}
                    />
                  ) : (
                    <div className={styles.playerEmpty}>
                      {loading || partsSessionId !== sessionId
                        ? "加载课堂视频…"
                        : anyClassVideo
                          ? "请切换到有课堂视频的那一讲"
                          : "本堂课暂无课堂视频文件"}
                    </div>
                  )}
                </div>
              }
              right={
                <div className={styles.pointsBlock}>
                  {error && <p className={styles.empty}>{error}</p>}
                  <div className={styles.mapStack}>
                    <div
                      className={styles.mapPane}
                      data-hidden={mapView === "mindmap" ? "0" : "1"}
                    >
                      {mindmapError && mapView === "mindmap" ? (
                        <p className={styles.empty}>{mindmapError}</p>
                      ) : null}
                      {(loading || mindmapLoading) &&
                      !mindmap &&
                      !mindmapError &&
                      mapView === "mindmap" ? (
                        <p className={styles.empty}>加载导图…</p>
                      ) : null}
                      {!mindmap &&
                      !mindmapError &&
                      !loading &&
                      !mindmapLoading &&
                      mapView === "mindmap" ? (
                        <p className={styles.empty}>暂无思维导图</p>
                      ) : null}
                      {mindmap ? (
                        <MindmapTree
                          className={styles.mindmapHost}
                          doc={mindmap}
                          balanceRoot={false}
                          resetKey={mapKey}
                          selectedId={selectedId}
                          onSelect={onMindmapSelect}
                        />
                      ) : null}
                    </div>
                      <div
                      className={styles.mapPane}
                      data-hidden={mapView === "graph" ? "0" : "1"}
                    >
                      <div className={styles.graphHost}>
                        {mapView === "graph" && (activePart || sessionId) ? (
                          <LectureReviewGraph
                            key={`lecture-graph-${
                              session && session.lectureIds.length >= 2
                                ? session.id
                                : activePart || sessionId
                            }`}
                            points={graphPoints}
                            highlightIds={selectedId ? [selectedId] : []}
                            courseId={courseId}
                            lectureId={
                              session && session.lectureIds.length >= 2
                                ? session.id
                                : activePart || sessionId
                            }
                            graphScope="lecture"
                            onSelectNode={(p) => {
                              if (!p) {
                                setSelectedId(null);
                                setSelectedMindNode(null);
                                return;
                              }
                              setSelectedId(p.id);
                              setSelectedMindNode(null);
                              // 实体关系详情只在图谱内右栏小卡片展示，不抢外壳笔记栏
                              saveFocus(courseId, {
                                lectureId: activePart || sessionId,
                                entityId: p.id,
                                zh: p.zh,
                              });
                            }}
                          />
                        ) : (
                          <p className={styles.empty}>切换到「关系图谱」后加载</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              }
            />
          </div>
        </main>
      }
      detail={
        detailCollapsed ? (
          <aside className={kgStyles.kgSideRail} aria-label="笔记栏（已收起）">
            <button
              type="button"
              className={kgStyles.kgSideRailBtn}
              title="展开笔记"
              aria-label="展开笔记"
              onClick={expandNotes}
            >
              <span aria-hidden>‹</span>
            </button>
          </aside>
        ) : (
          <aside className={`${shell.sidebar} ${styles.notesSide}`} aria-label="复习笔记">
            <button
              type="button"
              className={styles.notesCollapseBtn}
              title="收起笔记"
              aria-label="收起笔记"
              onClick={collapseNotes}
            >
              <span aria-hidden>›</span>
            </button>
            <LectureStudyNotes
              courseId={courseId}
              lectureId={sessionId || activePart || rawId}
              title={sessionHeading || session?.label}
              points={graphPoints}
              focusId={selectedId}
              focusZh={
                selected?.zh ||
                selectedMindNode?.zh ||
                (selectedId ? zhName(selectedId) : null)
              }
              deferNetwork={!mediaReady}
              onCollapse={collapseNotes}
            />
          </aside>
        )
      }
    />
  );
}
