import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LatexText } from "@/components/pipeline/LatexText";
import { CollapsiblePanel } from "@/components/pipeline/CollapsiblePanel";
import { RelatedAssetsPanel } from "@/components/pipeline/SelectionPanels";
import { originLabel, zhName, type AppReviewPoint } from "@/lib/apps/data";
import { fmtWatchTime } from "@/lib/apps/reviewSeek";
import { WatchClassroom } from "@/components/apps/WatchClassroom";
import { coursePath } from "@/lib/course";
import { findAssetsForEntity, type AssetsLibrary } from "@/lib/kg/assetsLibrary";
import { propertyOfToSentence } from "@/lib/kg/lectureKgProcess";
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";
import pipe from "@/pages/PipelinePage.module.css";
import styles from "./LectureReviewGraph.module.css";

function Tex({ text, block = false }: { text: string; block?: boolean }) {
  return <LatexText text={text} as={block ? "div" : "span"} compact />;
}

function shortName(v?: string | null) {
  return (v || "").split("/")[0] || "?";
}

function enName(v?: string | null) {
  const parts = (v || "").split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : "";
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

function hasPrBlend(node?: PipelineNode | null) {
  const c = node?.importance_contributions;
  return Boolean(c && (c.pagerank != null || c.blend_adjust != null));
}

/** 提及次数对数压缩，避免极端值；括号内保留原始次数 */
function fmtMention(count: unknown) {
  if (count == null || Number.isNaN(Number(count))) return "—";
  const n = Math.max(0, Number(count));
  const logged = Math.log1p(n);
  return `${logged.toFixed(2)}（${Math.round(n)}）`;
}

function normalizeAbstractRelation(raw?: string | null): string {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return "related_with";
  if (
    [
      "belong_to",
      "part_of",
      "depend_on",
      "synonym_of",
      "property_of",
      "related_with",
    ].includes(t)
  ) {
    return t;
  }
  if (/归属|属于/.test(t)) return "belong_to";
  if (/组成|部分/.test(t)) return "part_of";
  if (/依赖/.test(t)) return "depend_on";
  if (/同义|等价/.test(t)) return "synonym_of";
  if (/属性|性质/.test(t)) return "property_of";
  return "related_with";
}

function DetailRows({
  rows,
}: {
  rows: Array<[string, ReactNode] | null | false | undefined>;
}) {
  const list = rows.filter(Boolean) as Array<[string, ReactNode]>;
  const COLLAPSE = new Set(["描述", "释义", "相关描述", "特性"]);
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({
    描述: true,
    释义: true,
    特性: true,
  });
  if (!list.length) return null;
  return (
    <dl className={pipe.detailRows}>
      {list.map(([k, v]) => {
        const collapsible = COLLAPSE.has(k);
        const open = openKeys[k] ?? k === "特性";
        return (
          <div key={k} className={pipe.detailRow}>
            <dt>
              {collapsible ? (
                <button
                  type="button"
                  className={pipe.fieldToggle}
                  aria-expanded={open}
                  onClick={() => setOpenKeys((prev) => ({ ...prev, [k]: !open }))}
                >
                  {k}
                  <span aria-hidden>{open ? "▾" : "▸"}</span>
                </button>
              ) : (
                k
              )}
            </dt>
            {collapsible && !open ? (
              <dd className={pipe.fieldCollapsedHint}>已折叠 · 点击展开</dd>
            ) : (
              <dd>{v}</dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

function NeighborRelations({
  neighbors,
  selfId,
  selfZh,
}: {
  neighbors: NonNullable<AppReviewPoint["neighbors"]>;
  selfId: string;
  selfZh: string;
}) {
  const selfKeys = new Set(
    [selfId, selfZh, zhName(selfId)].map((s) => s.trim()).filter(Boolean)
  );
  const isSelf = (v: string) => selfKeys.has(v) || selfKeys.has(zhName(v));

  return (
    <ul className={styles.relCards}>
      {neighbors.slice(0, 12).map((n, i) => {
        const pred = n.label || n.predicate || "相关";
        const out = isSelf(n.subject);
        const other = out ? n.object : n.subject;
        const otherZh = zhName(other);
        const edgeMark = out ? `-${pred}->` : `<-${pred}-`;
        const stmt = (n.natural_statement || "").trim();
        const triple = `${zhName(n.subject)} —${pred}→ ${zhName(n.object)}`;
        const showStmt = Boolean(stmt && stmt !== triple);
        return (
          <li key={`${n.subject}-${n.predicate}-${n.object}-${i}`} className={styles.relCard}>
            <div className={styles.relMain}>
              <span className={styles.relDir} data-dir={out ? "out" : "in"}>
                {out ? "出" : "入"}
              </span>
              <span className={styles.relPred}>{edgeMark}</span>
              <span className={styles.relOther}>
                <Tex text={otherZh} />
              </span>
            </div>
            {showStmt ? (
              <p className={styles.relStmt}>
                <Tex text={stmt} />
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function EvidenceCards({
  evidence,
  courseId,
  lectureId,
  entityId,
}: {
  evidence: NonNullable<AppReviewPoint["evidence"]>;
  courseId: string;
  lectureId: string;
  entityId: string;
}) {
  return (
    <ul className={styles.relCards}>
      {evidence.slice(0, 4).map((e, i) => {
        const text = (e.text || "").trim();
        const hasTime = e.start_sec != null && Number.isFinite(Number(e.start_sec));
        return (
          <li key={`${e.cue_id || i}-${e.start_sec ?? i}`} className={styles.relCard}>
            <div className={styles.relMain}>
              <span className={styles.relDir} data-dir="cue">
                原文
              </span>
              {hasTime ? (
                <span className={styles.relPred}>{fmtWatchTime(Number(e.start_sec))}</span>
              ) : (
                <span className={styles.relPred}>无时间</span>
              )}
              <span className={styles.relOther}>课堂依据</span>
              {hasTime ? (
                <WatchClassroom
                  className={styles.relJump}
                  courseId={courseId}
                  lectureId={String(e.lecture_id || lectureId)}
                  startSec={e.start_sec}
                  entityId={entityId}
                />
              ) : null}
            </div>
            {text ? (
              <p className={styles.relStmt}>
                <Tex text={text} />
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function edgesToNeighbors(
  edges: PipelineEdge[],
  selfId: string
): NonNullable<AppReviewPoint["neighbors"]> {
  return edges.map((e) => ({
    subject: e.from,
    predicate: e.relation || e.label || "related_with",
    object: e.to,
    label: e.label || e.relation,
    natural_statement: e.statement || e.description || undefined,
  }));
}

function collectProperties(
  stageNode: PipelineNode | null | undefined,
  related: PipelineEdge[],
  selfId: string
): string[] {
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
    if (String(e.to) !== selfId) continue;
    pushProp(propertyOfToSentence(e));
  }
  return propertyLines;
}

export type ReviewGraphEdgeInfo = {
  id: string;
  from: string;
  to: string;
  label: string;
  predicate?: string;
  statement?: string;
};

/** 对齐课堂 KG 详情卡片风格的复习图谱选中面板 */
export function ReviewGraphDetailCard({
  courseId,
  lectureId,
  mode,
  point,
  nodeId,
  nodeLabel,
  edge,
  fromLabel,
  toLabel,
  fromPoint,
  toPoint,
  pipelineNode,
  relatedEdges,
  pipelineEdge,
  assetsLibrary = null,
}: {
  courseId: string;
  lectureId: string;
  mode: "node" | "edge";
  point?: AppReviewPoint | null;
  nodeId?: string;
  nodeLabel?: string;
  edge?: ReviewGraphEdgeInfo | null;
  fromLabel?: string;
  toLabel?: string;
  fromPoint?: AppReviewPoint | null;
  toPoint?: AppReviewPoint | null;
  pipelineNode?: PipelineNode | null;
  relatedEdges?: PipelineEdge[];
  pipelineEdge?: PipelineEdge | null;
  assetsLibrary?: AssetsLibrary | null;
}) {
  if (mode === "edge" && edge) {
    const pred = edge.label || edge.predicate || "相关";
    const fromZh = fromLabel || shortName(edge.from);
    const toZh = toLabel || shortName(edge.to);
    const stmt =
      edge.statement ||
      pipelineEdge?.statement ||
      pipelineEdge?.description ||
      pipelineEdge?.context;
    const endpointDesc = [
      fromPoint?.summary || fromPoint?.definition,
      toPoint?.summary || toPoint?.definition,
    ]
      .filter(Boolean)
      .slice(0, 2) as string[];

    return (
      <div className={pipe.detailCard}>
        <div className={pipe.detailBadge}>关系</div>
        <div className={pipe.edgeHeadline}>
          <strong>
            <Tex text={fromZh} />
          </strong>
          <> —[{pred}]→ </>
          <strong>
            <Tex text={toZh} />
          </strong>
        </div>
        <DetailRows
          rows={[
            ["抽象关系", pred],
            edge.predicate && edge.predicate !== pred ? ["谓词", edge.predicate] : null,
            stmt ? ["自然语言", <Tex text={stmt} block />] : null,
            ["主体", <Tex text={edge.from} />],
            ["客体", <Tex text={edge.to} />],
            ["来源", `第 ${lectureId} 讲 · 课堂图谱`],
            fromPoint?.origin || toPoint?.origin
              ? [
                  "端点来源",
                  [fromPoint?.origin, toPoint?.origin]
                    .filter(Boolean)
                    .map((o) => originLabel(String(o)))
                    .join(" / "),
                ]
              : null,
            endpointDesc.length
              ? [
                  "相关描述",
                  <Tex
                    text={endpointDesc
                      .map((d, i) => `${i === 0 ? fromZh : toZh}：${d}`)
                      .join("\n\n")}
                    block
                  />,
                ]
              : null,
          ]}
        />
        <div className={styles.cardLinks}>
          {fromPoint ? (
            <Link
              className={styles.cardLink}
              to={coursePath(
                courseId,
                `/apps/review/${lectureId}?kp=${encodeURIComponent(fromPoint.id)}`
              )}
            >
              查看「{fromZh}」复习
            </Link>
          ) : null}
          {toPoint ? (
            <Link
              className={styles.cardLink}
              to={coursePath(
                courseId,
                `/apps/review/${lectureId}?kp=${encodeURIComponent(toPoint.id)}`
              )}
            >
              查看「{toZh}」复习
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  const id = pipelineNode?.id || point?.id || nodeId || "";
  const zh =
    pipelineNode?.label || point?.zh || nodeLabel || shortName(id);
  const en = enName(id);
  const related = relatedEdges || [];
  const neighborsFromGraph = edgesToNeighbors(related, id);
  const neighbors =
    neighborsFromGraph.length > 0
      ? neighborsFromGraph
      : point?.neighbors || [];
  const propertyLines = collectProperties(pipelineNode, related, id);
  const aliasList = (pipelineNode?.aliases || [])
    .map((a) => String(a || "").trim())
    .filter((a) => a && a !== id);
  const aliasText = aliasList
    .map((a) => {
      const az = shortName(a);
      const ae = enName(a);
      return ae ? `${az}（${ae}）` : az || a;
    })
    .join("、");
  const kgDesc = (pipelineNode?.description || "").trim();
  const reviewDesc = (point?.definition || point?.summary || "").trim();
  const desc = kgDesc || reviewDesc;
  const summaryOnly =
    !kgDesc &&
    point?.summary &&
    point.definition &&
    point.summary !== point.definition
      ? point.summary.trim()
      : "";
  const evidenceList = point?.evidence || [];
  const importance =
    pipelineNode?.importance != null
      ? pipelineNode.importance
      : point?.importance;
  const assetCards = findAssetsForEntity(assetsLibrary, id, {
    lectureId,
    lectureOnly: true,
    llmPrinciplesOnly: true,
  });

  return (
    <div className={pipe.detailCard}>
      <div className={pipe.detailBadge}>实体</div>
      <CollapsiblePanel
        title="基本信息"
        storageKey="review-graph-basics"
        defaultOpen
        className={styles.relBlock}
      >
        <DetailRows
          rows={[
            ["规范名", id ? <Tex text={id} /> : "—"],
            ["中文名", <Tex text={zh || "—"} />],
            ["英文名", en ? <Tex text={en} /> : "—"],
            ["别名", aliasText ? <Tex text={aliasText} /> : "—"],
            point?.origin ? ["来源", originLabel(point.origin)] : null,
            [
              "特性",
              propertyLines.length ? (
                <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                  {propertyLines.map((p) => (
                    <li key={p} style={{ marginBottom: "0.2rem" }}>
                      <Tex text={p} />
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              ),
            ],
            summaryOnly ? ["摘要", <Tex text={summaryOnly} block />] : null,
            desc
              ? ["描述", <Tex text={desc} block />]
              : !point && !pipelineNode
                ? ["描述", "该节点仅作为关系端点出现。"]
                : ["描述", "—"],
          ]}
        />
        <div className={pipe.metrics}>
          {hasPrBlend(pipelineNode) ? (
            <>
              <div>
                <span>PR</span>
                {fmt(
                  pipelineNode?.importance_base ??
                    pipelineNode?.importance_contributions?.pagerank
                )}
              </div>
              <div
                title={
                  Number(pipelineNode?.importance_contributions?.boost_gated) > 0
                    ? "上抬被 mention/board 门控拦截"
                    : "课堂相对 PR 的修正量"
                }
              >
                <span>修正</span>
                {fmtDelta(
                  pipelineNode?.importance_delta ??
                    pipelineNode?.importance_contributions?.blend_adjust
                )}
              </div>
              <div>
                <span>最终</span>
                {fmt(importance)}
              </div>
            </>
          ) : (
            <div>
              <span>重要性</span>
              {fmt(importance)}
            </div>
          )}
          <div>
            <span>提及</span>
            {point?.mention_count != null ? fmtMention(point.mention_count) : "—"}
          </div>
          <div>
            <span>关系</span>
            {String(neighbors.length)}
          </div>
        </div>
        {hasPrBlend(pipelineNode) &&
        pipelineNode?.importance_contributions &&
        (pipelineNode.importance_contributions.classroom_adj != null ||
          Number(pipelineNode.importance_contributions.boost_gated) > 0) ? (
          <div className={pipe.contribBlock} style={{ marginTop: 8 }}>
            <div className={pipe.contribTitle}>修正细节</div>
            {pipelineNode.importance_contributions.classroom_adj != null ? (
              <div className={pipe.contribRow}>
                <span>课堂 C′</span>
                <em>{fmt(pipelineNode.importance_contributions.classroom_adj)}</em>
              </div>
            ) : null}
            {Number(pipelineNode.importance_contributions.boost_gated) > 0 ? (
              <div className={pipe.contribRow}>
                <span>门控</span>
                <em>上抬已拦截（缺 mention/board）</em>
              </div>
            ) : null}
          </div>
        ) : null}
      </CollapsiblePanel>
      {neighbors.length ? (
        <CollapsiblePanel
          title="相关关系"
          storageKey="review-graph-neighbors"
          defaultOpen
          className={styles.relBlock}
        >
          <NeighborRelations neighbors={neighbors} selfId={id} selfZh={zh} />
        </CollapsiblePanel>
      ) : (
        <p className={styles.relEmpty}>本讲暂无邻接关系</p>
      )}
      {evidenceList.length ? (
        <CollapsiblePanel
          title="课堂原文"
          storageKey="review-graph-evidence"
          defaultOpen
          className={styles.relBlock}
        >
          <EvidenceCards
            evidence={evidenceList}
            courseId={courseId}
            lectureId={lectureId}
            entityId={point?.id || id}
          />
        </CollapsiblePanel>
      ) : null}
      {assetCards.length ? (
        <CollapsiblePanel
          title="相关公式 · 例子 · 定理"
          storageKey="review-graph-assets"
          defaultOpen
          className={styles.relBlock}
        >
          <RelatedAssetsPanel
            entityId={id}
            library={assetsLibrary}
            lectureId={lectureId}
            lectureOnly
            maxItems={8}
            hideEmpty
          />
        </CollapsiblePanel>
      ) : null}
    </div>
  );
}
