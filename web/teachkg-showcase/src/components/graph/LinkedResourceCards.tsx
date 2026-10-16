import type { ReactNode } from "react";
import type { LinkedKnowledgeResource } from "@/lib/integration/knowledgeResources";
import styles from "@/pages/KgPage.module.css";

const RESOURCE_LABELS: Record<LinkedKnowledgeResource["resource_type"], string> = {
  video: "视频",
  exercise: "练习",
  animation: "动画",
  formula: "公式",
};

const RESOURCE_ACTION: Record<"video" | "exercise" | "animation", string> = {
  video: "打开视频",
  exercise: "进入做题",
  animation: "查看动画",
};

const RESOURCE_FALLBACK_TITLE: Record<"video" | "exercise" | "animation", string> = {
  video: "课堂视频",
  exercise: "练习题",
  animation: "原理动画",
};

const KIND_CLASS: Record<"video" | "exercise" | "animation", string> = {
  video: styles.resourceCardVideo,
  exercise: styles.resourceCardExercise,
  animation: styles.resourceCardAnimation,
};

function resourceTime(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--:--";
  const total = Math.max(0, Math.floor(value));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function stripLectureHeading(text: string): string {
  return String(text || "")
    .replace(
      /^第\s*\d+\s*[–\-—~至到]\s*\d+\s*讲\s*[·•:：\-—]?\s*/u,
      "",
    )
    .replace(/^第\s*\d+\s*讲\s*[·•:：\-—]?\s*/u, "")
    .replace(/（第\s*\d+(?:\s*[–\-—~至到]\s*\d+)?\s*讲）/gu, "")
    .replace(/\(\s*第\s*\d+(?:\s*[–\-—~至到]\s*\d+)?\s*讲\s*\)/gu, "")
    .trim();
}

/** 从 metadata / 标题解析讲次，如「第 3 讲」 */
export function resourceLectureLabel(resource: LinkedKnowledgeResource): string {
  const meta = resource.metadata || {};
  const lid = String(meta.lesson_id ?? meta.lecture_id ?? "").trim();
  if (/^\d+$/.test(lid)) return `第 ${lid} 讲`;
  const fromTitle = String(resource.title || "").match(/第\s*(\d+)\s*讲/);
  if (fromTitle) return `第 ${fromTitle[1]} 讲`;
  // video_id 0-based → 讲次
  const vid = String(meta.video_id ?? "").trim();
  if (/^\d+$/.test(vid)) return `第 ${Number(vid) + 1} 讲`;
  return "";
}

export function resourceMeta(resource: LinkedKnowledgeResource): string {
  if (resource.resource_type === "video") {
    return "片段相关知识";
  }
  if (resource.resource_type === "exercise") {
    const questionType = String(resource.metadata?.question_type || "").toLowerCase();
    return questionType === "judge"
      ? "判断题"
      : questionType === "choice"
        ? "选择题"
        : "练习题";
  }
  return RESOURCE_LABELS[resource.resource_type];
}

function truncateText(text: string, maxChars: number): string {
  const s = String(text || "").trim();
  if (!s || s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** 片段内与实体相关的知识摘要（summary / asr / text） */
export function videoKnowledgeSnippet(resource: LinkedKnowledgeResource): string {
  const meta = resource.metadata || {};
  const raw = [
    resource.content,
    meta.summary,
    meta.asr_text,
    meta.text,
  ]
    .map((value) => stripLectureHeading(String(value || "").trim()))
    .find(Boolean);
  return raw || "";
}

export function resourceTitle(
  resource: LinkedKnowledgeResource,
  fallback: string,
): string {
  if (resource.resource_type === "video") {
    const lec = resourceLectureLabel(resource);
    const time = `${resourceTime(resource.start_sec)}–${resourceTime(resource.end_sec)}`;
    // 标题：课次 + 时间，方便扫读；知识摘要放到 detail
    if (lec) return `${lec} · ${time}`;
    return time !== "--:----:--" ? time : fallback;
  }
  return stripLectureHeading(String(resource.title || "").trim()) || fallback;
}

export function resourceDetail(
  resource: LinkedKnowledgeResource,
  nodeLabel: string,
): string {
  if (resource.resource_type === "exercise") {
    const label = nodeLabel ? `「${nodeLabel}」` : "该实体";
    return `按掌握与进度推荐 · ${label}`;
  }
  if (resource.resource_type === "video") {
    const snippet = videoKnowledgeSnippet(resource);
    if (!snippet) {
      return nodeLabel ? `与「${nodeLabel}」相关的课堂片段` : "课堂视频片段";
    }
    return truncateText(snippet, 120);
  }
  return stripLectureHeading(String(resource.content || "").trim());
}

export function videoSegmentKey(resource: LinkedKnowledgeResource): string {
  const videoId = String(
    resource.metadata?.video_id ?? resource.resource_id ?? "",
  ).trim();
  const start =
    resource.start_sec != null && Number.isFinite(Number(resource.start_sec))
      ? String(Number(resource.start_sec))
      : "";
  const end =
    resource.end_sec != null && Number.isFinite(Number(resource.end_sec))
      ? String(Number(resource.end_sec))
      : "";
  if (videoId || start || end) return `${videoId}|${start}|${end}`;
  return String(resource.resource_id || "");
}

type ResourceKind = "video" | "exercise" | "animation";

/** 右栏一键跳转：练习 / 视频（及可选动画；图谱实体侧默认不展动画 chip） */
export function LinkedResourceJumpBar({
  loading,
  resources,
  selectedNodeId,
  selectedEdgeId,
  courseId,
  resourceCourseId,
  onOpen,
  showAnimation = false,
  className,
}: {
  loading?: boolean;
  resources: LinkedKnowledgeResource[];
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  courseId: string;
  resourceCourseId?: string;
  onOpen: (resource: LinkedKnowledgeResource) => void;
  showAnimation?: boolean;
  className?: string;
}) {
  const nodeId = selectedNodeId ? String(selectedNodeId) : "";
  const course = resourceCourseId || courseId;
  const hasExercise = resources.some((r) => r.resource_type === "exercise");
  const hasVideo = resources.some((r) => r.resource_type === "video");
  const hasAnimation = resources.some((r) => r.resource_type === "animation");

  /** 视频仍允许按节点 fallback；练习必须题库已匹配到题，否则禁止跳转 */
  const openVideoOrFallback = () => {
    const row = resources.find((r) => r.resource_type === "video");
    if (row) {
      onOpen(row);
      return;
    }
    if (!nodeId) return;
    onOpen({
      resource_type: "video",
      resource_id: "kp-fallback",
      course_id: course,
      title: "相关视频",
      metadata: {
        knowledge_point_id: nodeId,
        seed_knowledge_point_id: nodeId,
        kp: nodeId,
        course_id: course,
      },
    });
  };

  return (
    <div className={`${styles.sideJumpBar} ${className || ""}`}>
      <button
        type="button"
        className={styles.kgChip}
        disabled={!!loading || !hasExercise}
        title={
          loading
            ? "正在匹配练习…"
            : !hasExercise
              ? "题库暂无对应练习"
              : selectedEdgeId
                ? "关系相关练习"
                : "相关练习"
        }
        onClick={() => {
          const row = resources.find((r) => r.resource_type === "exercise");
          if (row) onOpen(row);
        }}
      >
        {loading ? "匹配练习…" : hasExercise ? "相关练习" : "暂无对应练习"}
      </button>
      <button
        type="button"
        className={styles.kgChip}
        disabled={!!loading || (!hasVideo && !nodeId)}
        title={
          loading
            ? "正在匹配视频…"
            : selectedEdgeId
              ? "关系共现视频"
              : "相关视频"
        }
        onClick={openVideoOrFallback}
      >
        {loading ? "匹配视频…" : "相关视频"}
      </button>
      {showAnimation ? (
        <button
          type="button"
          className={styles.kgChip}
          disabled={!!loading || !hasAnimation}
          title="相关动画"
          onClick={() => {
            const row = resources.find((r) => r.resource_type === "animation");
            if (row) onOpen(row);
          }}
        >
          {loading ? "匹配动画…" : "相关动画"}
        </button>
      ) : null}
    </div>
  );
}

/** 相关资源内的二级折叠组；标题始终显示去重后的卡片数量。 */
export function ResourceCardFold({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className={styles.resourceFold} open={defaultOpen || undefined}>
      <summary className={styles.resourceFoldSummary}>
        <span>{title}</span>
        <em>{count}</em>
        <i aria-hidden>›</i>
      </summary>
      <div className={styles.resourceFoldBody}>{children}</div>
    </details>
  );
}

export function LinkedResourceCardList({
  resources,
  kind,
  nodeLabel,
  onOpen,
}: {
  resources: LinkedKnowledgeResource[];
  kind: ResourceKind;
  nodeLabel?: string;
  onOpen: (resource: LinkedKnowledgeResource) => void;
}) {
  const label = RESOURCE_LABELS[kind];
  const fallback = RESOURCE_FALLBACK_TITLE[kind];
  const action = RESOURCE_ACTION[kind];
  const kindClass = KIND_CLASS[kind];
  return (
    <div className={styles.sideResourceList}>
      {resources.map((resource) => {
        const detail = resourceDetail(resource, nodeLabel || "");
        return (
          <button
            type="button"
            key={`${kind}:${resource.resource_id}:${videoSegmentKey(resource)}`}
            className={`${styles.resourceCard} ${kindClass}`}
            onClick={() => onOpen(resource)}
          >
            <span className={styles.resourceCardTop}>
              <span className={styles.resourceCardBadge}>{label}</span>
              <em>{resourceMeta(resource)}</em>
            </span>
            <strong className={styles.resourceCardTitle}>
              {resourceTitle(resource, fallback)}
            </strong>
            {detail ? (
              <span className={styles.resourceCardDetail}>{detail}</span>
            ) : null}
            <span className={styles.resourceCardAction}>{action}</span>
          </button>
        );
      })}
    </div>
  );
}

export { RESOURCE_ACTION, RESOURCE_FALLBACK_TITLE, RESOURCE_LABELS };
