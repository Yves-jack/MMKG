# Pipeline Showcase

分步展示 TeachKG / VAT-KG 知识图谱构建过程（课堂口述 → 预处理 → 种子 → 教材子图 → 增量 → 融合），并附带多模态证据窗口（切片视频 + PPT/板书帧）。

## 生成

```bash
python scripts/teaching/export_pipeline_showcase.py --course-id 数理逻辑 --lecture-id 1
```

输出：

- `data/viz/{course}/pipeline_build_lecture_{id}.html`
- `data/viz/{course}/pipeline_build_lecture_{id}.json`

模板：`web/pipeline-showcase/index.template.html`

## 使用

用浏览器打开生成的 HTML。若本地 `file://` 下视频受限，可在仓库根目录起静态服务：

```bash
python -m http.server 8765
```

然后访问：

`http://localhost:8765/data/viz/数理逻辑/pipeline_build_lecture_1.html`

快捷键：`←` / `→`（或空格）切换步骤；可「自动播放」。
