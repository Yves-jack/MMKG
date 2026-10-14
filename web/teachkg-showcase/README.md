# TeachKG Showcase

统一前端：流水线构建过程、会话融合、讲次 / 课程 KG·MMKG。

> **主运行时在 [MMKG-runtime](../../MMKG-runtime)**：交学伴 video-chunks 自动构建与对外展示以 MMKG 为准。本仓库保留离线流水线备份与导图归档；分工说明见 [`docs/mmkg_runtime_handoff.md`](../../docs/mmkg_runtime_handoff.md)。

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

## 学生掌握思维导图

AI-Teaching 现有 iframe 路径 `/course/:courseId/kg/course?embed=ai-teaching` 保持不变。仅当 MMKG 登录确认 `kg_token` 属于学生时展示整课掌握思维导图；教师和助教仍使用原课程图谱。学生导图数据为 `public/data/courses/离散数学(图论+数理逻辑与集合论)/mindmaps/student_mastery_course.json`，保留原始整课导图文件不变。

掌握分数通过前端同源 `GET /api/student-mastery?course_id=<Canvas 课程 ID>` 读取。Vite 服务端把请求及 `X-KG-Token` 转发到 `AI_TEACHING_API_URL/api/knowledge-links/courses/<课程 ID>/mastery`；AI-Teaching 端须先部署对应的只读接口。若接口不可用，页面明确提示且以「暂无记录」显示，不伪造分数。staging 的 `AI_TEACHING_API_URL` 必须指向 staging AI-Teaching，不能继承生产地址。

学生可按 0–100% 调整节点显示数量。筛选保留层级、根节点及已选节点路径，在主分支间按原始节点数量分配显示名额，并在各分支内优先保留学习中的薄弱节点；`__lecture__` 节点不计入展示和比例。导图沿用上传 ZIP 的原始 `zh`，以便与既有掌握分数对齐；其中少量结构性 `id` 与 `zh` 名称不一致，需在上游数据中另行校正，不能只改显示名称。

## 与旧 HTML 的关系

`web/pipeline-showcase/index.template.html` 与 `data/viz/*.html` 仍可作离线备份；本应用以 JSON + React 为准。
