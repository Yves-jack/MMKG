# 重要性更新机制（v2）

课堂反馈将教材 Biased-PPR 先验与多通道课堂信号融合，产出**条件重要性**（讲次 / 一堂课 / 整课）及可解释贡献。

> 展示约定（当前）：**课堂图谱只用 `classroom_norm`，教材图谱只用教材先验**；融合分 `scores` 保留供研究，主 UI 暂不混用。

## 公式

对上下文 \(c\)、实体 \(e\)：

\[
\begin{aligned}
\mathrm{prior}_c &= (1-m)\,G(e) + m\,\sum_i w_i\,\mathrm{Ch}_i(e) \\
\mathrm{sig}_c &= \sum_k \beta_k\,\mathrm{norm}(s_{k,c}(e)) \\
I_c(e) &= (1-\alpha_c)\,\mathrm{norm}(\mathrm{prior}_c) + \alpha_c\,\mathrm{sig}_c
\end{aligned}
\]

- 仅课堂新实体：`I = min(I_max_new, σ · sig)`（默认 σ=0.88，`I_max_new=0.75`）
- \(\alpha_c\)：该上下文下先验 Top ∩ 课堂 Top 的自适应 Jaccard

## 信号通道

| 通道 | 含义 | 默认 β |
|------|------|--------|
| `mention_time` | **提及次数**（语境文本最长匹配；不再用 cue 时长） | 0.45 |
| `board_ppt` | 有 `evidence_ppt_frame_path` / 页码的端点（按次） | 0.25 |
| `discourse_role` | 例子/论域实例↓；定义句↑；资产库 theorem/principle/technique↑ | 0.20 |
| `structure_graph` | 度数 + 是否教材实体 | 0.10 |
| `app_feedback` | `data/kg/<course>/app_feedback_events.jsonl`（预留） | 0.0 |

最长匹配：文本中的「谓词逻辑」只计「谓词逻辑」，不计其子串「谓词」。

## 向上传递（图谱规则，导图只显示）

沿 `belong_to` / `part_of` / `depend_on`（子→父）自底向上：

`boost += child × 0.22 / √(父数)`，再用渐近饱和

`parent = own + (1-own)·(1-e^(-boost/0.45))`

避免线性累加把枢纽大量顶到 1.0。导图只显示传递后的数值。

## 产物

[`entity_importance_feedback.json`](../data/kg/数理逻辑/entity_importance_feedback.json)：

```json
{
  "version": 2,
  "scores": { "...": 0.72 },
  "entities": { "...": { "score": 0.72, "classroom_norm": 0.5, "contributions": {} } },
  "by_context": {
    "lecture:2": {
      "scores": {},
      "classroom": {},
      "base": {},
      "entities": {},
      "top": []
    },
    "session:1_2": {},
    "course": {}
  }
}
```

讲次 scope **不得**回退整课 `classroom`；`entities` / `classroom` 字段需自洽。

## 配置

[`configs/teaching.yaml`](../configs/teaching.yaml) → `stage1.textbook_kg.importance_feedback`

## 运行

```bash
python scripts/teaching/run_importance_feedback.py --course 数理逻辑 --write
cd web/teachkg-showcase && npm run sync-data
```

## 前端

- KG / 复习：**PR+课堂**（默认）：后处理图上算 PR，再用课堂轻量修正
  - 死区 `|C−P|<0.2` 不改；上抬 β=0.15（需 mention/board 门控），下调 β=0.22；上抬封顶 +0.25
  - C 近似去掉 `structure_graph`；堂次多讲课堂分取 **mean**
- 可切回纯课堂信号模式；`entity_importance_feedback.json` **保留不删**
- 教材页：`displayMode=textbook` / `importanceMode=textbook`
- 重要性滑条过滤（保留高分节点的 1-hop）
- 节点大小：`10 + 26·√score`
