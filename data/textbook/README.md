# 教材知识图谱数据

本目录存放从 AutoEduKG 导出的**教材母图**，供后续「讲课 cue → 子图检索 → 混合抽取」使用。

## CS2501-离散数学（数理逻辑与集合论）

来源：`AutoEduKG/kg/kg-former/CS2501-离散数学（数理逻辑与集合论）`

| 文件 | 说明 |
|------|------|
| `entity_final.json` | 1482 实体：`name`, `definition`, `theorems[]`, `importance` |
| `relations_final.json` | 2754 关系：`subject`, `predicate`, `object`, `description`, `context` |
| `entity_sorted.json` | 实体 PageRank 重要性分数 |

配置：`configs/teaching.yaml` → `stage1.textbook_kg`

启用混合抽取：

```yaml
stage1:
  textbook_kg:
    enabled: true
  llm_only:
    sync_active_triplets: false   # 混合结果写 triplets.jsonl，不覆盖 llm_only 基线
```
