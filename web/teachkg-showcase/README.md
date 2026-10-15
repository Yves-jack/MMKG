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


### 掌握思维导图：个人与班级均值

- 学生原有课程图谱入口继续显示个人掌握思维导图；首页通过同一 `/mindmap` 页面嵌入，使用 `mastery_view=1&compact=1`。
- 掌握度接口按已验证的签名身份决定范围：学生只读本人；助教/教师只读当前课程在读学生的匿名均值。班级分母为当前 Canvas 在读学生数，未记录学生按 0 计，不纳入助教练习记录。
- `knowledge_points` 提供数据库 ID 与完整知识点名称的对应关系；导图按 ID 或唯一中文名称绑定，不做模糊匹配。0 分与无记录分别显示，颜色由薄弱的红色过渡至已掌握的绿色，掌握越高圆点越小。
- 保留原始树结构的逐节点 +/−、双击和键盘展开/收起，顶栏可逐层或全部展开。折叠按原始节点路径记录，百分比筛选不会改写知识点身份。


### ZIP 参考项目的子树空间优化布局

布局源为用户提供的 `business-handoff-color-only.zip`，SHA-256 为 `48ba4fcd86527e52c1fa0a483b2fd13ecb65345164777e99f4dd90ee871a070e`。`src/lib/kg/packedMindmapLayout.mjs` 移植其中 `business-handoff/layout.py` 的算法：

- `blocks` / `leaf_rows`：混合子节点中超过四个叶节点进入两列布局；按实际字体测量和换行计算矩形尺寸。
- `needed` / `Layout.subtree`：测量并布置整棵子树，保留节点层级与次序。
- `chapter_plan`：以真实节点矩形轮廓装箱，章节可利用前一子树的空隙；保留原版偏移候选、200 状态束搜索、首章锚点多样性、阅读顺序与右侧前向约束。
- 按装箱后的树高选择左右分支并叠放短分支；连线采用原版候选曲线和碰撞检测。

集成差异仅涉及交互数据与掌握度控件：以原始路径区分重复 ID，不采用参考导出器的跨章节点合并；将分数圆点和折叠按钮纳入矩形宽度并避免挤占父分支。折叠或筛选后重新装箱，分数更新不会触发无关布局计算。

束搜索在 Web Worker 中执行，重复展开状态复用最近的布局。`fixtures/zipPackedLayout.golden.json` 的预期结果由原 ZIP 的 Python `chapter_plan` 独立执行生成；测试同时检查整课展开与折叠状态的节点完整性及矩形不重叠。


掌握导图仅保留显示比例控件；逐节点加减号、双击和键盘展开折叠、滚轮缩放、拖动仍可使用。仪表盘紧凑模式的详情改为选中后浮层显示，画布不再因详情挤压。个人视图以紫色箭头连接低于 2.5 的已记录节点（含 0 分）；按原始分册/章节顺序逐章遍历，章内广度优先从根到叶，仅连接当前可见圆点。全班平均视图不生成个人学习路径。掌握圆点扩大最小半径、强化分数对比，节点文字的字号、折行宽度与 ZIP 子树布局保持不变。
