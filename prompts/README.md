# TeachKG 提示词目录

按流水线 **Stage** 分目录管理。代码里用相对路径加载，例如 `stage1/subgraph_extract.txt`。  
旧路径（如 `teaching/...`、`asr_correct.txt`）仍可通过 `teachkg.utils.prompts` 的别名解析。

## 目录结构

```
prompts/
  stage0/     Stage 0 切片 / ASR 校对
  stage1/     Stage 1 文本预处理 / 三元组抽取与校验
  stage3/     Stage 3–5 MMKG（实体描述等）
  rag/        下游问答 / 测验（非编号 Stage）
  _archive/   已停用或遗留模板（勿在新代码中引用）
```

## 清单

| Stage | 文件 | 用途 | 主要调用 |
|-------|------|------|----------|
| **0** | `stage0/asr_correct.txt` | 多模态 ASR 校对 | `stage0_segmentation/multimodal_correct.py` |
| **1** | `stage1/cue_text_preprocess.txt` | cue 文本 LLM 精炼（可选） | `stage1_alignment/text_preprocess.py` |
| **1** | `stage1/seed_filter.txt` | 子图扩展前种子 LLM 筛选（可选） | `textbook_kg/seed_filter.py` |
| **1** | `stage1/edge_filter.txt` | 规则剪枝后边 LLM 筛选（可选） | `textbook_kg/edge_filter.py` |
| **1** | `stage1/subgraph_extract.txt` | 纯 LLM 三元组抽取 | `triplet_extract.py` |
| **1** | `stage1/subgraph_hybrid_extract.txt` | 教材子图约束下增量抽取 | `triplet_extract.py` |
| **1** | `stage1/subgraph_hybrid_extract_complete.txt` | 单段增量抽全补漏 | `triplet_extract.py` |
| **1** | `stage1/subgraph_cross_cue_extract.txt` | 字数窗跨段隐含关系（无 context） | `triplet_extract.py` |
| **1** | `stage1/subgraph_extract_retry.txt` | 抽取重试（备用） | 配置可选 |
| **1** | `stage1/triplet_validate.txt` | 三元组校验 | `triplet_extract.py` |
| **1** | `stage1/triplet_fix.txt` | 校验失败后修复 | `triplet_extract.py` |
| **1** | `stage1/triplet_reextract.txt` | 单条重抽 | `triplet_extract.py` |
| **3** | `stage3/entity_define.txt` | 实体描述生成（MMKG Stage4 步） | `stage3_mmkg/entity_describe.py` |
| **RAG** | `rag/mmkg_rag.txt` | 多模态图谱问答 | `rag/mmkg_rag.py` |
| **RAG** | `rag/rag_answer_check.txt` | 答句质检 | `rag/answer_checker.py` |
| **RAG** | `rag/quiz_generate.txt` | 测验题生成 | `rag/quiz_generator.py` |

配置入口：`configs/teaching.yaml` 中各 stage 的 `prompt:` 字段。

## 约定

1. 新提示词必须放在对应 stage 目录，文件名用小写 + 下划线。
2. 模板占位符用 `{name}`；字面量花括号写成 `{{` / `}}`。
3. 不要把密钥或课程私有数据写进 prompt 文件。
4. 废弃模板移入 `_archive/`，并在本表删除或标注停用。
