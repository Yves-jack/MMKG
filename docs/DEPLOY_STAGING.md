# MMKG Staging 部署（按交接文档）

依据 [MMKG交接文档](https://app.notion.com/p/MMKG-cb63827deb42832dbebe011d72722d35)。

本机 `MMKG-runtime` 用于本地调试与 Canvas 嵌入联调；**对外验收优先 Staging**。宿主机 Nginx **不改**；用 MMKG 承接旧 KG 的端口合同。

## 端口与入口（Staging）

| 项 | 约定 |
|----|------|
| 部署目录 | `/home/kg/staging/MMKG` |
| 前端宿主机端口 | **5900** |
| 后端宿主机端口 | **8002** |
| 浏览器入口 | `https://dlc.sjtu.edu.cn/staging/kg/` |
| 浏览器 API 前缀 | `/staging/kg-api` → 后端 `/api/...` |
| AI-Teaching 调后端 | `http://dlc.sjtu.edu.cn:8002/api`（或交接约定的服务域名） |

调用链：浏览器 → 宿主机 Nginx `/staging/` → AI-Teaching 网关 → `*:5900` / `*:8002`。

生产对照（暂不先动）：目录 `/home/kg/deploy/MMKG`，前端 **5901**、后端 **8001**，入口 `https://dlc.sjtu.edu.cn/kg/`。

## 上机步骤（停旧 → 同目录换新）

在 **KG 宿主机**（文档中的 `/home/kg` 所在机）执行：

```bash
# 1) 看清旧服务（名称因环境而异，以实际 docker ps / compose 为准）
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' | grep -E 'kg|5900|8002' || true
ls -la /home/kg/staging/

# 2) 停旧 KG（示例：旧项目若在 /home/kg/staging/Knowledge-Graph 或同目录其它名）
#    先进入旧目录 down，再备份
cd /home/kg/staging/<旧KG目录>
docker compose down || docker-compose down || true
cd /home/kg/staging
mv <旧KG目录> <旧KG目录>.bak.$(date +%Y%m%d)   # 保留旧目录作备份

# 3) 放入 MMKG（目录名必须为 MMKG）
#    若仓库已在别处 clone，可 rsync；否则 git clone
mkdir -p /home/kg/staging
# 示例：从本机 push 后
#   rsync -az --delete ./MMKG-runtime/ user@host:/home/kg/staging/MMKG/
cd /home/kg/staging/MMKG

# 4) 环境文件（不要提交 git）
cp .env.staging.example .env   # 或按交接填写
# 必填：MMKG_JWT_SECRET、VIDEO_SEARCH_INGEST_TOKEN
# 公钥挂载：/home/canvas/deploy/key/public.pem（若密钥在 canvas 机，需可访问路径或拷贝到本机）

# 5) 启动（Staging 发布编排：5900 + 8002 + 兼容网关）
docker compose \
  -f docker-compose.yml \
  -f docker-compose.staging.yml \
  -f docker-compose.staging.publish.yml \
  --env-file .env \
  up -d --build

# 6) 健康检查
curl -sS http://127.0.0.1:8002/api/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5900/staging/kg/
```

## Chunk → 后续流水线冒烟

VideoSearch 索引完成后会 `POST` chunk（见 PR #125 / 全量链接文档）：

```http
POST http://<MMKG服务域名>:8002/api/v1/courses/92311/video-chunks
Authorization: Bearer <VIDEO_SEARCH_INGEST_TOKEN>
Content-Type: application/json

{
  "chunks": [{
    "segment_id": "smoke-1",
    "lesson_id": "1",
    "video_id": "1",
    "asr_text": "今天我们学习集合。",
    "text": "今天我们学习集合。",
    "start_sec": 0,
    "end_sec": 10,
    "link": "https://example.com/v"
  }]
}
```

期望：`202`，响应含 `extraction_job` / 子任务 `lecture_pipeline`；再用：

```bash
curl -sS http://127.0.0.1:8002/api/v1/jobs/<job_id>
# 或查看课程状态里的 lecture_pipeline
```

确认 `chunks_to_cues` → Stage1… 有进度（LLM 密钥需在 `.env` 配好）。

## 密钥（交接约定）

| 用途 | 主机路径 | 容器 |
|------|----------|------|
| 验签公钥 | `/home/canvas/deploy/key/public.pem` | `JXB_PUBLIC_KEY_PATH=/tmp/key/public.pem` |
| MMKG JWT | 部署方自管 | `MMKG_JWT_SECRET` |
| VideoSearch ingest | 与 VideoSearch 同值 | `VIDEO_SEARCH_INGEST_TOKEN` |
| 教师映射 | `/home/kg/staging-data/teacher_info.csv` 等 | `MMKG_TEACHER_INFO=/data/teacher_info.csv` |

## 注意

- **不要改**宿主机 Nginx；路径前缀由 AI-Teaching 网关与 MMKG 兼容层（`kg-frontend` / Vite `base`）承接。
- MMKG **不必**加入 `staging-runtime` 共享网（交接文档）；当前 compose 若已 `external: true` 的 network，按服务器是否已有该网络调整，或以 publish 文件中的独立网为准。
- 本机 Windows 调试仍用 [`本地交学伴调试清单.md`](../../本地交学伴调试清单.md)，不要误在本机跑生产 compose。
