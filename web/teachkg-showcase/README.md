# TeachKG Showcase

统一前端：流水线构建过程、会话融合、讲次 / 课程 KG·MMKG。

## 环境

- Node 18+
- 仓库内已有 `data/viz/{course}/pipeline_build_*.json` 与 `data/kg/{course}/...`

## 启动

```bash
cd web/teachkg-showcase
npm install
# 仓库根目录先导出重要性展示数据（可选但推荐）
# python scripts/teaching/export_importance_showcase.py
npm run sync-data   # 生成 public/data/manifest.json 并复制 pipeline / importance JSON
npm run dev
```

浏览器打开终端提示的本地地址（默认 http://localhost:5173 ）。

`npm run dev` / `build` 会自动先跑 `sync-data`（见 `predev` / `prebuild`）。

## 刷新数据

重新导出流水线展示后同步：

```bash
# 仓库根目录
python scripts/teaching/export_pipeline_showcase.py --course-id 数理逻辑 --lecture-id 1
python scripts/teaching/export_pipeline_showcase.py --course-id 数理逻辑 --session-lectures 1 2
python scripts/teaching/export_importance_showcase.py
python scripts/teaching/build_assets_library.py --course-id 数理逻辑

cd web/teachkg-showcase
npm run sync-data
```

课程默认 `数理逻辑`，可用环境变量覆盖：

```bash
TEACHKG_COURSE=数理逻辑 npm run sync-data
```

## 路由

| 路径 | 说明 |
|------|------|
| `/` | 目录首页 |
| `/importance` | 实体重要性：课程全局 / 分讲次 / 目录对照 |
| `/pipeline/:stem` | 如 `lecture_1`、`session_1_2` |
| `/kg/course?source=kg\|mmkg` | 课程级图谱 |
| `/kg/lecture/:id?source=kg\|mmkg` | 讲次图谱 |

媒体与 KG 原文件经 Vite 中间件挂载为 `/repo-data/...`（指向仓库 `data/`）。

## 与旧 HTML 的关系

`web/pipeline-showcase/index.template.html` 与 `data/viz/*.html` 仍可作离线备份；本应用以 JSON + React 为准。
