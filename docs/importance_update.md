# 重要性更新机制（v2）

课堂反馈将教材 Biased-PPR 先验与多通道课堂信号融合，产出**条件重要性**（讲次 / 一堂课 / 整课）及可解释贡献。

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
- \(\alpha_c\)：该上下文下先验 Top ∩ 课堂 Top 的自适应 Jaccard（与 v1 相同思路）

## 信号通道

| 通道 | 含义 | 默认 β |
|------|------|--------|
| `mention_time` | cue 时长 + 次数；定义语境↑、例子语境↓ | 0.45 |
| `board_ppt` | 有 `evidence_ppt_frame_path` / 页码的端点 | 0.25 |
| `discourse_role` | 例子/论域实例↓；定义句↑；资产库 theorem/principle/technique↑ | 0.20 |
| `structure_graph` | 度数 + 是否教材实体 | 0.10 |
| `app_feedback` | `data/kg/<course>/app_feedback_events.jsonl`（预留） | 0.0 |

## 产物

[`entity_importance_feedback.json`](../data/kg/shuliluoji/entity_importance_feedback.json)：

```json
{
  "version": 2,
  "scores": { "...": 0.72 },
  "entities": { "...": { "score": 0.72, "contributions": { "prior": 0.3, "mention_time": 0.2 } } },
  "by_context": {
    "lecture:2": { "scores": {}, "entities": {}, "top": [] },
    "session:1_2": {},
    "course": {}
  }
}
```

顶层 `scores` = `by_context.course`，旧前端仍可只读扁平分。

## 配置

[`configs/teaching.yaml`](../configs/teaching.yaml) → `stage1.textbook_kg.importance_feedback`：

- `channel_weights` / `new_entity_scale` / `new_entity_max`
- `assets_library` / `app_feedback_events`

## 运行

```bash
python scripts/teaching/run_importance_feedback.py --course shuliluoji --write
cd web/teachkg-showcase && npm run sync-data
```

## 前端

- KG 页按 scope 选 `lecture:N` / `session:a_b` / `course` 分数
- 重要性滑条过滤（保留高分节点的 1-hop）
- 实体详情展示贡献条
- 节点大小：`10 + 26·√score`（与后端 `importance_to_node_size` 对齐）

## 查询 API（Python）

```python
from teachkg.textbook_kg.importance_feedback import importance_of
rec = importance_of(doc, "论域/domain of discourse", context="lecture:2")
# {"score": ..., "contributions": {...}, "alpha": ..., "chapter_ids": [...]}
```

## 第2期预留

- 应用反馈事件真正接入（问答未命中 / 练习错误 / 钉选）
- 跨课时间衰减 `I ← ρ·I + (1-ρ)·I_new`
- 板书版面面积 / OCR 命中细化
