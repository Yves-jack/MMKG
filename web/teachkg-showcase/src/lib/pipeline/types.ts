export type PipelineNode = {
  id: string;
  label?: string;
  title?: string;
  kind?: string;
  size?: number;
  importance?: number | null;
  importance_base?: number | null;
  importance_delta?: number | null;
  importance_contributions?: Record<string, number> | null;
  /** 等价合并后的别名（完整实体名） */
  aliases?: string[];
  /** 重要性阈值下本应隐藏、现被临时显示的节点 */
  filtered_by_importance?: boolean;
  /** mmkg enrichment：实体描述（不参与构图） */
  description?: string;
};

export type PipelineEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  title?: string;
  statement?: string;
  description?: string;
  context?: string;
  source?: string;
  relation?: string;
  concrete?: string;
  concrete_relation?: string;
  statement_direction?: string;
  attribute_category?: string;
  subject_ref?: string;
  object_ref?: string;
  correction_action?: "keep" | "drop" | "revise" | "revise_before" | string | null;
  correction_reason?: string;
  correction_reason_detail?: string;
  correction_evidence?: string;
  /** 修正前关系依据（常为教材/输入三元组 context） */
  basis_before?: string;
  /** 课堂修正依据（evidence） */
  basis_after?: string;
  before?: CorrectionSnap | null;
  after?: CorrectionSnap | null;
  changes?: string[];
  compare_text?: string;
  pair_id?: string;
  /** 片段来源 cue_id（主片段） */
  cue_id?: string | null;
  /** 关联的全部 cue_id */
  cue_ids?: string[];
  /** 展示用片段标签，如「片段 3 · 1363s」 */
  cue_label?: string | null;
  /** 边所属讲次（如 "1" / "1+2"） */
  lecture_id?: string | number | null;
  /** 跨段溯源原文，如「第1讲的第3段到第7段」 */
  extract_source?: string | null;
  /** 跨段去重原因（英文键） */
  dedupe_reason?: string | null;
  /** 跨段去重原因（中文） */
  dedupe_reason_zh?: string | null;
};

export type CorrectionSnap = {
  from?: string;
  to?: string;
  label?: string;
  concrete?: string;
  direction?: string;
};

export type TextDiffSpan = {
  kind: "same" | "add" | "change" | string;
  text: string;
};

/** 多讲拼接正文中的分段（大标题区分） */
export type TextSection = {
  heading: string;
  lectureId?: string;
  text?: string;
};

export type PipelineStage = {
  id: string;
  title: string;
  subtitle?: string;
  blurb?: string;
  focus?: string;
  text?: string;
  /** 相邻讲次融合时：分段标题 + 各段正文 */
  text_sections?: TextSection[];
  raw_text?: string;
  corrected_text?: string;
  corrected_spans?: TextDiffSpan[];
  text_compare?: boolean;
  compare_mode?: "asr" | "preprocess" | string;
  nodes?: PipelineNode[];
  edges?: PipelineEdge[];
  stats?: Record<string, number | string | null>;
};

export type PipelineItem = {
  cue_id: string;
  lecture_id?: string;
  start_sec?: number;
  end_sec?: number;
  asr_text?: string;
  raw_asr_text?: string;
  extract_text?: string;
  preprocess_status?: string;
  media?: { clip?: string; ppt?: string };
  stages: PipelineStage[];
  triplets?: unknown[];
  /** 跨段窗口项（片段列表末尾） */
  is_cross_cue?: boolean;
  cross_cue_span?: string;
  start_seg?: number;
  end_seg?: number;
  cross_cue_edges?: PipelineEdge[];
};

export type PipelinePayload = {
  brand?: string;
  product?: string;
  mode: "lecture" | "session";
  course_id: string;
  lecture_id?: string;
  lecture_ids?: string[];
  title: string;
  subtitle?: string;
  cue_count?: number;
  cross_cue_window_count?: number;
  items: PipelineItem[];
};
