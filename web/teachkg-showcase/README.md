# TeachKG Showcase

四块展示：单课复习、课堂知识图谱、知识导图、资产库。

## 启动

```bash
cd web/teachkg-showcase
npm install
npm run sync-data   # 从仓库根 data/kg、data/viz 生成 public/data
npm run dev         # 默认 http://127.0.0.1:5174
```

`npm run dev` / `build` 会先跑 `sync-data`（`predev` / `prebuild`）。

课程默认可用环境变量覆盖：

```bash
TEACHKG_COURSE="离散数学(图论+数理逻辑与集合论)" npm run sync-data
```

## 路由（课内）

| 路径 | 说明 |
|------|------|
| `/course/:id` | 课门户 |
| `/course/:id/apps/review/:lectureId` | 单课复习 |
| `/course/:id/kg/course` | 课堂知识图谱 |
| `/course/:id/mindmap` | 知识导图 |
| `/course/:id/assets/:lectureId` | 资产库 |

离线构建与导出脚本已移出本仓库（见 VAT-KG）。
