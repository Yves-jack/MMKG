import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppSwitcher } from "@/components/apps/AppSwitcher";
import { LectureReviewGraph } from "@/components/apps/LectureReviewGraph";
import { LectureStudyNotes } from "@/components/apps/LectureStudyNotes";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { ResizableSplit } from "@/components/pipeline/ResizableSplit";
import {
  MindmapTree,
  type MindmapDoc,
  type MindmapTreeNode,
} from "@/components/mindmap/MindmapTree";
import { type AppReviewPoint } from "@/lib/apps/data";
import {
  VideoChapterPlayer,
  type VideoSegment,
} from "@/components/review/VideoChapterPlayer";
import { toMediaUrl } from "@/lib/kg/adaptToPipeline";
import { saveFocus } from "@/lib/apps/focus";
import { enrichVideoSegments } from "@/lib/apps/enrichVideoSegments";
import { loadLectureAsrCaptions, type AsrCaption } from "@/lib/apps/asrCaptions";
import { loadReviewLectureMindmap } from "@/lib/apps/loadReviewClassroomGraph";
import {
  applyMindmapEditPatch,
  loadMindmapEditPatch,
} from "@/lib/apps/mindmapEdits";
import {
  pairLecturesIntoSessions,
  parseSessionRouteId,
  resolveReviewSession,
  sessionTitle,
  type ReviewSession,
} from "@/lib/apps/reviewSession";
import {
  WATCH_CLASSROOM_EVENT,
  type WatchClassroomDetail,
} from "@/lib/apps/reviewSeek";
import { WatchClassroom } from "@/components/apps/WatchClassroom";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import shell from "@/styles/shell.module.css";
import styles from "./ReviewPage.module.css";

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

function pickWatchTarget(
  point: ReviewPoint | null,
  fallbackLectureId: string
): { lectureId: string; sec: number } | null {
  if (!point) return null;
  const timed = (point.evidence || []).filter((e) =>
    Number.isFinite(Number(e.start_sec))
  );
  if (!timed.length) return null;
  let best = timed[0];
  for (const e of timed) {
    if (Number(e.start_sec) < Number(best.start_sec)) best = e;
  }
  return {
    lectureId: String(best.lecture_id || fallbackLectureId),
    sec: Number(best.start_sec),
  };
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
  const { lectureId: rawId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [showcase, setShowcase] = useState<ReviewShowcase | null>(null);
  const [parts, setParts] = useState<SessionPart[]>([]);
  const [points, setPoints] = useState<ReviewPoint[]>([]);
  const [sessionHeading, setSessionHeading] = useState<string>("");
  const [mindmap, setMindmap] = useState<MindmapDoc | null>(null);
  const [mindmapError, setMindmapError] = useState<string | null>(null);
  const [mindmapLoading, setMindmapLoading] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
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
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [seekToSec, setSeekToSec] = useState<number | null>(null);
  const [seekToken, setSeekToken] = useState(0);
  const [activePart, setActivePart] = useState<string>("");
  const [captions, setCaptions] = useState<AsrCaption[]>([]);
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

  const videoItems = useMemo(() => {
    const items = [...(showcase?.items || [])];
    items.sort((a, b) => Number(a.lecture_id) - Number(b.lecture_id));
    return items;
  }, [showcase]);

  const sessions = useMemo(
    () => pairLecturesIntoSessions(videoItems.map((v) => String(v.lecture_id))),
    [videoItems]
  );

  const session = useMemo(
    () => resolveReviewSession(rawId, sessions),
    [rawId, sessions]
  );

  const sessionId = session?.id || "";

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
    if (!rawId && sessions.length) {
      navigate(coursePath(courseId, `/apps/review/${sessions[0].id}`), {
        replace: true,
      });
    }
  }, [rawId, sessions, courseId, navigate]);

  useEffect(() => {
    if (!session) return;
    const fromQuery =
      lecParam && session.lectureIds.includes(lecParam) ? lecParam : "";
    setActivePart(fromQuery || session.lectureIds[0] || "");
  }, [session, lecParam]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setParts([]);
    setPoints([]);
    const load = async () => {
      const loaded = await Promise.all(
        session.lectureIds.map(async (id) => {
          const item = videoItems.find((v) => String(v.lecture_id) === id);
          try {
            const r = await fetch(
              `${courseDataUrl(courseId, `review/lecture_${id}.json`)}?t=${Date.now()}`,
              { cache: "no-store" }
            );
            if (!r.ok) {
              return {
                lectureId: id,
                doc: null as ReviewDoc | null,
                item,
              };
            }
            const doc = (await r.json()) as ReviewDoc;
            return { lectureId: id, doc, item };
          } catch {
            return { lectureId: id, doc: null as ReviewDoc | null, item };
          }
        })
      );
      if (cancelled) return;
      const ok = loaded.filter((x) => x.doc);
      if (!ok.length) {
        setError("缺少本堂课复习数据，请先运行 export_lecture_review.py");
        setLoading(false);
        return;
      }
      const nextParts: SessionPart[] = loaded.map(({ lectureId, doc, item }) => ({
        lectureId,
        title: doc?.title || item?.title,
        class_video: doc?.class_video || item?.class_video || null,
        ppt_video: doc?.ppt_video || item?.ppt_video || null,
        duration_sec: doc?.duration_sec ?? item?.duration_sec ?? null,
        segments: enrichVideoSegments(doc?.segments || [], doc?.points || []),
      }));
      const merged = mergeSessionPoints(
        ok.map(({ lectureId, doc }) => ({
          lectureId,
          points: doc?.points || [],
        }))
      );
      const firstTitle = ok.map((x) => x.doc?.title).find(Boolean);
      setParts(nextParts);
      setPoints(merged);
      setSessionHeading(sessionTitle(session, firstTitle));
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [courseId, session, videoItems]);

  useEffect(() => {
    if (!points.length) return;
    if (kpParam) {
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
      cur && points.some((p) => p.id === cur) ? cur : points[0]?.id ?? null
    );
  }, [points, kpParam, courseId, sessionId]);

  const activeVideo = useMemo(
    () => parts.find((p) => p.lectureId === activePart) || null,
    [parts, activePart]
  );

  const classVideoUrl = useMemo(
    () => toMediaUrl(activeVideo?.class_video || null),
    [activeVideo?.class_video]
  );

  const anyClassVideo = useMemo(
    () => parts.some((p) => Boolean(toMediaUrl(p.class_video || null))),
    [parts]
  );

  useEffect(() => {
    if (!courseId || !activePart) {
      setCaptions([]);
      return;
    }
    let cancelled = false;
    loadLectureAsrCaptions(courseId, activePart).then((caps) => {
      if (!cancelled) setCaptions(caps);
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
    if (!sessionId) return;
    setMindmap(null);
    setMindmapError(null);
    setMindmapLoading(true);
    setSelectedMindNode(null);
    setExpandAll(false);
    setMapKey((k) => k + 1);
    let cancelled = false;
    loadReviewLectureMindmap(courseId, sessionId)
      .then((d) => {
        if (cancelled) return;
        const patched = applyMindmapEditPatch(
          d,
          loadMindmapEditPatch(courseId, sessionId)
        );
        setMindmap(patched);
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
    };
  }, [courseId, sessionId]);

  const graphPoints = points as AppReviewPoint[];
  const segments = activeVideo?.segments || [];
  const selected = points.find((p) => p.id === selectedId) || null;
  const watch = pickWatchTarget(selected, activePart || session?.lectureIds[0] || "");

  const switchPart = (lectureId: string, extra?: { t?: number; kp?: string | null }) => {
    setActivePart(lectureId);
    const next = new URLSearchParams(searchParams);
    next.set("lec", lectureId);
    if (extra?.kp) next.set("kp", extra.kp);
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

  const selectPoint = (id: string) => {
    setSelectedId(id);
    setDetailCollapsed(false);
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
    const zh = (zhName(node.id) || node.zh || "").trim();
    return (
      points.find((p) => p.id === node.id) ||
      points.find((p) => zhName(p.id) === zh) ||
      points.find((p) => p.zh === zh || p.zh === node.zh)
    );
  };

  const onMindmapSelect = (node: MindmapTreeNode) => {
    setSelectedMindNode(node);
    setDetailCollapsed(false);
    const hit = matchReviewPoint(node);
    if (hit) {
      selectPoint(hit.id);
    } else {
      setSelectedId(node.id);
      const next = new URLSearchParams(searchParams);
      next.set("kp", node.id);
      next.delete("t");
      setSearchParams(next, { replace: true });
    }
  };

  const goSession = (id: string) => {
    navigate(coursePath(courseId, `/apps/review/${id}`));
  };

  if (!rawId && !videoItems.length && showcase) {
    return (
      <div className={styles.emptyPage}>
        <p>暂无复习数据。请先导出 review 并 sync-data。</p>
        <Link to={coursePath(courseId)}>返回课程</Link>
      </div>
    );
  }

  if (!rawId && sessions.length) {
    return (
      <Navigate to={coursePath(courseId, `/apps/review/${sessions[0].id}`)} replace />
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
        <div className={styles.workspaceTitle}>
          <p>
            {mindmap
              ? `导图 ${mindmap.n_nodes} 节点`
              : loading
                ? "加载中…"
                : ""}
            {activeVideo?.duration_sec
              ? `${mindmap || loading ? " · " : ""}${fmtDuration(activeVideo.duration_sec)}`
              : ""}
          </p>
        </div>
      </div>
      <div className={styles.workspaceCenter}>
        <AppSwitcher courseId={courseId} lectureId={sessionId} />
      </div>
      <div className={styles.workspaceRight}>
        
        {anyClassVideo ? (
          <button
            type="button"
            className={styles.jump}
            onClick={() => setShowVideo((v) => !v)}
          >
            {showVideo ? "隐藏视频" : "显示视频"}
          </button>
        ) : null}
        {detailCollapsed ? (
          <button
            type="button"
            className={styles.jump}
            onClick={() => setDetailCollapsed(false)}
          >
            展开笔记
          </button>
        ) : null}
      </div>
    </header>
  );

  return (
    <ResizableShell
      storagePrefix="shell-review-v2"
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
            <p className={shell.eyebrow}>复习</p>
          </div>
          <ul className={styles.videoList}>
            {sessions.map((s) => {
              const active = s.id === sessionId;
              const meta = sessionMeta(s, videoItems);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={active ? styles.videoActive : styles.videoItem}
                    onClick={() => goSession(s.id)}
                  >
                    <span className={styles.videoBadge}>{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      }
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
              minLeftPx={120}
              minRightPx={160}
              enabled={Boolean(showVideo && anyClassVideo)}
              hideWhenDisabled="left"
              left={
                <div className={styles.playerBlock}>
                  {parts.length > 1 ? (
                    <div className={styles.videoPartSwitch} role="tablist" aria-label="本堂课视频">
                      {parts.map((p, i) => {
                        const url = toMediaUrl(p.class_video || null);
                        const on = p.lectureId === activePart;
                        return (
                          <button
                            key={p.lectureId}
                            type="button"
                            role="tab"
                            aria-selected={on}
                            className={on ? styles.videoPartActive : styles.videoPartBtn}
                            onClick={() => switchPart(p.lectureId)}
                          >
                            第 {p.lectureId} 讲
                            {parts.length === 2 ? (i === 0 ? " · 上" : " · 下") : ""}
                            {!url ? "（无文件）" : ""}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {classVideoUrl ? (
                      <VideoChapterPlayer
                      src={classVideoUrl}
                      segments={segments}
                      durationHint={activeVideo?.duration_sec}
                      seekToSec={seekToSec}
                      seekNonce={seekToken}
                      captions={captions}
                      fill
                    />
                  ) : (
                    <div className={styles.playerEmpty}>
                      {anyClassVideo
                        ? "请切换到有课堂视频的那一讲"
                        : "本堂课暂无课堂视频文件"}
                    </div>
                  )}
                </div>
              }
              right={
            <div className={styles.pointsBlock}>
              <div className={styles.mapHead}>
                <div className={styles.mapViewTabs}>
                  <button
                    type="button"
                    className={mapView === "mindmap" ? styles.mapTabActive : styles.mapTab}
                    onClick={() => setMapView("mindmap")}
                  >
                    思维导图
                  </button>
                  <button
                    type="button"
                    className={mapView === "graph" ? styles.mapTabActive : styles.mapTab}
                    onClick={() => setMapView("graph")}
                  >
                    关系图谱
                  </button>
                </div>
                <div className={styles.mapTools}>
                  {mapView === "mindmap" && mindmap ? (
                    <>
                      <button
                        type="button"
                        className={styles.mapBtn}
                        onClick={() => setExpandAll((v) => !v)}
                      >
                        {expandAll ? "收起导图" : "展开导图"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              {error && <p className={styles.empty}>{error}</p>}
              <div className={styles.mapStack}>
                <div
                  className={styles.mapPane}
                  data-hidden={mapView === "mindmap" ? "0" : "1"}
                >
                  {mindmapError && mapView === "mindmap" ? (
                    <p className={styles.empty}>{mindmapError}</p>
                  ) : null}
                  {(loading || mindmapLoading) && !mindmap && !mindmapError && mapView === "mindmap" ? (
                    <p className={styles.empty}>加载导图…</p>
                  ) : null}
                  {!mindmap && !mindmapError && !loading && !mindmapLoading && mapView === "mindmap" ? (
                    <p className={styles.empty}>暂无思维导图</p>
                  ) : null}
                  {mindmap ? (
                    <MindmapTree
                      className={styles.mindmapHost}
                      doc={mindmap}
                      resetKey={mapKey}
                      expandAll={expandAll}
                      selectedId={selectedId}
                      onSelect={onMindmapSelect}
                      editEnabled
                      courseId={courseId}
                      lectureId={sessionId}
                      onDocChange={setMindmap}
                      onResetEdits={() => {
                        setMapKey((k) => k + 1);
                        loadReviewLectureMindmap(courseId, sessionId)
                          .then((d) => setMindmap(d))
                          .catch(() => null);
                      }}
                    />
                  ) : null}
                </div>
                <div
                  className={styles.mapPane}
                  data-hidden={mapView === "graph" ? "0" : "1"}
                >
                  <div className={styles.graphHost}>
                    {sessionId ? (
                      <LectureReviewGraph
                        points={graphPoints}
                        highlightIds={selectedId ? [selectedId] : []}
                        courseId={courseId}
                        lectureId={sessionId}
                        onSelectNode={(p) => {
                          if (!p) {
                            setSelectedId(null);
                            setSelectedMindNode(null);
                            return;
                          }
                          setSelectedId(p.id);
                          setSelectedMindNode(null);
                          setDetailCollapsed(false);
                          saveFocus(courseId, {
                            lectureId: sessionId,
                            entityId: p.id,
                            zh: p.zh,
                          });
                        }}
                      />
                    ) : null}
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
        detailCollapsed ? undefined : (
          <LectureStudyNotes
            courseId={courseId}
            lectureId={sessionId || rawId}
            title={sessionHeading || session?.label}
            points={graphPoints}
            focusZh={
              selected?.zh ||
              selectedMindNode?.zh ||
              (selectedId ? zhName(selectedId) : null)
            }
            focusId={selectedId}
            onCollapse={() => setDetailCollapsed(true)}
          />
        )
      }
    />
  );
}
