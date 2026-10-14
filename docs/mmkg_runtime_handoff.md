# TeachKG ↔ MMKG-runtime 分工（1A + 2B）

## 主路径

**MMKG-runtime** 负责交学伴 / VideoSearch 触发的在线构建：

`video-chunks (asr_text) → cues → Stage1–2 → importance → pipeline/kg_processed → mindmap → assets → sync-data`

入口与编排见 MMKG-runtime：

- `scripts/teaching/chunks_to_cues.py`
- `scripts/teaching/orchestrate_from_chunks.py`
- `service/mmkg_api/jobs.py`（`lecture_pipeline`）

## 本仓库（VAT-KG）角色

- **离线备份**：保留完整 `teachkg/` + `scripts/teaching/`（含 Stage0），可继续本地跑 `run_teaching_pipeline.py` 等。
- **数据归档**：MMKG 重建后的知识导图可同步回本仓库 `data/viz/<course>/mindmaps/`。

```bash
# 在 VAT-KG 仓库根
python -m scripts.teaching.sync_mindmaps_from_mmkg

# 或在 MMKG-runtime
python -m scripts.teaching.push_mindmaps_to_vatkg
```

不负责交学伴 ingest 触发；展示主站以 MMKG-runtime `web/teachkg-showcase` 为准。
