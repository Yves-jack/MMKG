# 纯 LLM 抽取基线（对比用）

本目录保存 **Stage 1 纯大模型三元组抽取** 的结果，用于与后续「教材子图 + 混合抽取」对比。

| 文件 | 说明 |
|------|------|
| `triplets.jsonl` | LLM-only 三元组（`extract_source=llm_only`） |
| `kg.json` | 2026-07-12 快照，对应当时课程级合并图谱 |

**约定：**

- Stage 1 增量/重跑时**只更新本目录**（纯 LLM 模式），不覆盖教材融合产物
- 启用 `stage1.textbook_kg.enabled: true` 时，混合结果写入 `../triplets.jsonl`（`extract_source=textbook|lecture_delta`），**本目录保持不变**
- 活跃三元组见上级目录 `../triplets.jsonl`

配置：`configs/teaching.yaml` → `stage1.llm_only`
