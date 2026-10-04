# VAT-KG 代码复现

基于论文 **VAT-KG: Knowledge-Intensive Multimodal Knowledge Graph Dataset for Retrieval-Augmented Generation** (arXiv:2506.21556) 的完整代码复现。

官方 HuggingFace 仓库 (`vatkg/VATKG_CODE`) 当前无法直接克隆，本仓库依据论文正文与附录 (Section C) 重新实现。

## 项目结构

```
MMKG/
├── configs/default.yaml          # 超参数（与论文一致）
├── prompts/                      # LLM / RAG 提示词模板（论文 Fig. 7-11）
├── data/                         # 数据目录（留空，需自行准备）
│   ├── raw/                      # 原始多模态语料
│   ├── processed/                # 流水线中间结果
│   ├── kg/                       # 最终 VAT-KG
│   ├── index/                    # FAISS 向量索引
│   └── qa/                       # QA 评测集
├── vatkg/
│   ├── construction/             # 四阶段构建流水线
│   ├── rag/                      # 多模态 RAG 框架
│   ├── models/                   # CLAP / ViCLIP / LLM 封装
│   ├── utils/
│   └── evaluation/
└── scripts/                      # 命令行入口
```

## 论文方法对应关系

| 论文章节 | 模块 | 代码路径 |
|---------|------|---------|
| Stage 1 多模态对齐过滤 | Voice-over / CLAP / ViCLIP | `vatkg/construction/stage1_alignment.py` |
| Stage 2 知识密集型重写 | DeepSeek-R1-Distill-Llama-70B | `vatkg/construction/stage2_recaption.py` |
| Stage 3 三元组接地 | LLM + ViCLIP 选最优三元组 | `vatkg/construction/stage3_triplet.py` |
| Stage 4 跨模态描述对齐 | Wikipedia/Wiktionary/LLM | `vatkg/construction/stage4_description.py` |
| RAG 检索 | FAISS + 模态无关检索 | `vatkg/rag/retrieval.py` |
| Retrieval Checker | 二次语义校验 | `vatkg/rag/checker.py` |
| 增强生成 | MLLM 提示注入 | `vatkg/rag/generation.py` |

## 环境安装

```bash
cd D:\Yves\MMKG
pip install -r requirements.txt
```

> **注意**：完整运行需要 GPU（论文使用 H100）。70B LLM 体积很大，可按需替换为更小模型或 API。

## 数据准备（留空占位）

### 1. 原始语料 `data/raw/corpus.jsonl`

每行一条 JSON，示例字段：

```json
{
  "id": "sample_001",
  "caption": "A helicopter flies over a bridge.",
  "video_path": "data/raw/videos/sample_001.mp4",
  "audio_path": "data/raw/audio/sample_001.wav",
  "youtube_id": "xxxxxxxxxxx",
  "youtube_title": "Bridge accident news",
  "youtube_description": "A helicopter flies over a bridge in Queens...",
  "dataset": "audiocaps"
}
```

论文使用的源数据集：InternVid-FLT (10%)、AudioCaps、AVQA、VALOR-32k。

### 2. VAT-KG 输出 `data/kg/vatkg.jsonl`

构建完成后每条包含：`head`, `relation`, `tail`, `head_description`, `tail_description`, 多模态路径及 embedding。

### 3. QA 评测 `data/qa/<benchmark>.jsonl`

```json
{
  "id": "qa_001",
  "modality": "av",
  "question": "What is shown in the video?",
  "video_path": "...",
  "audio_path": "...",
  "answer": "Earth digging by excavator"
}
```

## MMKG 服务与 AI-Teaching 集成

MMKG 是教学知识图谱的唯一运行时。`service/mmkg_api` 在原有 VAT-KG 构建代码之外统一提供：

- `jxb_login`、`jaccount_login`（并兼容历史拼写 `jaccount_loggin`）和课程级读写权限；
- 节点、关系的增删改查，以及 base/document/video/fused 图谱、配置、覆盖层、PDF 作业等 API；
- `POST /api/v1/courses/{course_id}/video-chunks` 接收 VideoSearch chunk，生成动态图谱和视频锚点；
- `GET /api/v1/courses/{course_id}/knowledge-points` 一次返回课程全部知识节点；
- `web/teachkg-showcase` iframe 直接读取、编辑 MMKG 实时融合图，并发送
  `kg:graph-ready`（携带全部知识节点）、`kg:node-selected` 和 `kg:open-resource` 事件。

AI-Teaching 仍拥有练习、动画和公式资源关系；MMKG 的服务端中间件仅携带 iframe 的短期签名
`kg_token` 查询这些关系，不保存 AI-Teaching 内部凭据。视频关系、图谱数据和所有图谱 API
均由 MMKG 自己提供，不依赖旧 Knowledge-Graph 项目。

仅使用 debug Compose 调试：

```bash
docker compose -f docker-compose.debug.yml up
```

嵌入 URL 需携带 `course_id`、`kg_token`、`embed=ai-teaching` 和 `parent_origin`；
`parent_origin` 必须与浏览器 referrer 的来源一致。

后端回归测试也必须在 debug 容器执行：

```bash
docker compose -f docker-compose.debug.yml run --rm mmkg-backend python -m pytest
```

### 必需配置

- `MMKG_JWT_SECRET`：MMKG access token 的签名密钥；
- `JXB_PUBLIC_KEY_PATH`：AI-Teaching 签发 `kg_token` 所用 Ed25519 公钥；
- `VIDEO_SEARCH_INGEST_TOKEN`：VideoSearch 写入 chunk 的独立 Bearer token；
- `JACCOUNT_CLIENT_ID`、`JACCOUNT_CLIENT_SECRET`、`JACCOUNT_REDIRECT_URI`：启用 JAccount 时配置；

### 离散数学教材课程

Debug课程92311直接使用项目中的教材图谱，来源目录为
`data/textbook/CS2501-离散数学（数理逻辑与集合论）`，1482个实体、2754条关系。
以实体名称生成稳定ID，保留定义、定理和教材importance；不读取旧Knowledge-Graph数据。

```bash
docker cp "data/textbook/CS2501-离散数学（数理逻辑与集合论）" debug-mmkg-backend:/tmp/mmkg-discrete-textbook
docker exec debug-mmkg-backend python -m scripts.import_textbook --source /tmp/mmkg-discrete-textbook --target /data --course-id 92311
```

已有课程中存在其他来源的图谱时，不要直接混入教材图；需先明确清理范围。
导入器拒绝覆盖其他来源的非空图谱；教材重复导入保持节点ID稳定，并保留已有课程配置。

生产镜像分别以 `/kg/`、`/kg-api` 构建浏览器路径；staging 使用对应覆盖文件构建为
`/staging/kg/`、`/staging/kg-api`：

```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml build
```

## VAT-KG 使用方法

### 快速干跑（无需 GPU / 模型权重）

```bash
python scripts/run_construction.py --corpus data/raw/corpus.jsonl --mock
python scripts/build_faiss_index.py --kg data/processed/vatkg.jsonl
python scripts/run_rag.py --question "What happens in this video?" --modality video --video-path path/to/video.mp4 --mock
```

### 完整构建 VAT-KG

```bash
python scripts/run_construction.py \
  --corpus data/raw/corpus.jsonl \
  --config configs/default.yaml
```

### 构建 FAISS 索引

```bash
python scripts/build_faiss_index.py --kg data/processed/vatkg.jsonl --index-dir data/index
```

### 多模态 RAG 推理

```bash
# Video QA
python scripts/run_rag.py --modality video --video-path ... --question "..."

# Audio QA
python scripts/run_rag.py --modality audio --audio-path ... --question "..."

# Audio-Visual QA（拼接 audio + video embedding）
python scripts/run_rag.py --modality av --audio-path ... --video-path ... --question "..."
```

### 批量评测

```bash
python scripts/run_evaluation.py --qa data/qa/avqa.jsonl --index-dir data/index
```

## 关键超参数（论文 C.1.1）

| 参数 | 值 | 配置项 |
|-----|-----|--------|
| CLAP 音频-文本最低余弦相似度 | 0.2 | `stage1.audio_text_filter.min_cosine_similarity` |
| ViCLIP 视频-文本过滤 | 剔除最低 10% | `stage1.video_text_filter.bottom_percentile` |
| 检索 Top-K | 5 | `rag.top_k` |
| Stage 2/3 LLM | DeepSeek-R1-Distill-Llama-70B | `stage2.llm.model` |
| Stage 4 LLM KB | DeepSeek-R1-Distill-Llama-8B | `stage4.llm_kb.model` |

L2 距离阈值与 Retrieval Checker 阈值论文未明确给出，可在 `configs/default.yaml` 的 `rag` 段调整。

## 引用

```bibtex
@article{park2025vatkg,
  title={VAT-KG: Knowledge-Intensive Multimodal Knowledge Graph Dataset for Retrieval-Augmented Generation},
  author={Park, Hyeongcheol and Seo, Jiyoung and Jang, MinHyuk and Park, Hogun and Baek, Ha Dam and Chang, Gyusam and Im, Hyeonsoo and Kim, Sangpil},
  journal={arXiv preprint arXiv:2506.21556},
  year={2025}
}
```

## 许可证

本复现代码仅供学术研究。VAT-KG 数据集遵循 CC BY-NC 4.0（非商业用途）。
