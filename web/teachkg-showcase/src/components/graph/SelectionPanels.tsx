import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { PipelineEdge, PipelineStage } from "@/lib/graph/types";
import { isBidirectionalRelation } from "@/lib/graph/graphLogic";
import { propertyOfToSentence } from "@/lib/kg/lectureKgProcess";
import {
  ABSTRACT_RELATIONS,
  composeCanonicalName,
  splitCanonicalName,
  type EdgeEdit,
  type KgEditPatch,
} from "@/lib/kg/kgEdits";
import { assetKindLabel, type AssetCard, type AssetsLibrary, findAssetsForEntity } from "@/lib/kg/assetsLibrary";
import { LatexText } from "@/components/graph/LatexText";
import { ResourceCardFold } from "@/components/graph/LinkedResourceCards";
import styles from "@/styles/panels.module.css";

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
    "说明",
    "特性",
    "关联知识点",  // 兼容旧数据折叠键；展示已移除
    "详细理由",
    "修正依据",
    "修正前依据",
    "原文依据",
    "课堂依据",
    "依据",
    "上下文",
  ]);
  const DEFAULT_OPEN = new Set(["描述", "说明", "课堂依据", "依据"]);
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  if (!list.length) return null;

  return (
    <dl className={styles.detailRows}>
      {list.map(([k, v]) => {
        const collapsible = COLLAPSE_KEYS.has(k);
        // 描述、特性默认展开；其余可折叠字段默认收起
        const open = openKeys[k] ?? DEFAULT_OPEN.has(k);
        return (
          <div
            key={k}
            className={`${styles.detailRow} ${
              collapsible ? styles.detailRowCollapsible : ""
            } ${collapsible && open ? styles.detailRowOpen : ""}`.trim()}
          >
            <dt className={collapsible ? styles.detailRowSticky : undefined}>
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

function tidyDetailText(raw?: string | null): string {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/^(增量[·•.\s]*)+/gm, "")
    .replace(/增量[·•]\s*/g, "")
    .replace(/^[ \t]*第\s*\d+\s*讲[的：:.\s]*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function looksLikeImportanceBlurb(raw?: string | null): boolean {
  const t = String(raw || "");
  return /反馈后\s*:|重要性筛选|课堂重要性|PageRank|教材先验|importance/i.test(t);
}

function lookupEntityDefinition(
  id: string,
  aliases: string[],
  defs?: Record<string, string> | null
): string {
  if (!defs) return "";
  const keys = [
    id,
    id.split("/")[0],
    id.split("/").slice(1).join("/"),
    ...aliases,
    ...aliases.map((a) => a.split("/")[0]),
    ...aliases.map((a) => a.split("/").slice(1).join("/")),
  ];
  for (const raw of keys) {
    const k = String(raw || "").trim();
    if (!k) continue;
    const hit = defs[k] || defs[k.toLowerCase()];
    if (hit && !looksLikeImportanceBlurb(hit)) return tidyDetailText(hit);
  }
  return "";
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
  entityDefinitions = null,
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
  /** 教材实体定义（定义语句，不含重要性分数） */
  entityDefinitions?: Record<string, string> | null;
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
            ["关系", abstractRelationLabel(pred)],
            concrete ? ["含义", <Tex text={tidyDetailText(concrete)} />] : null,
            tidyDetailText(edge.description)
              ? ["描述", <Tex text={tidyDetailText(edge.description)} block />]
              : null,
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
      .map((a) => shortName(a) || a)
      .filter(Boolean)
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
    const fromLabel = splitCanonicalName(String(stageNode?.label || "").trim());
    const fromId = splitCanonicalName(id);
    const zh = fromLabel.zh || fromId.zh || shortName(id);
    const en = fromLabel.en || fromId.en;
    const canonicalName = en ? `${zh}/${en}` : zh;
    const ownedDesc = tidyDetailText(stageNode?.description);
    const defDesc = lookupEntityDefinition(id, aliasList, entityDefinitions);
    const descText =
      (ownedDesc && !looksLikeImportanceBlurb(ownedDesc) ? ownedDesc : "") ||
      defDesc;
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
          key={id}
          rows={[
            ["名称", <Tex text={canonicalName} />],
            aliasText ? ["别名", <Tex text={aliasText} />] : null,
            kind && kind !== "entity" ? ["角色", KIND_LABEL[kind] || kind] : null,
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
              descText ? (
                <Tex text={descText} block />
              ) : (
                "词条库暂无该实体定义"
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
          ) : importanceMode === "classroom" ? (
            <div title="课堂通道合成分；无记录时显示未评分">
              <span>课堂重要性</span>
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
        {importanceMode === "full" &&
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

  return <div className={styles.sideEmpty}>点击图中实体或关系查看详情</div>;
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
  onContext,
  showCompare,
}: {
  edge: PipelineEdge;
  active: boolean;
  onSelect: (id: string | null) => void;
  onContext?: (point: { clientX: number; clientY: number }) => void;
  showCompare?: boolean;
}) {
  const action = e.correction_action || "";
  const pred = e.relation || e.label || "";
  return (
    <button
      type="button"
      className={`${styles.trip} ${active ? styles.tripOn : ""}`}
      onClick={() => onSelect(e.id)}
      onContextMenu={(event) => {
        if (!onContext) return;
        event.preventDefault();
        onContext({ clientX: event.clientX, clientY: event.clientY });
      }}
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
  onContextEdge,
}: {
  stage: PipelineStage;
  nodeId: string;
  selectedEdgeId: string | null;
  hideFiltered?: boolean;
  mode?: string;
  onSelect: (id: string | null) => void;
  onContextEdge?: (
    id: string,
    edge: PipelineEdge,
    point: { clientX: number; clientY: number },
  ) => void;
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
          onContext={
            onContextEdge
              ? (point) => onContextEdge(String(e.id), e, point)
              : undefined
          }
          showCompare={
            (stage.id === "correct" || stage.id?.startsWith("correct")) &&
            (e.correction_action === "revise" || e.correction_action === "drop")
          }
        />
      ))}
    </div>
  );
}

const ASSET_KIND_CHIPS: Array<{ key: string; label: string; color: string }> = [
  { key: "formula", label: "公式", color: "#60a5fa" },
  { key: "example", label: "例子", color: "#fbbf24" },
  { key: "theorem", label: "定理", color: "#c084fc" },
  { key: "principle", label: "原理", color: "#2dd4bf" },
  { key: "technique", label: "方法", color: "#fb7185" },
];

const ASSET_KIND_COLOR: Record<string, string> = Object.fromEntries(
  ASSET_KIND_CHIPS.map((c) => [c.key, c.color]),
);

function kindBadgeStyle(kind?: string): CSSProperties | undefined {
  const color = ASSET_KIND_COLOR[String(kind || "")];
  if (!color) return undefined;
  return {
    ["--hl" as string]: color,
    color,
    borderColor: color,
    background: `color-mix(in srgb, ${color} 18%, transparent)`,
  };
}

/** 侧栏相关资源卡：对齐资源库列表卡；方法卡含可折叠步骤 */
function AssetCardItem({ card }: { card: AssetCard }) {
  const kind = String(card.kind || "");
  const zh = shortName(card.name);
  const summary = (card.summary || "").trim();
  const statement = (card.statement || "").trim();
  const body = summary || statement;
  const latex = (card.latex || "").trim();
  const showLatex =
    kind === "formula" && Boolean(latex) && !(body && body.includes(latex));
  const steps = (card.steps || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const showSteps = kind === "technique" && steps.length > 0;
  const [stepsOpen, setStepsOpen] = useState(false);
  const concepts = card.concepts || [];
  const techniqueColor = ASSET_KIND_COLOR.technique;

  return (
    <div className={styles.assetCard}>
      <div className={styles.assetHead}>
        <span className={styles.assetKind} style={kindBadgeStyle(kind)}>
          {assetKindLabel(card.kind)}
        </span>
        <strong className={styles.assetTitle}>
          <Tex text={zh} />
        </strong>
      </div>
      {body ? (
        <div className={styles.assetSummary}>
          <Tex text={body} block />
        </div>
      ) : null}
      {showLatex ? (
        <div className={styles.assetLatex}>
          <Tex text={`$${latex}$`} block />
        </div>
      ) : null}
      {showSteps ? (
        <div
          className={styles.assetStepsBox}
          style={{
            ["--hl" as string]: techniqueColor,
            borderColor: `color-mix(in srgb, ${techniqueColor} 45%, transparent)`,
            background: `color-mix(in srgb, ${techniqueColor} 12%, transparent)`,
          }}
        >
          <button
            type="button"
            className={styles.assetStepsToggle}
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen((v) => !v)}
            style={{ color: techniqueColor }}
          >
            <span>步骤 · {steps.length}</span>
            <span aria-hidden>{stepsOpen ? "▾" : "▸"}</span>
          </button>
          {stepsOpen ? (
            <ol className={styles.assetSteps}>
              {steps.map((s, i) => (
                <li key={i}>
                  <Tex text={s} />
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      {concepts.length ? (
        <div className={styles.assetConcepts}>
          {concepts.map((c, i) => (
            <span key={`${c.entity}-${i}`} className={styles.assetConceptChip}>
              {shortName(c.entity)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 选中概念时展示关联的资源层卡片（公式 / 例子 / 定理·原理·方法） */
export function RelatedAssetsPanel({
  entityId,
  entityAliases = [],
  library,
  lectureId = null,
  lectureOnly = false,
  kinds = null,
  hideEmpty = false,
  matchMode = "full",
  emptyHint = null,
}: {
  entityId: string | null;
  /** 同一图节点的显示名等别名；嵌入图常用内部 id，资产索引使用课程实体名。 */
  entityAliases?: string[];
  library: AssetsLibrary | null;
  lectureId?: string | null;
  /** 讲次课堂 KG：只显示本讲抽取，避免精选种子盖住新结果 */
  lectureOnly?: boolean;
  /** 仅展示指定资产类型；公式嵌入使用 ["formula"]。 */
  kinds?: string[] | null;
  /** @deprecated 始终展示全部资产，忽略截断 */
  maxItems?: number;
  hideEmpty?: boolean;
  /** full=含卡名；concept=概念/边（导图叶）；strict=仅索引（导图 topic） */
  matchMode?: "full" | "concept" | "strict";
  /** 无结果时覆盖默认空态文案（如章节不匹配） */
  emptyHint?: string | null;
}) {
  const aliasKey = entityAliases.join("\u0000");
  const kindKey = kinds?.join("\u0000") || "";
  const cards = useMemo(() => {
    const ids = [entityId, ...entityAliases]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const seen = new Set<string>();
    return ids.flatMap((id) =>
      findAssetsForEntity(library, id, {
        lectureId,
        lectureOnly,
        llmPrinciplesOnly: true,
        kinds,
        matchMode,
      }).filter((card) => {
        if (seen.has(card.asset_id)) return false;
        seen.add(card.asset_id);
        return true;
      })
    );
  }, [entityId, aliasKey, library, lectureId, lectureOnly, kindKey, matchMode]);
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const card of cards) {
      const k = String(card.kind || "");
      if (!k) continue;
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }, [cards]);
  const chips = ASSET_KIND_CHIPS.filter((chip) => {
    if (kinds?.length && !kinds.includes(chip.key)) return false;
    return (kindCounts[chip.key] || 0) > 0;
  });
  if (!entityId) {
    if (hideEmpty) return null;
    return (
      <div className={styles.sideEmpty}>
        {emptyHint || "选中实体后显示相关公式、例子与定理"}
      </div>
    );
  }
  if (!library) {
    if (hideEmpty) return null;
    return (
      <div className={styles.sideEmpty}>{emptyHint || "资产库未加载"}</div>
    );
  }
  if (!cards.length) {
    if (hideEmpty) return null;
    const onlyFormula = kinds?.length === 1 && kinds[0] === "formula";
    return (
      <div className={styles.sideEmpty}>
        {emptyHint
          ? emptyHint
          : onlyFormula
          ? "该知识节点暂无 MMKG 关联公式"
          : lectureOnly
          ? "本讲暂无挂到该实体的公式 / 例子 / 定理"
          : matchMode === "strict"
          ? "该主题仅精确匹配到资源；暂无同名挂载"
          : "暂无关联的公式、例子或定理·原理·方法"}
      </div>
    );
  }
  return (
    <div className={styles.assetList}>
      {chips.map((chip) => {
        const rows = cards.filter((card) => String(card.kind || "") === chip.key);
        return (
          <ResourceCardFold key={chip.key} title={chip.label} count={rows.length}>
            <div className={styles.assetGroupCards}>
              {rows.map((card) => (
                <AssetCardItem key={card.asset_id} card={card} />
              ))}
            </div>
          </ResourceCardFold>
        );
      })}
    </div>
  );
}

/** 与 RelatedAssetsPanel 同一套过滤逻辑，供侧栏标题显示数量。 */
export function countRelatedAssets(
  entityId: string | null | undefined,
  library: AssetsLibrary | null | undefined,
  options?: {
    entityAliases?: string[];
    lectureId?: string | null;
    lectureOnly?: boolean;
    kinds?: string[] | null;
    matchMode?: "full" | "concept" | "strict";
  },
): number {
  const ids = [entityId, ...(options?.entityAliases || [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!ids.length || !library) return 0;
  const seen = new Set<string>();
  let total = 0;
  for (const id of ids) {
    for (const card of findAssetsForEntity(library, id, {
      lectureId: options?.lectureId,
      lectureOnly: options?.lectureOnly,
      llmPrinciplesOnly: true,
      kinds: options?.kinds || undefined,
      matchMode: options?.matchMode,
    })) {
      if (seen.has(card.asset_id)) continue;
      seen.add(card.asset_id);
      total += 1;
    }
  }
  return total;
}
