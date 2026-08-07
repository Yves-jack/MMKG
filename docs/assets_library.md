# 学科方法资产库（定理 / 原理 / 技术）

与概念图谱平行的内容库：卡片承载可展示正文与稳定 `asset_id`，概念图仍描述「是什么 / 关系」。

## 第1期范围

- 卡片种类：`theorem` | `principle` | `technique`（学科方法）
- 与图谱关联：`concepts[].entity` = Stage2 canonical 实体全名
- 展示：图谱页选中实体 → 侧栏「相关定理·原理·方法」
- **不做**：演示 / 动画 / 出题（`links.*` 预留为空数组）

## 数据位置

| 路径 | 说明 |
|------|------|
| `data/kg/{course}/assets/curated_seed.json` | 手写方法/原理种子 |
| `data/kg/{course}/assets/library.json` | 构建产物（教材定理 + curated） |
| `web/teachkg-showcase/public/data/assets_library.json` | `npm run sync-data` 拷贝 |

## 构建

```bash
python scripts/teaching/build_assets_library.py --course-id shuliluoji
cd web/teachkg-showcase && npm run sync-data
```

教材侧从 `entity.theorems[]` 展开（过滤「未知」等噪声）；curated 同 `asset_id` 覆盖教材卡。

## 卡片字段

| 字段 | 说明 |
|------|------|
| `asset_id` | 稳定 ID，如 `tech_finite_domain_expand` |
| `kind` | `theorem` / `principle` / `technique` |
| `name` | `中文/English` |
| `aliases` | 别名 |
| `summary` | 侧栏摘要 |
| `statement` | 形式化陈述 |
| `steps` | 仅方法：有序步骤 |
| `concepts` | `[{entity, role}]`，`role` ∈ `about` \| `applies_to` \| `uses` |
| `grounding` | 可选 `lecture_id` / `cue_id` / `ppt_page` |
| `source` | `textbook` \| `lecture` \| `curated` |
| `links` | `{ demos, anims, problems }` — 第2期挂资源 ID/路径 |

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
