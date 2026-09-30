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

## CS2501-离散数学（图论与代数结构）

来源：`AutoEduKG/kg/kg-former/CS2501-离散数学（图论与代数结构）`

| 文件 | 说明 |
|------|------|
| `entity_final.json` | 725 实体 |
| `relations_final.json` | 1151 关系 |
| `entity_sorted.json` / `entity_sorted_ppr.json` | 改进 Biased-PPR（已 `--promote`） |
| `entity_sorted_classic_pr.json` | 原 `entity_sorted` 备份 |
| `importance_bundle.json` | 全局 + 分章 PPR |
| `source_ocr.md` | 教材 OCR 正文（用于抽目录） |
| `toc.md` / `toc_source.txt` | 目录 |

```bash
python scripts/teaching/run_importance_pr_build.py \
  --textbook-dir "data/textbook/CS2501-离散数学（图论与代数结构）" \
  --ocr-md "data/textbook/CS2501-离散数学（图论与代数结构）/source_ocr.md" \
  --promote
```

## CS2501-离散数学（图论+数理逻辑与集合论）【合并母图】

由上两本合并而成（`scripts/teaching/merge_textbook_kgs.py`），供「离散数学(图论+数理逻辑与集合论)」整课使用：

| 统计 | 数量 |
|------|------|
| 实体 | ~2179 |
| 关系 | ~3901 |
| 章（目录并集） | 21 |

```bash
python scripts/teaching/merge_textbook_kgs.py \
  --source "data/textbook/CS2501-离散数学（图论与代数结构）" \
  --source "data/textbook/CS2501-离散数学（数理逻辑与集合论）" \
  --out "data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）"
```

本课流水线请用 `configs/teaching_lisan.yaml`（`textbook_kg.enabled: true`，`path` 指向合并目录，并带本课 `lecture_chapter_map`）。勿直接改 `teaching.yaml`，以免影响单独的数理逻辑课。

启用混合抽取（也可对 `run_stage1_filter.py` 加 `--hybrid`）：

```yaml
stage1:
  textbook_kg:
    enabled: true
    path: data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）
  llm_only:
    sync_active_triplets: false   # 混合结果写 triplets.jsonl，不覆盖 llm_only 基线
```
