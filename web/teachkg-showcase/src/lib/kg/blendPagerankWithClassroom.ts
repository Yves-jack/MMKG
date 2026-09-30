/**
 * PR 为主 + 课堂信号轻量修正（带 mention/board 通道门控）。
 *
 * I = clip(P + adjust)
 * δ = C' - P；|δ|≤τ 不改
 * 上抬：需 mention/board 门控，且 I ≤ P + boostCap
 * 下调：结构 hub 课上弱 → 略压（无需门控）
 */
import type { PipelineNode } from "@/lib/pipeline/types";
import { lookupImportance, lookupContributions } from "@/lib/kg/adaptToPipeline";

export type PrClassroomBlendOpts = {
  /** 上抬强度（默认 0.15） */
  betaUp?: number;
  /** 下调强度（默认 0.22） */
  betaDown?: number;
  /** 死区：|C-P| 小于此不修正（默认 0.2） */
  tau?: number;
  /** 相对 P 的最大上抬（默认 0.25） */
  boostCap?: number;
  /**
   * mention+board 占教学通道（mention/board/discourse/structure）比例下限，
   * 达此才允许上抬（默认 0.35）
   */
  gateCoreRatio?: number;
};

const DEFAULTS = {
  betaUp: 0.15,
  betaDown: 0.22,
  tau: 0.2,
  boostCap: 0.25,
  gateCoreRatio: 0.35,
};

function sizeFromImportance(score: number): number {
  const s = Math.max(0, Math.min(1, score));
  return 10 + (36 - 10) * s;
}

function clip01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * 从融合贡献里估计「去结构」课堂强度，并判断是否允许上抬。
 * classroom_norm 已含 structure；用贡献占比近似剥离。
 */
export function classroomForBlend(
  classroomNorm: number | null,
  contrib: Record<string, number> | null
): { c: number; canBoost: boolean; coreRatio: number } {
  const c0 = classroomNorm != null && Number.isFinite(classroomNorm) ? classroomNorm : 0;
  if (!contrib || typeof contrib !== "object") {
    // 无贡献明细：不允许上抬，只允许下调（防提及灌爆）
    return { c: c0, canBoost: false, coreRatio: 0 };
  }
  const mention = Math.max(0, Number(contrib.mention_time) || 0);
  const board = Math.max(0, Number(contrib.board_ppt) || 0);
  const discourse = Math.max(0, Number(contrib.discourse_role) || 0);
  const structure = Math.max(0, Number(contrib.structure_graph) || 0);
  const teach = mention + board + discourse + structure;
  const core = mention + board;
  const coreRatio = teach > 1e-12 ? core / teach : 0;

  // 近似去掉 structure 在教学通道中的份额
  let c = c0;
  if (teach > 1e-12 && structure > 0) {
    c = c0 * (1 - structure / teach);
  }

  // 门控：mention+board 占比够，或有明显板书贡献
  const canBoost =
    (teach > 1e-12 && coreRatio >= DEFAULTS.gateCoreRatio) || board > 1e-6;

  return { c: clip01(c), canBoost, coreRatio };
}

function softDelta(delta: number, tau: number): number {
  const a = Math.abs(delta);
  if (a <= tau) return 0;
  return Math.sign(delta) * (a - tau);
}

/**
 * 对已有 PR importance 的节点做课堂轻量修正。
 */
export function blendPagerankWithClassroom(
  nodes: PipelineNode[],
  opts: {
    classroom?: Record<string, number> | null;
    contributions?: Record<string, Record<string, number>> | null;
  } & PrClassroomBlendOpts
): PipelineNode[] {
  const betaUp = opts.betaUp ?? DEFAULTS.betaUp;
  const betaDown = opts.betaDown ?? DEFAULTS.betaDown;
  const tau = opts.tau ?? DEFAULTS.tau;
  const boostCap = opts.boostCap ?? DEFAULTS.boostCap;
  const gateCoreRatio = opts.gateCoreRatio ?? DEFAULTS.gateCoreRatio;

  return nodes.map((n) => {
    const p0 = Number(n.importance);
    const P = Number.isFinite(p0) ? clip01(p0) : 0;
    const rawC = lookupImportance(opts.classroom, n.id);
    const contrib = lookupContributions(opts.contributions, n.id);

    const mention = Math.max(0, Number(contrib?.mention_time) || 0);
    const board = Math.max(0, Number(contrib?.board_ppt) || 0);
    const discourse = Math.max(0, Number(contrib?.discourse_role) || 0);
    const structure = Math.max(0, Number(contrib?.structure_graph) || 0);
    const teach = mention + board + discourse + structure;
    const core = mention + board;
    const coreRatio = teach > 1e-12 ? core / teach : 0;

    let C = rawC != null ? rawC : 0;
    if (rawC != null && teach > 1e-12 && structure > 0) {
      C = rawC * (1 - structure / teach);
    }
    C = clip01(C);

    const canBoost =
      (teach > 1e-12 && coreRatio >= gateCoreRatio) || board > 1e-6;

    const delta = C - P;
    const soft = softDelta(delta, tau);

    let adjust = 0;
    if (soft > 0) {
      // 上抬：必须过通道门控
      if (canBoost) adjust = betaUp * soft;
    } else if (soft < 0) {
      // 下调：结构强、课堂弱
      adjust = betaDown * soft;
    }

    let I = clip01(P + adjust);
    if (I > P + boostCap) I = P + boostCap;

    const gated = soft > 0 && !canBoost;
    return {
      ...n,
      importance: I,
      importance_base: P,
      importance_delta: I - P,
      importance_contributions: {
        pagerank: P,
        classroom_adj: C,
        blend_adjust: adjust,
        ...(gated ? { boost_gated: 1 } : {}),
        ...(contrib || {}),
      },
      size: sizeFromImportance(I),
    };
  });
}
