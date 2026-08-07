import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { PipelineEdge, PipelineStage } from "@/lib/pipeline/types";
import { isBidirectionalRelation } from "@/lib/pipeline/graphLogic";
import {
  assetKindLabel,
  findAssetsForEntity,
  type AssetCard,
  type AssetsLibrary,
} from "@/lib/kg/assetsLibrary";
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
  cross_cue: "跨段衔接",
  llm_fallback: "LLM 回退",
  llm_only: "LLM",
  filtered: "已过滤/删除",
  both: "两讲共有",
};

/** 来源行：抽取类型 · 讲次 · 片段 */
function formatEdgeSource(edge: PipelineEdge): string {
  const parts: string[] = [];
  const src = (edge.source || "").trim();
  const span = (edge.extract_source || "").trim();
  const lecRaw =
    edge.lecture_id != null && String(edge.lecture_id).trim()
      ? String(edge.lecture_id).trim()
      : "";

  // 跨段边优先展示「第N讲的第a段到第b段」
  if (src === "cross_cue" && span) {
    parts.push(span);
  } else if (src === "filtered" && (span || edge.dedupe_reason_zh || edge.dedupe_reason)) {
    parts.push("去重候选");
    const reason = (edge.dedupe_reason_zh || edge.dedupe_reason || "").trim();
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

  const cueLabel = (edge.cue_label || "").trim();
  if (cueLabel) {
    // 若标签已含讲次且上面已写讲次，去掉前缀避免重复
    const stripped = lecLabel
      ? cueLabel.replace(new RegExp(`^${lecLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[·•|]\\s*`), "")
      : cueLabel;
    if (stripped) parts.push(stripped);
  } else if (edge.cue_ids && edge.cue_ids.length > 1) {
    parts.push(`${edge.cue_ids.length} 个片段`);
  } else if (edge.cue_id) {
    parts.push(String(edge.cue_id));
  }

  return parts.join(" · ") || "—";
}

const ABSTRACT_RELATIONS = [
  "belong_to",
  "part_of",
  "depend_on",
  "property_of",
  "synonym_of",
  "related_with",
] as const;

function normalizeAbstractRelation(raw?: string | null): string {
  const p = (raw || "").trim();
  if ((ABSTRACT_RELATIONS as readonly string[]).includes(p)) return p;
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

function DetailRows({ rows }: { rows: Array<[string, ReactNode] | null | false | undefined> }) {
  const list = rows.filter(Boolean) as Array<[string, ReactNode]>;
  if (!list.length) return null;
  return (
    <dl className={styles.detailRows}>
      {list.map(([k, v]) => (
        <div key={k} className={styles.detailRow}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
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
function fmtDelta(v: unknown) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}

export function SelectionDetail({
  stage,
  selectedNodeId,
  selectedEdgeId,
  hideFiltered = false,
  mode = "lecture",
  /** textbook：仅教材先验；full：教材先验 + 反馈后 + Δ */
  importanceMode = "full",
}: {
  stage: PipelineStage;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hideFiltered?: boolean;
  mode?: string;
  importanceMode?: "full" | "textbook";
}) {
  const edge = resolveEdgeForDetail(stage, selectedEdgeId);
  const stageNode = selectedNodeId
    ? (stage.nodes || []).find((n) => String(n.id) === String(selectedNodeId)) || null
    : null;

  if (edge) {
    const pred = normalizeAbstractRelation(edge.relation || edge.label || "");
    const concrete = (edge.concrete || edge.concrete_relation || "").trim();
    const action = edge.correction_action || "";
    const isRevise = action === "revise" || action === "revise_before";
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
        {isRevise && edge.before && edge.after ? (
          <div className={styles.tripCompare}>
            <div className={styles.tripBefore}>
              <span className={styles.tripTag}>前</span>
              {snapLine(edge.before)}
            </div>
            <div className={styles.tripAfter}>
              <span className={styles.tripTagAfter}>后</span>
              {snapLine(edge.after)}
            </div>
            {edge.changes?.length ? (
              <small className={styles.tripChanges}>变化：{edge.changes.join("、")}</small>
            ) : null}
          </div>
        ) : null}
        {action === "drop" ? (
          <div className={styles.tripCompare}>
            <div className={styles.tripBefore}>
              <span className={styles.tripTag}>删</span>
              {snapLine(
                edge.before || {
                  from: edge.from,
                  to: edge.to,
                  label: edge.label,
                  concrete: edge.concrete,
                }
              )}
            </div>
          </div>
        ) : null}
        <DetailRows
          rows={[
            ["抽象关系", abstractRelationLabel(pred)],
            concrete ? ["具体关系", <Tex text={concrete} />] : null,
            edge.source || edge.lecture_id || edge.cue_label || edge.cue_id
              ? ["来源", formatEdgeSource(edge)]
              : null,
            action ? ["修正动作", action] : null,
            edge.description ? ["描述", <Tex text={edge.description} block />] : null,
            edge.basis_before
              ? ["修正前依据", <Tex text={edge.basis_before} block />]
              : edge.context
                ? ["课堂依据", <Tex text={edge.context} block />]
                : null,
            edge.correction_reason ? ["理由摘要", <Tex text={edge.correction_reason} block />] : null,
            edge.correction_reason_detail ? (
              ["详细理由", <Tex text={edge.correction_reason_detail} block />]
            ) : null,
            edge.basis_after || edge.correction_evidence
              ? [
                  "修正依据",
                  <Tex text={edge.basis_after || edge.correction_evidence || ""} block />,
                ]
              : null,
          ]}
        />
      </div>
    );
  }

  if (selectedNodeId) {
    const id = String(selectedNodeId);
    const kind = String(stageNode?.kind || "");
    const zh = String(stageNode?.label || shortName(id));
    const en = enName(id);
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
    const descSamples = related
      .map((e) => e.description || e.context)
      .filter((x): x is string => Boolean(x && String(x).trim()))
      .filter((x, i, arr) => arr.indexOf(x) === i)
      .slice(0, 2);
    return (
      <div className={styles.detailCard}>
        <div className={styles.detailBadge}>
          {stageNode?.filtered_by_importance ? "被筛实体" : "实体"}
        </div>
        <DetailRows
          rows={[
            ["中文名", <Tex text={zh || "—"} />],
            ["英文名", en ? <Tex text={en} /> : "—"],
            aliasText ? ["别名", <Tex text={aliasText} />] : null,
            kind ? ["角色", KIND_LABEL[kind] || kind] : null,
            stageNode?.description
              ? ["描述", <Tex text={String(stageNode.description)} block />]
              : null,
            stageNode?.filtered_by_importance
              ? ["筛选", "低于当前重要性阈值（临时显示）"]
              : null,
            ["关联边数", String(related.length)],
            descSamples.length
              ? [
                  "相关描述",
                  <Tex text={descSamples.join("\n\n")} block />,
                ]
              : null,
          ]}
        />
        <div className={styles.metrics}>
          {importanceMode === "textbook" ? (
            <div>
              <span>教材重要性</span>
              {fmt(stageNode?.importance_base ?? stageNode?.importance)}
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
              <div className={styles.contribTitle}>重要性贡献</div>
              {Object.entries(stageNode.importance_contributions)
                .sort((a, b) => Number(b[1]) - Number(a[1]))
                .map(([k, v]) => {
                  const val = Math.max(0, Number(v) || 0);
                  const maxC = Math.max(
                    ...Object.values(stageNode.importance_contributions || {}).map((x) =>
                      Number(x) || 0
                    ),
                    1e-6
                  );
                  const label: Record<string, string> = {
                    prior: "先验",
                    mention_time: "时长提及",
                    board_ppt: "板书/PPT",
                    discourse_role: "话语角色",
                    structure_graph: "结构支撑",
                    app_feedback: "应用反馈",
                  };
                  return (
                    <div key={k} className={styles.contribRow}>
                      <span>{label[k] || k}</span>
                      <div className={styles.contribBarTrack}>
                        <div
                          className={styles.contribBar}
                          style={{ width: `${Math.min(100, (val / maxC) * 100)}%` }}
                        />
                      </div>
                      <em>{val.toFixed(3)}</em>
                    </div>
                  );
                })}
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
      <small>
        {formatEdgeSource(e) + (action ? ` · ${action}` : "")}
        {e.concrete ? (
          <>
            {" · "}
            <Tex text={e.concrete} />
          </>
        ) : null}
      </small>
    </button>
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
  const edges = edgesForStage(stage, hideFiltered, mode).filter(
    (e) => String(e.from) === String(nodeId) || String(e.to) === String(nodeId)
  );
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

const ROLE_LABEL: Record<string, string> = {
  about: "关于",
  applies_to: "作用于",
  uses: "用到",
};

function AssetCardItem({ card }: { card: AssetCard }) {
  const [open, setOpen] = useState(false);
  const zh = shortName(card.name);
  const en = enName(card.name);
  const hasBody =
    Boolean((card.statement || "").trim()) || Boolean((card.steps || []).length);
  return (
    <div className={styles.assetCard}>
      <div className={styles.assetHead}>
        <span className={styles.assetKind}>{assetKindLabel(card.kind)}</span>
        <strong className={styles.assetTitle}>
          <Tex text={zh} />
        </strong>
      </div>
      {en ? <div className={styles.assetEn}>{en}</div> : null}
      {card.summary ? (
        <div className={styles.assetSummary}>
          <Tex text={card.summary} block />
        </div>
      ) : null}
      {hasBody ? (
        <button
          type="button"
          className={styles.assetToggle}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起陈述" : "展开陈述 / 步骤"}
        </button>
      ) : null}
      {open ? (
        <div className={styles.assetBody}>
          {card.statement ? (
            <div className={styles.assetStatement}>
              <Tex text={card.statement} block />
            </div>
          ) : null}
          {(card.steps || []).length ? (
            <ol className={styles.assetSteps}>
              {(card.steps || []).map((s, i) => (
                <li key={i}>
                  <Tex text={s} />
                </li>
              ))}
            </ol>
          ) : null}
          {(card.concepts || []).length ? (
            <div className={styles.assetConcepts}>
              {(card.concepts || []).map((c, i) => (
                <span key={`${c.entity}-${i}`} className={styles.assetConceptChip}>
                  {ROLE_LABEL[String(c.role || "about")] || c.role} ·{" "}
                  <Tex text={shortName(c.entity)} />
                </span>
              ))}
            </div>
          ) : null}
          <div className={styles.assetMeta}>
            <code>{card.asset_id}</code>
            {card.source ? <span>· {card.source}</span> : null}
            {card.grounding?.lecture_id ? (
              <span>· 第 {card.grounding.lecture_id} 讲</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 选中概念时展示关联的定理 / 原理 / 学科方法卡片 */
export function RelatedAssetsPanel({
  entityId,
  library,
  maxItems = 12,
}: {
  entityId: string | null;
  library: AssetsLibrary | null;
  maxItems?: number;
}) {
  const cards = useMemo(
    () => (entityId ? findAssetsForEntity(library, entityId) : []),
    [entityId, library]
  );
  if (!entityId) {
    return <div className={styles.sideEmpty}>选中实体后显示相关定理·原理·方法</div>;
  }
  if (!library) {
    return <div className={styles.sideEmpty}>资产库未加载</div>;
  }
  if (!cards.length) {
    return <div className={styles.sideEmpty}>暂无关联的定理·原理·方法</div>;
  }
  const shown = cards.slice(0, maxItems);
  const rest = cards.length - shown.length;
  return (
    <div className={styles.assetList}>
      {shown.map((c) => (
        <AssetCardItem key={c.asset_id} card={c} />
      ))}
      {rest > 0 ? (
        <div className={styles.assetMore}>另有 {rest} 条教材定理未展开</div>
      ) : null}
    </div>
  );
}
