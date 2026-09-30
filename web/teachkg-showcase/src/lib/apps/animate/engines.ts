import { buildHuffmanTreeFrames } from "./huffmanTree";
import {
  defaultClauses,
  parseClauses,
  parseFrequencyTable,
  pickCourseQuote,
} from "./examples";
import {
  defaultGraph,
  randomGraph,
  runBfsFrames,
  runColoringFrames,
  runDfsFrames,
} from "./graphRuntime";
import type {
  AnimBar,
  AnimEngineId,
  AnimFrame,
  AnimSpec,
  AnimTier,
  GraphModel,
} from "./types";

function tierOf(engine: AnimEngineId, suitability: number): AnimTier {
  if (engine === "generic-steps") return suitability >= 0.7 ? "sketch" : "skip";
  if (suitability >= 0.85) return "crafted";
  if (suitability >= 0.7) return "sketch";
  return "skip";
}

/** 归结：支持课内子句 + 冲突对照 */
export function buildResolutionFrames(
  clausesIn?: string[] | null,
  courseQuote?: string
): { frames: AnimFrame[]; usedCourseExample: boolean; exampleNote?: string } {
  const usedCourseExample = !!(clausesIn && clausesIn.length >= 3);
  const clauses = [...(clausesIn || defaultClauses())];
  const exampleNote = usedCourseExample
    ? `使用课内子句：{${clauses.join(", ")}}`
    : "课内未解析到 CNF，使用示意子句集";

  const DEF =
    courseQuote ||
    "归结：对含互补文字的两子句消去该对，得到新子句；推出 □ 则不可满足。";

  const bars = (labels: string[], active: string[] = []): AnimBar[] =>
    labels.map((label, i) => ({
      id: `c${i}-${label}`,
      label,
      value: Math.max(2, 8 - label.length / 3),
      state: active.includes(label) ? "active" : "idle",
    }));

  const frames: AnimFrame[] = [
    {
      caption: "CNF 子句集",
      detail: `{${clauses.join(", ")}}`,
      definition: DEF,
      analysis:
        "先列出全部子句。归结只对「含互补文字」的两子句动手：消去那一对，得到更短的新子句。",
      tip: "DPLL 会在赋值冲突时回溯；这里用归结链示意",
      bars: bars(clauses),
    },
  ];

  // 若是默认集，走精心设计的链；否则做简化示意
  const isDefault =
    clauses.join("|") === defaultClauses().join("|") || clauses.length >= 3;

  if (isDefault && clauses.some((c) => /¬r|~r/.test(c))) {
    frames.push(
      {
        caption: "选择含 r / ¬r 的子句归结",
        detail: "消去 r，缩小搜索空间",
        definition: DEF,
        analysis:
          "互补对 (r, ¬r) 可以消掉。剩下的文字拼成预解式。若选的两子句没有互补文字，这一步根本不能做。",
        delta: "锁定互补对 (r, ¬r)",
        tip: "易错：归结对象必须含互补文字，否则不能消",
        bars: bars(clauses, clauses.filter((c) => /r/i.test(c)).slice(0, 2)),
      },
      {
        caption: "继续归结直至冲突",
        detail: "得到更短子句，逼近空子句",
        definition: DEF,
        analysis:
          "每归结一次，子句往往变短。一直做到推出空子句 □，就得到不可满足的证据。",
        delta: "子句长度总体下降",
        tip: "推出 □ = 不可满足的证据",
        bars: bars(["…", "□"].concat(clauses.slice(0, 1)), ["□"]),
      },
      {
        caption: "得到空子句 □",
        detail: "不可满足；证明完成或触发 DPLL 回溯",
        definition: DEF,
        analysis:
          "空子句不含任何文字，不可能为真。因此原 CNF 不可满足。若公式可满足，这条链不会走到 □。",
        delta: "冲突显式出现",
        tip: "若公式可满足，则不会推出 □",
        bars: bars(["□"], ["□"]),
      }
    );
  } else {
    frames.push(
      {
        caption: "挑选可归结的一对子句",
        detail: clauses.slice(0, 2).join("  与  "),
        definition: DEF,
        analysis: `先拿 ${clauses.slice(0, 2).join(" 与 ")} 尝试消解。真正动手前要确认它们含互补文字。`,
        delta: "开始消解",
        tip: "课内子句已载入；步骤为示意链",
        bars: bars(clauses, clauses.slice(0, 2)),
      },
      {
        caption: "生成预解式并检测冲突",
        detail: "若得到 □ 则不可满足",
        definition: DEF,
        analysis: "若预解式是空子句 □，原公式不可满足。否则把新子句放回集合，继续找互补对。",
        delta: "子句集更新",
        tip: "可结合练习题用同一 CNF 手算对照",
        bars: bars([...clauses.slice(0, 2), "□"], ["□"]),
      }
    );
  }

  return { frames, usedCourseExample, exampleNote };
}

export function buildGenericFrames(
  title: string,
  context: string
): AnimFrame[] {
  const bits = String(context || "")
    .replace(/\s+/g, " ")
    .split(/[。；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6)
    .slice(0, 5);
  const points = bits.length
    ? bits
    : [
        `明确「${title}」要解决的问题`,
        "拆解关键定义与输入输出",
        "按步骤执行核心过程",
        "检查边界与反例",
        "总结适用场景",
      ];
  const quote = pickCourseQuote(context, `关于「${title}」的课内要点`);

  return points.map((p, i) => ({
    caption: `步骤 ${i + 1}/${points.length}`,
    detail: p,
    definition: quote,
    delta: i === 0 ? "从问题定义开始" : `相对上步推进到要点 ${i + 1}`,
    tip: "此为示意分步；优先学习带专用引擎的知识点",
    bars: points.map((label, j) => ({
      id: `s${j}`,
      label: label.slice(0, 18),
      value: j <= i ? 8 : 3,
      state:
        j === i ? ("active" as const) : j < i ? ("done" as const) : ("idle" as const),
    })),
  }));
}

export type GenerateOpts = {
  knowledgePoint: string;
  entityId?: string;
  lectureId?: string;
  kpKind?: string;
  context?: string;
  engine: AnimEngineId;
  suitability: number;
  reason: string;
  /** 沙盘：自定义图 */
  graph?: GraphModel;
  /** 沙盘：起点 */
  startId?: string;
  seed?: number;
};

export function generateAnimSpec(input: GenerateOpts): AnimSpec {
  const title = input.knowledgePoint;
  const ctx = input.context || "";
  const quote = pickCourseQuote(ctx, "");
  const tier = tierOf(input.engine, input.suitability);
  let frames: AnimFrame[] = [];
  let usedCourseExample = false;
  let exampleNote: string | undefined;
  let startOptions: string[] | undefined;
  let g = input.graph || defaultGraph();

  switch (input.engine) {
    case "graph-bfs": {
      startOptions = g.nodes.map((n) => n.id);
      const start = input.startId || startOptions[0];
      frames = runBfsFrames(g, start, quote || undefined);
      exampleNote = `图沙盘 · 起点 ${start}`;
      break;
    }
    case "graph-dfs": {
      startOptions = g.nodes.map((n) => n.id);
      const start = input.startId || startOptions[0];
      frames = runDfsFrames(g, start, quote || undefined);
      exampleNote = `图沙盘 · 起点 ${start}`;
      break;
    }
    case "graph-coloring": {
      frames = runColoringFrames(g, quote || undefined);
      exampleNote = "图着色沙盘（可随机换图）";
      startOptions = g.nodes.map((n) => n.id);
      break;
    }
    case "huffman": {
      const freq = parseFrequencyTable(ctx);
      const r = buildHuffmanTreeFrames(freq, quote || undefined);
      frames = r.frames;
      usedCourseExample = r.usedCourseExample;
      exampleNote = r.exampleNote;
      break;
    }
    case "resolution-trace": {
      const clauses = parseClauses(ctx);
      const r = buildResolutionFrames(clauses, quote || undefined);
      frames = r.frames;
      usedCourseExample = r.usedCourseExample;
      exampleNote = r.exampleNote;
      break;
    }
    default:
      frames = buildGenericFrames(title, ctx);
      exampleNote = "示意分步（非精制引擎）";
  }

  const etaSec = Math.max(40, Math.round(frames.length * 14));

  return {
    id: `${input.engine}:${input.entityId || title}`,
    title,
    engine: input.engine,
    knowledgePoint: title,
    entityId: input.entityId,
    lectureId: input.lectureId,
    kpKind: input.kpKind,
    suitability: input.suitability,
    tier,
    reason: input.reason,
    usedCourseExample,
    exampleNote,
    etaSec,
    frames,
    courseQuote: quote || undefined,
    generatedAt: Date.now(),
    startOptions,
  };
}

/** 沙盘：换起点 / 随机图后重生成同引擎动画 */
export function regenerateSandbox(
  spec: AnimSpec,
  opts: {
    startId?: string;
    randomize?: boolean;
    seed?: number;
    graph?: GraphModel;
  }
): AnimSpec {
  const isGraph = ["graph-bfs", "graph-dfs", "graph-coloring"].includes(
    spec.engine
  );
  let g: GraphModel | undefined;
  if (isGraph) {
    if (opts.randomize) g = randomGraph(opts.seed || Date.now());
    else if (opts.graph) g = opts.graph;
    else g = defaultGraph();
  }
  return generateAnimSpec({
    knowledgePoint: spec.knowledgePoint,
    entityId: spec.entityId,
    lectureId: spec.lectureId,
    kpKind: spec.kpKind,
    context: spec.courseQuote,
    engine: spec.engine,
    suitability: spec.suitability,
    reason: spec.reason,
    graph: g,
    startId: opts.startId,
    seed: opts.seed,
  });
}

export { defaultGraph, randomGraph };
export type { GraphModel } from "./types";
