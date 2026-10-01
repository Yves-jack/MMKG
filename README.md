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

## 使用方法

### AI-Teaching 全量链接调试

`web/teachkg-showcase` 支持作为 AI-Teaching 的知识图谱 iframe：右键知识结点会从
AI-Teaching 查询练习、动画、公式，并从 Knowledge-Graph 查询视频片段。点击资源时通过
`kg:open-resource` `postMessage` 把资源类型和 ID 交给父页面跳转。

只使用 debug Compose 启动展示端：

```bash
docker compose -f docker-compose.debug.yml up
```

中间件只转发并校验短期签名的课程 `kg_token`，不持有 AI-Teaching 内部服务凭据。
嵌入 URL 需携带 `course_id`、`kg_token`、`embed=ai-teaching` 和 `parent_origin`；
`parent_origin` 必须与浏览器 referrer 的来源一致。

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
