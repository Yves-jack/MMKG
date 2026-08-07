# 教材重要性 Biased / Personalized PageRank

移植自 `AutoEduKG/biased_pagerank.py` + `process_textbook.py`，并在 VAT-KG 内做 P0/P1 改进与对比。

## 布局

| 路径 | 说明 |
|------|------|
| `biased_pagerank.py` | 原版 / 改进构图与 PPR 融合 |
| `toc_score.py` | TOC → 种子分（子串基线 / 别名紧匹配） |
| `_legacy_autoedukg/` | AutoEduKG 原文件副本 |
| `scripts/teaching/run_importance_pr_compare.py` | 三方对比脚本 |
| `extract_toc.py` | 从教材 OCR md 的「目录」页/标题层级提取 `toc.md` |
| `data/textbook/.../toc.md` | 课程目录（优先 OCR 提取） |
| `data/textbook/.../toc_source.txt` | OCR md 源路径指针 |

## 改进要点

- 边权：`related_with` 降到 0.25；`w / out_degree^β`（β=0.5）
- 种子：别名匹配 + Trust 1-hop（仅 `part_of`/`belong_to`/`depend_on`）
- 融合：K-Core 权重 0.3 → 0.1；轻度 hub 惩罚
- 分章：`importance_by_chapter.json`

## 运行

```bash
# 从 OCR 提取目录并对比（toc_source.txt 有默认路径时可省略 --ocr-md）
python scripts/teaching/run_importance_pr_compare.py

# 构建可部署 bundle（global + 12 章）
python scripts/teaching/run_importance_pr_build.py

# 可选：覆盖 entity_sorted.json（先备份经典 PR）
python scripts/teaching/run_importance_pr_build.py --promote

# 仅提取目录
python -m teachkg.importance_pr.extract_toc --ocr-md <教材.md> --out data/textbook/<course>/toc.md
```

加载时：若存在 `importance_bundle.json`，`TextbookKG.load` 会读入分章分；`kg.importance_for("第1章")` 取章条件先验。

## P2 / P3 / 通用性

- **多章先验**：对任意 TOC 标题打分；yaml 锁定主章；短章名（≤2 字）降权
- **自适应 α**：先验 Top ∩ 课堂 Top 的 Jaccard 低 → 下调 α
- **章外衰减**：未命中章关键词的实体 ×`off_chapter_penalty`
- **子图**：`set_importance_context(chapters=...)` 按讲次切换重要性视图

```bash
python scripts/teaching/run_importance_feedback.py --lecture 1 --alphas 0.35,0.45,0.55
python scripts/teaching/run_importance_feedback.py --write
python scripts/teaching/run_importance_feedback.py --suggest-map
```

消融产物：`data/experiments/comparisons/<course>/importance_p3/`
