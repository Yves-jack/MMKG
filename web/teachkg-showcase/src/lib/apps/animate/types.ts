/** 动画演示：分步场景（对齐 GraphAV / DijkstraFlow 的 step 模型） */

export type AnimNodeState = "idle" | "active" | "done" | "frontier" | "blocked";
export type AnimEdgeState = "idle" | "active" | "done";

export type AnimNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  state?: AnimNodeState;
  /** 着色等场景的色号 */
  colorIndex?: number;
};

export type AnimEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  state?: AnimEdgeState;
};

export type AnimBar = {
  id: string;
  label: string;
  value: number;
  state?: AnimNodeState;
};

/** 叠在舞台上的结构（队列 / 栈 / 森林），不要只写在旁白里 */
export type AnimHud = {
  label: string;
  items: string[];
  /** 与 items 对齐的高亮下标 */
  active?: number[];
};

/** 三层叙事 + 详细分析 */
export type AnimFrame = {
  caption: string;
  /** 当前动作（队列、合并对象等） */
  detail?: string;
  /** 对应课内定义 / 原理一句 */
  definition?: string;
  /** 2～4 句详细分析（为何这一步） */
  analysis?: string;
  /** 相对上一步的变化 */
  delta?: string;
  /** 复杂度或易错提示 */
  tip?: string;
  nodes?: AnimNode[];
  edges?: AnimEdge[];
  bars?: AnimBar[];
  hud?: AnimHud;
};

export type AnimEngineId =
  | "graph-bfs"
  | "graph-dfs"
  | "huffman"
  | "graph-coloring"
  | "resolution-trace"
  | "generic-steps";

/** 精制引擎 / 示意 / 不推荐 */
export type AnimTier = "crafted" | "sketch" | "skip";

export type AnimSpec = {
  id: string;
  title: string;
  engine: AnimEngineId;
  knowledgePoint: string;
  entityId?: string;
  lectureId?: string;
  kpKind?: string;
  suitability: number;
  tier: AnimTier;
  reason: string;
  /** 是否用了课内解析出的实例 */
  usedCourseExample: boolean;
  exampleNote?: string;
  /** 预计观看时长（秒） */
  etaSec: number;
  frames: AnimFrame[];
  /** 课内原句摘录 */
  courseQuote?: string;
  generatedAt: number;
  /** 图类引擎可沙盘的起点列表 */
  startOptions?: string[];
};

export type SuitabilityHit = {
  knowledgePoint: string;
  entityId: string;
  lectureId: string;
  kpKind: string;
  context: string;
  suitability: number;
  tier: AnimTier;
  reason: string;
  engine: AnimEngineId | null;
};

export type GraphModel = {
  nodes: AnimNode[];
  edges: AnimEdge[];
};
