import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { PipelineEdge, PipelineStage } from "@/lib/pipeline/types";
import { isBidirectionalRelation } from "@/lib/pipeline/graphLogic";
import { propertyOfToSentence } from "@/lib/kg/lectureKgProcess";
import {
  ABSTRACT_RELATIONS,
  composeCanonicalName,
  splitCanonicalName,
  type EdgeEdit,
  type KgEditPatch,
} from "@/lib/kg/kgEdits";
import { assetKindLabel, assetRoleLabel, assetReviewSeek, findPeerAssets, type AssetCard, type AssetsLibrary, findAssetsForEntity } from "@/lib/kg/assetsLibrary";
import { WatchClassroom } from "@/components/apps/WatchClassroom";
import { useCourseId } from "@/lib/course";
import { LatexText } from "@/components/pipeline/LatexText";
import styles from "@/pages/PipelinePage.module.css";

function Tex({
  text,
  block = false,
}: {
  text: string;
  /** 长描述用块级，便于多行与公式换行 */
  block?: boolean;
}) {
  return <LatexText text={text} as={block ? "div" : "span"} compact />;
}

function shortName(v?: string | null) {
  return (v || "").split("/")[0] || "?";
}

function enName(v?: string | null) {
  const parts = (v || "").split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : "";
}

/** 边箭头始终跟 SPO（主→客） */
function snapLine(
  snap?: {
    from?: string;
    to?: string;
    label?: string;
    concrete?: string;
    direction?: string;
  } | null
) {
  if (!snap) return "—";
  const mid = snap.label ? `${snap.label}${snap.concrete ? `·` : ""}` : "?";
  const midNode = (
    <>
      {mid}
      {snap.concrete ? <Tex text={snap.concrete} /> : null}
    </>
  );
  const sub = <Tex text={shortName(snap.from)} />;
  const obj = <Tex text={shortName(snap.to)} />;
  const pred = (snap.label || "").trim();
  const dir = (snap.direction || "").trim() || "subject_to_object";
  if (isBidirectionalRelation(pred) || dir === "undirected") {
    return (
      <>
        {sub} —[{midNode}]— {obj}
      </>
    );
  }
  return (
    <>
      {sub} —[{midNode}]→ {obj}
    </>
  );
}

function edgeArrowGlyph(pred: string, statementDirection?: string | null) {
  const dir = (statementDirection || "").trim();
  if (isBidirectionalRelation(pred) || dir === "undirected") {
    return "mid" as const;
  }
  return "to" as const;
}

const KIND_LABEL: Record<string, string> = {
  seed: "种子",
  seed_alias: "种子·别名",
  seed_embedding: "种子·向量",
  seed_filtered_alias: "已筛·别名",
  seed_filtered_embedding: "已筛·向量",
  seed_filtered: "已筛种子",
  textbook: "教材实体",
  delta: "增量实体",
  mixed: "教材+增量",
  new: "课堂新实体",
  final: "融合实体",
  fallback: "回退实体",
  entity: "实体",
};

const SOURCE_LABEL: Record<string, string> = {
  textbook: "教材",
  textbook_revised: "教材·修订后",
  textbook_before: "教材·修订前",
  lecture_delta: "课堂增量",
  kg_completion: "KG补全",
  cross_cue: "跨段衔接",
  process_rule: "规则删边",
  process_node: "节点筛选",
  process_isolated: "孤立边删除",
  llm_fallback: "LLM 回退",
  llm_only: "LLM",
  filtered: "已过滤/删除",
  both: "两讲共有",
};

/** 去掉来源文案中的时间点（如 01:23、12:34–15:00、12.5s） */
function stripTimeHints(s: string): string {
  return String(s || "")
    .replace(
      /\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*[–—\-~至到]\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?\b/g,
      ""
    )
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:s|sec|secs|秒)(?:\s*[–—\-~至到]\s*\d+(?:\.\d+)?\s*(?:s|sec|secs|秒))?\b/gi,
      ""
    )
    .replace(/\(\s*\)/g, "")
    .replace(/\s*[·•|]\s*[·•|]/g, " · ")
    .replace(/^\s*[·•|]\s*|\s*[·•|]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 来源行：抽取类型 · 讲次 · 片段（不含时间点） */
function formatEdgeSource(edge: PipelineEdge): string {
  const parts: string[] = [];
  const src = (edge.source || "").trim();
  const span = stripTimeHints((edge.extract_source || "").trim());
  const lecRaw =
    edge.lecture_id != null && String(edge.lecture_id).trim()
      ? String(edge.lecture_id).trim()
      : "";

  // 跨段边优先展示「第N讲的第a段到第b段」
  if (src === "cross_cue" && span) {
    parts.push(span);
  } else if (src === "filtered" && (span || edge.dedupe_reason_zh || edge.dedupe_reason)) {
    parts.push("去重候选");
    const reason = stripTimeHints((edge.dedupe_reason_zh || edge.dedupe_reason || "").trim());
    if (reason) parts.push(reason);
    if (span) parts.push(span);
  } else if (SOURCE_LABEL[src]) {
    parts.push(SOURCE_LABEL[src]);
  } else if (src && !/^lecture_\d+$/i.test(src)) {
    parts.push(src);
  }

  const fromSrc = src.match(/^lecture_(\d+)$/i);
  let lecLabel = "";
  if (fromSrc) {
    lecLabel = `第 ${fromSrc[1]} 讲`;
  } else if (/^\d+\+\d+$/.test(lecRaw)) {
    lecLabel = `第 ${lecRaw.replace(/\+/g, "–")} 讲`;
  } else if (/^\d+$/.test(lecRaw)) {
    lecLabel = `第 ${lecRaw} 讲`;
  } else if (lecRaw) {
    lecLabel = `讲次 ${lecRaw}`;
  }
  if (lecLabel) parts.push(lecLabel);

  const cueLabel = stripTimeHints((edge.cue_label || "").trim());
  if (cueLabel) {
    // 若标签已含讲次且上面已写讲次，去掉前缀避免重复
    const stripped = lecLabel
      ? cueLabel.replace(new RegExp(`^${lecLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[·•|]\\s*`), "")
      : cueLabel;
    const clean = stripTimeHints(stripped);
    if (clean) parts.push(clean);
  } else if (edge.cue_ids && edge.cue_ids.length > 1) {
    parts.push(`${edge.cue_ids.length} 个片段`);
  }

  return parts.map(stripTimeHints).filter(Boolean).join(" · ") || "—";
}

const ABSTRACT_RELATIONS_LOCAL = ABSTRACT_RELATIONS;

function normalizeAbstractRelation(raw?: string | null): string {
  const p = (raw || "").trim();
  if ((ABSTRACT_RELATIONS_LOCAL as readonly string[]).includes(p)) return p;
  const aliases: Record<string, string> = {
    belongs_to: "belong_to",
    is_a: "belong_to",
    has_part: "part_of",
    depends_on: "depend_on",
    synonym: "synonym_of",
    related: "related_with",
    related_to: "related_with",
  };
  if (aliases[p]) return aliases[p];
  return "related_with";
}

function abstractRelationLabel(raw?: string | null): string {
  return normalizeAbstractRelation(raw);
}

function edgesForStage(
  stage: PipelineStage,
  hideFiltered: boolean,
  mode: string,
  opts?: { includeBeforeGhost?: boolean }
) {
  const isCorrect = stage.id === "correct" || stage.id?.startsWith("correct");
  let edges =
    mode === "session" && stage.id?.startsWith("lecture_") && hideFiltered
      ? (stage.edges || []).filter((e) => e.source !== "filtered")
      : [...(stage.edges || [])];
  if (isCorrect && !opts?.includeBeforeGhost) {
    edges = edges.filter((e) => e.correction_action !== "revise_before");
  }
  if (hideFiltered) {
    edges = edges.filter((e) => e.source !== "filtered");
  }
  return edges;
}

function DetailRows({
  rows,
}: {
  rows: Array<[string, ReactNode] | null | false | undefined>;
}) {
  const list = rows.filter(Boolean) as Array<[string, ReactNode]>;
  const COLLAPSE_KEYS = new Set([
    "描述",
    "关联知识点",  // 兼容旧数据折叠键；展示已移除
    "详细理由",
    "修正依据",
    "修正前依据",
    "原文依据",
    "依据",
    "上下文",
  ]);
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  if (!list.length) return null;

  return (
    <dl className={styles.detailRows}>
      {list.map(([k, v]) => {
        const collapsible = COLLAPSE_KEYS.has(k);
        // 描述、特性默认展开；其余可折叠字段默认收起
        const open = openKeys[k] ?? (k === "特性" || k === "描述");
        return (
          <div key={k} className={styles.detailRow}>
            <dt>
              {collapsible ? (
                <button
                  type="button"
                  className={styles.fieldToggle}
                  aria-expanded={open}
                  onClick={() =>
                    setOpenKeys((prev) => ({ ...prev, [k]: !open }))
                  }
                >
                  <span>{k}</span>
                  <span className={styles.fieldChevron}>{open ? "▾" : "▸"}</span>
                </button>
              ) : (
                k
              )}
            </dt>
            {collapsible && !open ? (
              <dd className={styles.fieldCollapsedHint}>已折叠 · 点击展开</dd>
            ) : (
              <dd>{v}</dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

function findEdgeById(edges: PipelineEdge[], id: string | null) {
  if (!id) return null;
  const sid = String(id);
  return edges.find((e) => String(e.id) === sid) || null;
}

function enrichEdgeFields(edge: PipelineEdge, pool: PipelineEdge[]): PipelineEdge {
  const pick = (...vals: Array<string | null | undefined>) => {
    for (const v of vals) {
      if (v != null && String(v).trim()) return String(v);
    }
    return "";
  };
  const sameSpo = pool.filter(
    (e) =>
      String(e.from) === String(edge.from) &&
      String(e.to) === String(edge.to) &&
      String(e.relation || e.label || "") === String(edge.relation || edge.label || "")
  );
  const twins = sameSpo.length ? sameSpo : pool;
  return {
    ...edge,
    concrete: pick(edge.concrete, edge.concrete_relation, ...twins.map((t) => t.concrete || t.concrete_relation)),
    concrete_relation: pick(
      edge.concrete_relation,
      edge.concrete,
      ...twins.map((t) => t.concrete_relation || t.concrete)
    ),
    statement: pick(edge.statement, ...twins.map((t) => t.statement)),
    description: pick(edge.description, ...twins.map((t) => t.description)),
    context: pick(edge.context, ...twins.map((t) => t.context)),
    correction_reason: pick(edge.correction_reason, ...twins.map((t) => t.correction_reason)),
    correction_reason_detail: pick(
      edge.correction_reason_detail,
      ...twins.map((t) => t.correction_reason_detail)
    ),
    correction_evidence: pick(edge.correction_evidence, ...twins.map((t) => t.correction_evidence)),
    basis_before: pick(edge.basis_before, ...twins.map((t) => t.basis_before)),
    basis_after: pick(edge.basis_after, ...twins.map((t) => t.basis_after)),
    before: edge.before || twins.find((t) => t.before)?.before,
    after: edge.after || twins.find((t) => t.after)?.after,
    changes: edge.changes?.length ? edge.changes : twins.find((t) => t.changes?.length)?.changes,
    compare_text: pick(edge.compare_text, ...twins.map((t) => t.compare_text)),
  };
}

/** 统一解析选中边：修订前幽灵边切到成对修订后边，并补全描述字段 */
function resolveEdgeForDetail(
  stage: PipelineStage,
  selectedEdgeId: string | null
): PipelineEdge | null {
  const all = stage.edges || [];
  let edge = findEdgeById(all, selectedEdgeId);
  if (!edge) return null;
  if (edge.correction_action === "revise_before" && edge.pair_id) {
    const after = findEdgeById(all, edge.pair_id);
    if (after) {
      edge = {
        ...after,
        before: after.before || edge.before,
        after: after.after || edge.after,
        changes: after.changes?.length ? after.changes : edge.changes,
        compare_text: after.compare_text || edge.compare_text,
      };
    }
  }
  return enrichEdgeFields(edge, all);
}

function fmt(v: unknown) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(3);
}

/** 课堂分：缺失显示「未评分」，避免与真·零分混淆 */
function fmtClassroom(v: unknown) {
  if (v == null || Number.isNaN(Number(v))) return "未评分";
  return Number(v).toFixed(3);
}

function fmtDelta(v: unknown) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}

const FUSION_CONTRIB_KEYS = new Set(["pagerank", "classroom_adj", "blend_adjust"]);

const CONTRIB_LABEL: Record<string, string> = {
  prior: "先验",
  mention_time: "提及次数",
  board_ppt: "板书/PPT",
  discourse_role: "话语角色",
  structure_graph: "结构支撑",
  app_feedback: "应用反馈",
  pagerank: "PageRank",
  classroom_adj: "课堂 C′",
  blend_adjust: "修正量",
};

function descriptionFallbackFromEdges(
  related: PipelineEdge[],
  existing?: string | null
): { text: string; fromEdges: boolean } {
  const owned = String(existing || "").trim();
  if (owned) return { text: owned, fromEdges: false };
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const e of related) {
    const candidates = [
      e.description,
      e.context,
      e.statement,
      e.concrete || e.concrete_relation,
    ];
    for (const raw of candidates) {
      const t = String(raw || "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      samples.push(t);
      if (samples.length >= 2) break;
    }
    if (samples.length >= 2) break;
  }
  if (!samples.length) return { text: "", fromEdges: false };
  return { text: samples.join("\n\n"), fromEdges: true };
}

function ContribBars({
  entries,
  scale,
}: {
  entries: Array<[string, number]>;
  scale: "fixed01" | "groupMax";
}) {
  if (!entries.length) return null;
  const maxC =
    scale === "fixed01"
      ? 1
      : Math.max(...entries.map(([, v]) => Math.abs(Number(v) || 0)), 1e-6);
  return (
    <>
      {entries.map(([k, v]) => {
        const num = Number(v);
        const isDelta = k === "blend_adjust";
        const val = isDelta ? num : Math.max(0, num || 0);
        const widthPct = Math.min(100, (Math.abs(num || 0) / maxC) * 100);
        return (
          <div key={k} className={styles.contribRow}>
            <span>{CONTRIB_LABEL[k] || k}</span>
            <div className={styles.contribBarTrack}>
              <div
                className={styles.contribBar}
                style={{
                  width: `${widthPct}%`,
                  ...(isDelta && num < 0
                    ? { background: "rgba(239, 68, 68, 0.65)" }
                    : null),
                }}
              />
            </div>
            <em>{isDelta ? fmtDelta(num) : val.toFixed(3)}</em>
          </div>
        );
      })}
    </>
  );
}

export function SelectionDetail({
  stage,
  selectedNodeId,
  selectedEdgeId,
  hideFiltered = false,
  mode = "lecture",
  /** textbook：仅教材先验；classroom：仅课堂信号；full：教材先验 + 反馈后 + Δ */
  importanceMode = "full",
  editMode = false,
  kgPatch = null,
  editBusy = false,
  onRenameEntity,
  onSaveEdgeEdit,
  onClearEdgeEdit,
  onDeleteEntity,
  onDeleteEdge,
  onRestoreEntity,
  onRestoreEdge,
  permanentDelete = false,
}: {
  stage: PipelineStage;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hideFiltered?: boolean;
  mode?: string;
  importanceMode?: "full" | "textbook" | "classroom";
  editMode?: boolean;
  kgPatch?: KgEditPatch | null;
  editBusy?: boolean;
  onRenameEntity?: (currentId: string, newId: string) => void | Promise<void>;
  onSaveEdgeEdit?: (edgeId: string, edit: EdgeEdit) => void | Promise<void>;
  onClearEdgeEdit?: (edgeId: string) => void | Promise<void>;
  onDeleteEntity?: (currentId: string) => void | Promise<void>;
  onDeleteEdge?: (edgeId: string) => void | Promise<void>;
  onRestoreEntity?: (originalId: string) => void | Promise<void>;
  onRestoreEdge?: (edgeId: string) => void | Promise<void>;
  permanentDelete?: boolean;
}) {
  const edge = resolveEdgeForDetail(stage, selectedEdgeId);
  const stageNode = selectedNodeId
    ? (stage.nodes || []).find((n) => String(n.id) === String(selectedNodeId)) || null
    : null;

  if (edge) {
    const pred = normalizeAbstractRelation(edge.relation || edge.label || "");
    const concrete = (edge.concrete || edge.concrete_relation || "").trim();
    const edgePatch = kgPatch?.edgeEdits?.[String(edge.id || "")] || null;
    return (
      <div className={styles.detailCard}>
        <div className={styles.detailBadge}>关系</div>
        <div className={styles.edgeHeadline}>
          <strong>
            <Tex text={shortName(edge.from)} />
          </strong>
          {edgeArrowGlyph(pred, edge.statement_direction) === "mid" ? (
            <> —[<span>{pred}</span>]— </>
          ) : (
            <> —[{pred}]→ </>
          )}
          <strong>
            <Tex text={shortName(edge.to)} />
          </strong>
        </div>
        {editMode && onSaveEdgeEdit ? (
          <EdgeEditForm
            edge={edge}
            pred={pred}
            edgePatch={edgePatch}
            busy={editBusy}
            onSave={onSaveEdgeEdit}
            onClear={onClearEdgeEdit}
            onDelete={onDeleteEdge}
            permanentDelete={permanentDelete}
          />
        ) : null}
        <DetailRows
          rows={[
            ["抽象关系", abstractRelationLabel(pred)],
            concrete ? ["具体关系", <Tex text={concrete} />] : null,
            edge.source || edge.lecture_id || edge.cue_label || edge.cue_id
              ? ["来源", formatEdgeSource(edge)]
              : null,
            edge.description ? ["描述", <Tex text={edge.description} block />] : null,
            edge.context ? ["课堂依据", <Tex text={edge.context} block />] : null,
          ]}
        />
      </div>
    );
  }

  if (selectedNodeId) {
    const id = String(selectedNodeId);
    const kind = String(stageNode?.kind || "");
    const aliasList = (stageNode?.aliases || [])
      .map((a) => String(a || "").trim())
      .filter((a) => a && a !== id);
    const aliasText = aliasList
      .map((a) => {
        const az = shortName(a);
        const ae = enName(a);
        return ae ? `${az}（${ae}）` : az || a;
      })
      .join("、");
    const related = edgesForStage(stage, hideFiltered, mode).filter(
      (e) => String(e.from) === id || String(e.to) === id
    );
    // 特性：节点已折叠的 properties + 仍挂在图上的 property_of（属性→本实体）
    const propSeen = new Set<string>();
    const propertyLines: string[] = [];
    const pushProp = (line: string) => {
      const t = String(line || "").trim();
      if (!t || propSeen.has(t)) return;
      propSeen.add(t);
      propertyLines.push(t);
    };
    for (const p of stageNode?.properties || []) pushProp(p);
    for (const e of related) {
      const rel = normalizeAbstractRelation(e.relation || e.label || "");
      if (rel !== "property_of") continue;
      if (String(e.to) !== id) continue;
      pushProp(propertyOfToSentence(e));
    }
    const descInfo = descriptionFallbackFromEdges(related, stageNode?.description);
    const fusionOrder = ["pagerank", "classroom_adj", "blend_adjust"];
    const channelOrder = [
      "prior",
      "mention_time",
      "board_ppt",
      "discourse_role",
      "structure_graph",
      "app_feedback",
    ];
    const contribEntries = Object.entries(stageNode?.importance_contributions || {}).filter(
      ([k]) => k !== "boost_gated"
    );
    const fusionEntries = fusionOrder
      .map((k) => contribEntries.find(([ck]) => ck === k))
      .filter((x): x is [string, number] => Boolean(x))
      .map(([k, v]) => [k, Number(v)] as [string, number]);
    const channelEntries = channelOrder
      .map((k) => contribEntries.find(([ck]) => ck === k))
      .filter((x): x is [string, number] => Boolean(x))
      .map(([k, v]) => [k, Number(v)] as [string, number]);
    const otherEntries = contribEntries
      .filter(([k]) => !FUSION_CONTRIB_KEYS.has(k) && !channelOrder.includes(k))
      .map(([k, v]) => [k, Number(v)] as [string, number]);
    return (
      <div className={styles.detailCard}>
        <div className={styles.detailBadge}>
          {stageNode?.filtered_by_importance ? "被筛实体" : "实体"}
        </div>
        {editMode && onRenameEntity ? (
          <EntityRenameForm
            entityId={id}
            busy={editBusy}
            onSave={onRenameEntity}
            onDelete={onDeleteEntity}
            permanentDelete={permanentDelete}
          />
        ) : null}
        <DetailRows
          rows={[
            ["规范名", <Tex text={id} />],
            aliasText ? ["别名", <Tex text={aliasText} />] : null,
            kind ? ["角色", KIND_LABEL[kind] || kind] : null,
            propertyLines.length
              ? [
                  "特性",
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                    {propertyLines.map((p) => (
                      <li key={p} style={{ marginBottom: "0.2rem" }}>
                        <Tex text={p} />
                      </li>
                    ))}
                  </ul>,
                ]
              : null,
            [
              "描述",
              descInfo.text ? (
                <>
                  {descInfo.fromEdges ? (
                    <div className={styles.fieldCollapsedHint} style={{ marginBottom: 4 }}>
                      来自关联关系说明
                    </div>
                  ) : null}
                  <Tex text={descInfo.text} block />
                </>
              ) : (
                "暂无实体释义"
              ),
            ],
            stageNode?.filtered_by_importance
              ? ["筛选", "低于当前重要性阈值（临时显示）"]
              : null,
          ]}
        />
        <div className={styles.metrics}>
          {importanceMode === "textbook" ? (
            <div>
              <span>教材重要性</span>
              {fmt(stageNode?.importance_base ?? stageNode?.importance)}
            </div>
          ) : importanceMode === "classroom" &&
            stageNode?.importance_contributions &&
            (stageNode.importance_contributions.pagerank != null ||
              stageNode.importance_contributions.blend_adjust != null) ? (
            <>
              <div title="PageRank = P">
                <span>PageRank (P)</span>
                {fmt(
                  stageNode.importance_base ??
                    stageNode.importance_contributions.pagerank
                )}
              </div>
              <div
                title={
                  Number(stageNode.importance_contributions.boost_gated) > 0
                    ? "上抬被「提及次数」/「板书/PPT」门控拦截"
                    : "修正量 adjust：课堂相对 PageRank 的修正"
                }
              >
                <span>修正量 (adjust)</span>
                {fmtDelta(
                  stageNode.importance_delta ??
                    stageNode.importance_contributions.blend_adjust
                )}
              </div>
              <div title="最终重要性 I = clip(P + adjust)">
                <span>最终 (I)</span>
                {fmt(stageNode?.importance)}
              </div>
            </>
          ) : importanceMode === "classroom" ? (
            <div title="课堂通道合成分；无记录时显示未评分">
              <span>课堂重要性 (I)</span>
              {fmtClassroom(stageNode?.importance)}
            </div>
          ) : (
            <>
              <div>
                <span>教材先验</span>
                {fmt(stageNode?.importance_base)}
              </div>
              <div>
                <span>反馈后</span>
                {fmt(stageNode?.importance)}
              </div>
              <div>
                <span>Δ</span>
                {fmtDelta(
                  stageNode?.importance_delta ??
                    (stageNode?.importance != null && stageNode?.importance_base != null
                      ? Number(stageNode.importance) - Number(stageNode.importance_base)
                      : null)
                )}
              </div>
            </>
          )}
        </div>
        {importanceMode !== "textbook" &&
          stageNode?.importance_contributions &&
          Object.keys(stageNode.importance_contributions).length > 0 && (
            <div className={styles.contribBlock}>
              <div className={styles.contribTitle}>
                {stageNode.importance_contributions.pagerank != null
                  ? "重要性分解"
                  : "重要性贡献"}
              </div>
              {fusionEntries.length ? (
                <>
                  <div className={styles.contribSubTitle}>融合（0–1）</div>
                  <ContribBars entries={fusionEntries} scale="fixed01" />
                </>
              ) : null}
              {channelEntries.length || otherEntries.length ? (
                <>
                  <div className={styles.contribSubTitle}>课堂通道（组内归一）</div>
                  <ContribBars
                    entries={[...channelEntries, ...otherEntries]}
                    scale="groupMax"
                  />
                </>
              ) : null}
              {Number(stageNode.importance_contributions.boost_gated) > 0 ? (
                <div className={styles.contribRow}>
                  <span>门控</span>
                  <em>上抬已拦截</em>
                </div>
              ) : null}
            </div>
          )}
      </div>
    );
  }

  if (selectedEdgeId) {
    return (
      <div className={styles.sideEmpty}>
        已选中关系 <code>{selectedEdgeId}</code>，但当前步骤数据中未找到对应边
      </div>
    );
  }

  return <div className={styles.sideEmpty}>点击图中实体或关系，查看描述与依据</div>;
}

function EntityRenameForm({
  entityId,
  busy,
  onSave,
  onDelete,
  permanentDelete,
}: {
  entityId: string;
  busy?: boolean;
  onSave: (currentId: string, newId: string) => void | Promise<void>;
  onDelete?: (currentId: string) => void | Promise<void>;
  permanentDelete?: boolean;
}) {
  const initial = splitCanonicalName(entityId);
  const [zh, setZh] = useState(initial.zh);
  const [en, setEn] = useState(initial.en);
  useEffect(() => {
    const next = splitCanonicalName(entityId);
    setZh(next.zh);
    setEn(next.en);
  }, [entityId]);
  const canonical = composeCanonicalName(zh, en);
  const dirty = Boolean(canonical) && canonical !== entityId;
  return (
    <div className={styles.kgEditBox}>
      <label className={styles.kgEditLabel}>修改实体名称</label>
      <label className={styles.kgEditFieldLabel}>中文名</label>
      <input
        className={styles.kgEditInput}
        value={zh}
        disabled={busy}
        onChange={(e) => setZh(e.target.value)}
        placeholder="如 命题逻辑"
      />
      <label className={styles.kgEditFieldLabel}>英文名</label>
      <input
        className={styles.kgEditInput}
        value={en}
        disabled={busy}
        onChange={(e) => setEn(e.target.value)}
        placeholder="如 propositional logic"
      />
      <div className={styles.kgEditPreview}>
        <span>规范名</span>
        <code>{canonical || "—"}</code>
      </div>
      <div className={styles.kgEditActions}>
        <button
          type="button"
          className={styles.kgEditBtn}
          disabled={busy || !dirty}
          onClick={() => void onSave(entityId, canonical)}
        >
          保存名称
        </button>
        {onDelete ? (
          <button
            type="button"
            className={styles.kgEditBtnDanger}
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `删除实体「${shortName(entityId)}」？其关联关系也会一并移除${permanentDelete ? "，且此操作不可撤销" : "（可撤销）"}。`
                )
              ) {
                void onDelete(entityId);
              }
            }}
          >
            删除实体
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EdgeEditForm({
  edge,
  pred,
  edgePatch,
  busy,
  onSave,
  onClear,
  onDelete,
  permanentDelete,
}: {
  edge: PipelineEdge;
  pred: string;
  edgePatch: EdgeEdit | null;
  busy?: boolean;
  onSave: (edgeId: string, edit: EdgeEdit) => void | Promise<void>;
  onClear?: (edgeId: string) => void | Promise<void>;
  onDelete?: (edgeId: string) => void | Promise<void>;
  permanentDelete?: boolean;
}) {
  const edgeId = String(edge.id || "");
  const [rel, setRel] = useState(pred);
  useEffect(() => {
    setRel(pred);
  }, [pred, edgeId]);

  const reversed = Boolean(edgePatch?.reversed);
  const hasPatch = Boolean(edgePatch);

  return (
    <div className={styles.kgEditBox}>
      <label className={styles.kgEditLabel}>修改关系</label>
      <select
        className={styles.kgEditInput}
        value={rel}
        disabled={busy}
        onChange={(e) => setRel(e.target.value)}
      >
        {ABSTRACT_RELATIONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <div className={styles.kgEditActions}>
        <button
          type="button"
          className={styles.kgEditBtn}
          disabled={busy || rel === pred}
          onClick={() =>
            void onSave(edgeId, {
              ...(edgePatch || {}),
              relation: rel,
              label: rel,
            })
          }
        >
          保存类型
        </button>
        <button
          type="button"
          className={styles.kgEditBtn}
          disabled={busy}
          onClick={() =>
            void onSave(edgeId, {
              ...(edgePatch || {}),
              relation: edgePatch?.relation || pred,
              label: edgePatch?.label || edgePatch?.relation || pred,
              reversed: !reversed,
            })
          }
        >
          {reversed ? "恢复方向" : "对调方向"}
        </button>
        {hasPatch && onClear ? (
          <button
            type="button"
            className={styles.kgEditBtnGhost}
            disabled={busy}
            onClick={() => void onClear(edgeId)}
          >
            撤销本边编辑
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className={styles.kgEditBtnDanger}
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `删除关系「${shortName(edge.from)} —[${pred}]→ ${shortName(edge.to)}」？${permanentDelete ? "此操作不可撤销。" : "（可撤销）"}`
                )
              ) {
                void onDelete(edgeId);
              }
            }}
          >
            删除关系
          </button>
        ) : null}
      </div>
      {reversed ? (
        <small className={styles.kgEditHint}>当前相对原始边已对调主客</small>
      ) : null}
    </div>
  );
}

function pptFileLabel(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const pathOnly = decodeURIComponent(raw.split("?")[0] || "");
    const name = pathOnly.split("/").filter(Boolean).pop() || raw;
    return name.length > 28 ? `${name.slice(0, 28)}…` : name;
  } catch {
    return raw.length > 28 ? `${raw.slice(0, 28)}…` : raw;
  }
}

function DeletedItemsPanel({
  kgPatch,
  busy,
  onRestoreEntity,
  onRestoreEdge,
  onRestorePpt,
}: {
  kgPatch?: KgEditPatch | null;
  busy?: boolean;
  onRestoreEntity?: (originalId: string) => void | Promise<void>;
  onRestoreEdge?: (edgeId: string) => void | Promise<void>;
  onRestorePpt?: (url: string) => void | Promise<void>;
}) {
  const ents = Object.keys(kgPatch?.deletedEntities || {});
  const edges = Object.keys(kgPatch?.deletedEdges || {});
  const ppts = Object.keys(kgPatch?.deletedPptUrls || {});
  if (!ents.length && !edges.length && !ppts.length) return null;
  return (
    <div className={styles.kgEditBox} style={{ marginTop: 10 }}>
      <label className={styles.kgEditLabel}>已删除（可恢复）</label>
      {ents.map((id) => (
        <div key={`e-${id}`} className={styles.kgDeletedRow}>
          <code title={id}>{shortName(id)}</code>
          <button
            type="button"
            className={styles.kgEditBtnGhost}
            disabled={busy || !onRestoreEntity}
            onClick={() => void onRestoreEntity?.(id)}
          >
            恢复实体
          </button>
        </div>
      ))}
      {edges.map((id) => (
        <div key={`r-${id}`} className={styles.kgDeletedRow}>
          <code title={id}>{id.length > 28 ? `${id.slice(0, 28)}…` : id}</code>
          <button
            type="button"
            className={styles.kgEditBtnGhost}
            disabled={busy || !onRestoreEdge}
            onClick={() => void onRestoreEdge?.(id)}
          >
            恢复关系
          </button>
        </div>
      ))}
      {ppts.map((url) => (
        <div key={`p-${url}`} className={styles.kgDeletedRow}>
          <code title={url}>{pptFileLabel(url)}</code>
          <button
            type="button"
            className={styles.kgEditBtnGhost}
            disabled={busy || !onRestorePpt}
            onClick={() => void onRestorePpt?.(url)}
          >
            恢复截图
          </button>
        </div>
      ))}
    </div>
  );
}

export { DeletedItemsPanel };

function EdgeListItem({
  edge: e,
  active,
  onSelect,
  showCompare,
}: {
  edge: PipelineEdge;
  active: boolean;
  onSelect: (id: string | null) => void;
  showCompare?: boolean;
}) {
  const action = e.correction_action || "";
  const pred = e.relation || e.label || "";
  return (
    <button
      type="button"
      className={`${styles.trip} ${active ? styles.tripOn : ""}`}
      onClick={() => onSelect(e.id)}
    >
      {showCompare && action === "revise" ? (
        <div className={styles.tripCompare}>
          <div className={styles.tripBefore}>
            <span className={styles.tripTag}>前</span>
            {snapLine(e.before)}
          </div>
          <div className={styles.tripAfter}>
            <span className={styles.tripTagAfter}>后</span>
            {snapLine(e.after || { from: e.from, to: e.to, label: e.label, concrete: e.concrete })}
          </div>
          {e.changes?.length ? (
            <small className={styles.tripChanges}>变化：{e.changes.join("、")}</small>
          ) : null}
        </div>
      ) : showCompare && action === "drop" ? (
        <div className={styles.tripCompare}>
          <div className={styles.tripBefore}>
            <span className={styles.tripTag}>删</span>
            {snapLine(e.before || { from: e.from, to: e.to, label: e.label, concrete: e.concrete })}
          </div>
        </div>
      ) : (
        <div>
          <strong>
            <Tex text={shortName(e.from)} />
          </strong>{" "}
          {edgeArrowGlyph(pred, e.statement_direction) === "mid" ? (
            <>—[<span>{e.label}</span>]—</>
          ) : (
            <>—[{e.label}]→</>
          )}{" "}
          <strong>
            <Tex text={shortName(e.to)} />
          </strong>
        </div>
      )}
    </button>
  );
}

export function relatedEdgesOf(
  stage: PipelineStage,
  nodeId: string,
  opts?: { hideFiltered?: boolean; mode?: string }
): PipelineEdge[] {
  const hideFiltered = opts?.hideFiltered ?? false;
  const mode = opts?.mode ?? "lecture";
  return edgesForStage(stage, hideFiltered, mode).filter(
    (e) => String(e.from) === String(nodeId) || String(e.to) === String(nodeId)
  );
}

export function RelatedEdges({
  stage,
  nodeId,
  selectedEdgeId,
  hideFiltered = false,
  mode = "lecture",
  onSelect,
}: {
  stage: PipelineStage;
  nodeId: string;
  selectedEdgeId: string | null;
  hideFiltered?: boolean;
  mode?: string;
  onSelect: (id: string | null) => void;
}) {
  const edges = relatedEdgesOf(stage, nodeId, { hideFiltered, mode });
  if (!edges.length) {
    return <div className={styles.sideEmpty}>该实体在本步暂无关联边</div>;
  }
  return (
    <div className={styles.tripList}>
      {edges.map((e) => (
        <EdgeListItem
          key={e.id}
          edge={e}
          active={selectedEdgeId === e.id}
          onSelect={onSelect}
          showCompare={
            (stage.id === "correct" || stage.id?.startsWith("correct")) &&
            (e.correction_action === "revise" || e.correction_action === "drop")
          }
        />
      ))}
    </div>
  );
}

function AssetCardItem({
  card,
  lectureId,
  library = null,
  lectureOnly = false,
}: {
  card: AssetCard;
  lectureId?: string | null;
  library?: AssetsLibrary | null;
  lectureOnly?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const courseId = useCourseId() || "";
  const seek = assetReviewSeek(card, lectureId);
  const peers = useMemo(
    () =>
      findPeerAssets(library, card, {
        lectureId,
        lectureOnly,
        maxItems: 6,
      }),
    [library, card, lectureId, lectureOnly]
  );
  const zh = shortName(card.name);
  const en = enName(card.name);
  const statement = (card.statement || "").trim();
  const summary = (card.summary || "").trim();
  const latex = (card.latex || "").trim();
  const detail = statement || summary;
  const showLatex = Boolean(latex) && !detail.includes(latex);
  const steps = (card.steps || []).map((s) => String(s || "").trim()).filter(Boolean);
  const concepts = card.concepts || [];
  const hasRelated = concepts.length > 0 || peers.length > 0;
  const hasBody = Boolean(detail || showLatex || steps.length || hasRelated);

  return (
    <div className={styles.assetCard}>
      <div className={styles.assetHeadRow}>
        <button
          type="button"
          className={styles.assetHead}
          aria-expanded={hasBody ? open : undefined}
          onClick={() => hasBody && setOpen((v) => !v)}
        >
          <span className={styles.assetKind}>{assetKindLabel(card.kind)}</span>
          <strong className={styles.assetTitle}>
            <Tex text={zh} />
          </strong>
          {en ? <span className={styles.assetEn}>{en}</span> : null}
          {hasBody ? (
            <span className={styles.assetChev} aria-hidden>
              {open ? "▾" : "▸"}
            </span>
          ) : null}
        </button>
        {seek ? (
          <WatchClassroom
            courseId={courseId}
            lectureId={seek.lectureId}
            startSec={seek.startSec}
            entityId={seek.entityId}
          />
        ) : null}
      </div>
      {open && hasBody ? (
        <div className={styles.assetBody}>
          {detail || showLatex ? (
            <div className={styles.assetField}>
              <span className={styles.assetFieldLabel}>详细描述</span>
              {detail ? (
                <div className={styles.assetStatement}>
                  <Tex text={detail} block />
                </div>
              ) : null}
              {showLatex ? (
                <div className={styles.assetStatement}>
                  <Tex text={`$${latex}$`} block />
                </div>
              ) : null}
            </div>
          ) : null}
          {steps.length ? (
            <div className={styles.assetField}>
              <span className={styles.assetFieldLabel}>步骤</span>
              <ol className={styles.assetSteps}>
                {steps.map((s, i) => (
                  <li key={i}>
                    <Tex text={s} />
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {hasRelated ? (
            <div className={styles.assetField}>
              <span className={styles.assetFieldLabel}>相关</span>
              <div className={styles.assetConcepts}>
                {concepts.map((c, i) => (
                  <span key={`${c.entity}-${i}`} className={styles.assetConceptChip}>
                    {assetRoleLabel(c.role)} ·{" "}
                    <Tex text={shortName(c.entity)} />
                  </span>
                ))}
                {peers.map((p) => (
                  <span key={p.asset_id} className={styles.assetPeerChip}>
                    {assetKindLabel(p.kind)} · <Tex text={shortName(p.name)} />
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 选中概念时展示关联的资源层卡片（公式 / 例子 / 定理·原理·方法） */
export function RelatedAssetsPanel({
  entityId,
  library,
  lectureId = null,
  lectureOnly = false,
  maxItems = 12,
  hideEmpty = false,
}: {
  entityId: string | null;
  library: AssetsLibrary | null;
  lectureId?: string | null;
  /** 讲次课堂 KG：只显示本讲抽取，避免精选种子盖住新结果 */
  lectureOnly?: boolean;
  maxItems?: number;
  hideEmpty?: boolean;
}) {
  const cards = useMemo(
    () =>
      entityId
        ? findAssetsForEntity(library, entityId, {
            lectureId,
            lectureOnly,
            llmPrinciplesOnly: true,
          })
        : [],
    [entityId, library, lectureId, lectureOnly]
  );
  if (!entityId) {
    if (hideEmpty) return null;
    return <div className={styles.sideEmpty}>选中实体后显示相关公式、例子与定理</div>;
  }
  if (!library) {
    if (hideEmpty) return null;
    return <div className={styles.sideEmpty}>资产库未加载</div>;
  }
  if (!cards.length) {
    if (hideEmpty) return null;
    return (
      <div className={styles.sideEmpty}>
        {lectureOnly
          ? "本讲暂无挂到该实体的公式 / 例子 / 定理"
          : "暂无关联的公式、例子或定理·原理·方法"}
      </div>
    );
  }
  const shown = cards.slice(0, maxItems);
  const rest = cards.length - shown.length;
  return (
    <div className={styles.assetList}>
      {shown.map((c) => (
        <AssetCardItem
          key={c.asset_id}
          card={c}
          lectureId={lectureId}
          library={library}
          lectureOnly={lectureOnly}
        />
      ))}
      {rest > 0 ? (
        <div className={styles.assetMore}>另有 {rest} 条未展开</div>
      ) : null}
    </div>
  );
}
