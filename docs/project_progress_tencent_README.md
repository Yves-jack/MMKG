# 导入腾讯文档说明

目标表格：[VAT-KG 项目进展](https://docs.qq.com/sheet/DRVVjSUFQUW5UakF0?tab=BB08J2)

## 导入步骤

1. 打开上述腾讯文档链接（需登录 QQ/微信）
2. 选中工作表 **BB08J2**（或新建三个 sheet）
3. 菜单 **文件 → 导入 → 本地文件**
4. 选择同目录下的 `project_progress_tencent.csv`（UTF-8 带 BOM，Excel/腾讯文档兼容）
5. 导入方式建议：
   - **Sheet1**：第 1–25 行 → 「项目进展时间线」
   - **Sheet2**：RAG 评测演进（5 行）
   - **Sheet3**：待办与规划（5 行）
6. 导入后可调整列宽、冻结首行、按「模块」筛选

## 文件说明

| 文件 | 内容 |
|------|------|
| `project_progress_tencent.csv` | 25 条进展 + 5 条评测案例 + 5 条待办 |
| 本 README | 导入指引 |

## 当前快照（2026-07-13）

- **仓库**：https://github.com/Yves-jack/MMKG
- **课程**：数理逻辑（数理逻辑）
- **流水线**：Stage0 ASR → Stage1 三元组/教材混合 → Stage2 KG → Stage3 MMKG → RAG
- **RAG 评测（18 题）**：hit 100% · supported 88.9% · unsupported 2（q4 合取真值表、q12 析取）
- **CI**：teaching-smoke #3 success（120 本地 / 17 CI smoke）
