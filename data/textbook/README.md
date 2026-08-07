# 教材知识图谱数据

本目录存放从 AutoEduKG 导出的**教材母图**，供后续「讲课 cue → 子图检索 → 混合抽取」使用。

## CS2501-离散数学（数理逻辑与集合论）

来源：`AutoEduKG/kg/kg-former/CS2501-离散数学（数理逻辑与集合论）`

| 文件 | 说明 |
|------|------|
| `entity_final.json` | 1482 实体：`name`, `definition`, `theorems[]`, `importance` |
| `relations_final.json` | 2754 关系：`subject`, `predicate`, `object`, `description`, `context` |
| `entity_sorted.json` | 当前与 `entity_sorted_ppr.json` 同步（`--promote` 后） |
| `entity_sorted_ppr.json` | 改进 Biased-PPR 全局分 |
| `entity_sorted_classic_pr.json` | 原经典 PageRank 备份 |
| `importance_bundle.json` | 全局 + 分章 PPR |
| `toc.md` / `toc_source.txt` | OCR 目录提取 |

```bash
python scripts/teaching/run_importance_pr_build.py --promote
python scripts/teaching/run_importance_feedback.py --lecture 1   # α 消融
python scripts/teaching/run_importance_feedback.py --write       # 整课正式反馈
python scripts/teaching/run_importance_feedback.py --suggest-map
```

配置：`configs/teaching.yaml` → `stage1.textbook_kg`

启用混合抽取：

```yaml
stage1:
  textbook_kg:
    enabled: true
  llm_only:
    sync_active_triplets: false   # 混合结果写 triplets.jsonl，不覆盖 llm_only 基线
```
