# 学科方法资产库（定理 / 原理 / 技术）

与概念图谱平行的内容库：卡片承载可展示正文与稳定 `asset_id`，概念图仍描述「是什么 / 关系」。

## 第1期范围

- 卡片种类：`theorem` | `principle` | `technique`（学科方法）
- **主路径**：课堂片段大模型抽取（`source=llm`），强制 `evidence` 原文子串
- **关联**：`evidence` 与实体相关边 context 做字符 n-gram 重叠，写入 `concepts[]`
- 展示：图谱页选中实体 → 侧栏「相关定理·原理·方法」
- **不做**：演示 / 动画 / 出题（`links.*` 预留为空数组）

## 数据位置

| 路径 | 说明 |
|------|------|
| `data/kg/{course}/assets/llm_assets_lecture_{N}.json` | 各讲 LLM 抽取缓存 |
| `data/kg/{course}/assets/curated_seed.json` | 可选手写种子 |
| `data/kg/{course}/assets/library.json` | 构建产物 |
| `web/teachkg-showcase/public/data/assets_library.json` | `npm run sync-data` 拷贝 |

## 构建

```bash
# 定理/原理/方法（抽完后会自动 backfill「课堂提及的…」占位卡，并合并公式缓存）
python scripts/teaching/extract_assets_lecture_batch.py \
  --config configs/teaching_lisan.yaml \
  --course-id 离散数学(图论+数理逻辑与集合论) \
  --lectures 1,2

# 公式/例子
python scripts/teaching/extract_assets_formula_example.py \
  --config configs/teaching_lisan.yaml \
  --course-id 离散数学(图论+数理逻辑与集合论) \
  --lectures 1,2

# 仅补全占位卡 / 分章
python scripts/teaching/backfill_asset_placeholders.py --config configs/teaching_lisan.yaml
python scripts/teaching/assign_assets_chapters.py --config configs/teaching_lisan.yaml

# 从教材 toc 提取分主题章节目录（区分两个「第1章」），写入 textbook/chapter_catalog.json 并注入 library
python scripts/teaching/extract_chapter_catalog.py --config configs/teaching_lisan.yaml --showcase

cd web/teachkg-showcase && npm run sync-data
```

Prompt：`prompts/stage1/asset_extract.txt`、`asset_extract_formula_example.txt`

## 卡片字段

| 字段 | 说明 |
|------|------|
| `asset_id` | 稳定 ID |
| `kind` | `theorem` / `principle` / `technique` |
| `name` | `中文/English` |
| `evidence` | **原文依据**（课堂连续子串） |
| `summary` / `statement` / `steps` | 摘要 / 陈述 / 方法步骤 |
| `concepts` | 重叠关联得到的 `[{entity, role}]` |
| `grounding` | `lecture_id` / `cue_id` |
| `source` | `llm` \| `curated` \| `textbook` |
| `links` | 第2期挂资源 |

## 第2期挂接约定

下游模块只引用 `asset_id`，勿依赖卡片在数组中的下标。

```json
"links": {
  "demos": ["demo_finite_domain_01"],
  "anims": ["anim_quantifier_expand"],
  "problems": ["quiz_bank#pred_truth_01"]
}
```

- **演示 / 动画**：资源表另存；此处只存 ID 或相对路径
- **题目生成**：以 `statement` / `steps` 为模板锚点，生成结果回写 `links.problems`
- **图谱**：继续用 `concepts` 关联；不必把卡片画成图节点（除非产品明确要求）
