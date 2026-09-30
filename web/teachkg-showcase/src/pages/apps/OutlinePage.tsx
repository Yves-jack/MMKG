import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppsChrome } from "@/components/apps/AppsChrome";
import { PointDetailCard } from "@/components/apps/PointDetailCard";
import { LatexText } from "@/components/pipeline/LatexText";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import {
  MindmapTree,
  type MindmapDoc,
  type MindmapTreeNode,
} from "@/components/mindmap/MindmapTree";
import {
  loadReviewIndex,
  loadReviewLecture,
  matchPoint,
  zhName,
  type AppReviewPoint,
} from "@/lib/apps/data";
import { saveFocus, loadFocus } from "@/lib/apps/focus";
import { loadReviewLectureMindmap } from "@/lib/apps/loadReviewClassroomGraph";
import { coursePath, useCourseId } from "@/lib/course";
import shell from "@/styles/shell.module.css";
import styles from "./Apps.module.css";

/** 导图 · 知识点：树状导图与浓缩要点联动 */
export function OutlinePage() {
  const courseId = useCourseId() || "数理逻辑";
  const [lectureId, setLectureId] = useState(() => loadFocus(courseId)?.lectureId || "1");
  const [lectures, setLectures] = useState<{ id: string; title?: string }[]>([]);
  const [mindmap, setMindmap] = useState<MindmapDoc | null>(null);
  const [points, setPoints] = useState<AppReviewPoint[]>([]);
  const [selected, setSelected] = useState<AppReviewPoint | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const [mapKey, setMapKey] = useState(0);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    loadReviewIndex(courseId).then((items) => {
      const list = items.map((i) => ({ id: i.lecture_id, title: i.title }));
      setLectures(list);
      const focus = loadFocus(courseId);
      if (focus && list.some((l) => l.id === focus.lectureId)) {
        setLectureId(focus.lectureId);
      } else if (list.length && !list.some((l) => l.id === lectureId)) {
        setLectureId(list[0].id);
      }
    });
  }, [courseId]);

  useEffect(() => {
    setSelected(null);
    setExpandAll(false);
    setMapKey((k) => k + 1);
    loadReviewLecture(courseId, lectureId).then((doc) => {
      const pts = doc?.points || [];
      setPoints(pts);
      const focus = loadFocus(courseId);
      if (focus && focus.lectureId === lectureId) {
        const hit =
          matchPoint(pts, focus.entityId) || matchPoint(pts, focus.zh);
        if (hit) {
          setSelected(hit);
          return;
        }
      }
      if (pts[0]) setSelected(pts[0]);
    });
    let cancelled = false;
    loadReviewLectureMindmap(courseId, lectureId)
      .then((d) => {
        if (!cancelled) setMindmap(d);
      })
      .catch(() => {
        if (!cancelled) setMindmap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, lectureId]);

  const onSelectNode = (node: MindmapTreeNode) => {
    const hit =
      matchPoint(points, node.zh) ||
      matchPoint(points, zhName(node.id)) ||
      matchPoint(points, node.id);
    if (hit) {
      setSelected(hit);
      saveFocus(courseId, {
        lectureId,
        entityId: hit.id,
        zh: hit.zh,
      });
      return;
    }
    setSelected({
      id: node.id,
      zh: node.zh,
      importance: node.importance || 0,
      origin: "mindmap",
      summary: (node.related || []).length
        ? `导图相关：${(node.related || []).join("、")}`
        : "该节点暂无复习浓缩，可换一个要点或去图谱查看。",
    });
  };

  const topPoints = useMemo(() => {
    const s = filter.trim().toLowerCase();
    const list = s
      ? points.filter(
          (p) =>
            p.zh.toLowerCase().includes(s) ||
            (p.summary || "").toLowerCase().includes(s)
        )
      : points;
    return list.slice(0, 14);
  }, [points, filter]);

  return (
    <ResizableShell
      storagePrefix="shell-app-outline"
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to={coursePath(courseId)}>
              <span className={shell.backIcon}>←</span>
              <span className={shell.backBrand}>
                Teach<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>导图</p>
          </div>
          <ul className={styles.listNav}>
            {lectures.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  className={l.id === lectureId ? styles.lecBtnActive : styles.lecBtn}
                  onClick={() => setLectureId(l.id)}
                >
                  <span className={styles.badge}>第 {l.id} 讲</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      }
      main={
        <main className={styles.page}>
          <AppsChrome
            courseId={courseId}
            lectureId={lectureId}
            title="导图"
          />
          <div className={styles.body}>
            <div className={styles.split}>
              <div
                className={styles.panel}
                style={{ display: "flex", flexDirection: "column", padding: 0 }}
              >
                <div className={styles.jumps} style={{ padding: "10px 12px 0" }}>
                  <button
                    type="button"
                    className={styles.jump}
                    onClick={() => {
                      setExpandAll(true);
                      setMapKey((k) => k + 1);
                    }}
                  >
                    展开
                  </button>
                  <button
                    type="button"
                    className={styles.jump}
                    onClick={() => {
                      setExpandAll(false);
                      setMapKey((k) => k + 1);
                    }}
                  >
                    收起
                  </button>
                </div>
                {mindmap ? (
                  <MindmapTree
                    doc={mindmap}
                    resetKey={mapKey}
                    expandAll={expandAll}
                    selectedId={selected?.id}
                    onSelect={onSelectNode}
                    className={styles.page}
                  />
                ) : (
                  <p className={styles.empty} style={{ padding: 16 }}>
                    本讲处理后的图谱为空，暂无导图
                  </p>
                )}
              </div>
              <div className={styles.panelAside}>
                <p className={styles.headLabel}>知识点</p>
                {selected ? (
                  <PointDetailCard
                    courseId={courseId}
                    lectureId={lectureId}
                    point={selected}
                    compact
                    showEvidence={false}
                  />
                ) : (
                  <p className={styles.empty}>点击导图节点，或从下方要点进入</p>
                )}
                <p className={styles.headLabel} style={{ marginTop: 16 }}>
                  本讲要点
                </p>
                <div className={styles.searchRow}>
                  <input
                    value={filter}
                    placeholder="筛选要点…"
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                {topPoints.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={selected?.id === p.id ? styles.cardActive : styles.card}
                    onClick={() => {
                      setSelected(p);
                      saveFocus(courseId, {
                        lectureId,
                        entityId: p.id,
                        zh: p.zh,
                      });
                    }}
                  >
                    <strong>
                      {p.rank}. {p.zh}
                    </strong>
                    <em>
                      <LatexText text={(p.summary || "").slice(0, 60)} />
                    </em>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </main>
      }
    />
  );
}
