import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadManifest, type Manifest, type ManifestItem } from "@/lib/catalog";
import styles from "./Home.module.css";

const MAIN = [
  { type: "importance", kicker: "Importance", title: "实体重要性", desc: "先验 × 课堂融合排序" },
  { type: "mindmap", kicker: "Mindmap", title: "知识导图", desc: "讲次 / 整课树状浏览" },
  { type: "pipeline", kicker: "Pipeline", title: "构建流水线", desc: "口述到图谱分步演化" },
  { type: "kg", kicker: "Graph", title: "知识图谱", desc: "讲次 MMKG · 原文依据 · 多模态" },
  { type: "textbook", kicker: "Textbook", title: "教材知识图谱", desc: "按教材分片查看母图" },
] as const;

export function Home() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadManifest()
      .then(setManifest)
      .catch((e) => setError(String(e.message || e)));
  }, []);

  const byType = useMemo(() => {
    const m = new Map<string, ManifestItem>();
    for (const it of manifest?.items || []) {
      if (it.type === "mmkg") {
        if (!m.has("kg") && it.scope === "lecture") {
          m.set("kg", {
            ...it,
            href: `/kg/lecture/${it.lectureId}`,
            title: "知识图谱",
          });
        }
        continue;
      }
      if (it.type === "kg") {
        // 主入口只用 MMKG；纯 KG 不再作为首页卡片
        continue;
      }
      if (it.type === "pipeline") {
        // 主入口进多讲流水线壳，不绑死某一讲 JSON
        if (!m.has("pipeline")) {
          m.set("pipeline", { ...it, href: "/pipeline", title: "构建流水线" });
        }
        continue;
      }
      if (!m.has(it.type)) m.set(it.type, it);
    }
    if (!m.has("kg")) {
      const anyMm = manifest?.items.find((i) => i.type === "mmkg" && i.scope === "lecture");
      if (anyMm) {
        m.set("kg", {
          ...anyMm,
          href: `/kg/lecture/${anyMm.lectureId}`,
          title: "知识图谱",
        });
      } else {
        m.set("kg", {
          id: "kg_entry",
          type: "kg",
          group: "知识图谱",
          title: "知识图谱",
          href: "/kg/lecture/1",
          dataUrl: "/repo-data/kg/shuliluoji/lecture_1/mmkg.json",
          scope: "lecture",
          source: "mmkg",
        });
      }
    }
    if (!m.has("pipeline")) {
      m.set("pipeline", {
        id: "pipeline_entry",
        type: "pipeline",
        group: "流水线构建",
        title: "构建流水线",
        href: "/pipeline",
        dataUrl: "/data/pipeline/pipeline_build_lecture_1.json",
      });
    }
    if (!m.has("textbook")) {
      m.set("textbook", {
        id: "textbook_entry",
        type: "textbook",
        group: "教材知识图谱",
        title: "教材知识图谱",
        href: "/textbook",
        dataUrl: "/data/textbook_kg_showcase.json",
        scope: "course",
      });
    }
    return m;
  }, [manifest]);

  const extras = useMemo(() => {
    if (!manifest) return [] as { label: string; items: ManifestItem[] }[];
    const pipelines = manifest.items
      .filter((i) => i.type === "pipeline" || i.type === "session")
      .slice()
      .sort(compareShowcaseItems);
    const kgs = manifest.items
      .filter((i) => i.type === "mmkg")
      .slice()
      .sort(compareShowcaseItems);
    return [
      pipelines.length ? { label: "流水线样例", items: pipelines } : null,
      kgs.length ? { label: "图谱样例", items: kgs } : null,
    ].filter(Boolean) as { label: string; items: ManifestItem[] }[];
  }, [manifest]);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>VAT-KG · Teaching Knowledge Graph</p>
          <h1 className={styles.brand}>
            Teach<span>KG</span>
          </h1>
          <p className={styles.lead}>课堂对齐 · 重要性 · 导图 · 图谱 · 教材分片</p>
        </header>

        {error && <p className="empty-hint">{error}</p>}
        {!manifest && !error && <p className="empty-hint">加载目录…</p>}

        <nav className={styles.mainNav} aria-label="主要入口">
          {MAIN.map((m) => {
            const it = byType.get(m.type);
            if (!it) return null;
            return (
              <Link key={m.type} to={it.href} className={styles.mainLink}>
                <span className={styles.kicker}>{m.kicker}</span>
                <span className={styles.title}>{m.title}</span>
                <span className={styles.desc}>{m.desc}</span>
              </Link>
            );
          })}
        </nav>

        {extras.map((block) => (
          <section key={block.label} className={styles.extra}>
            <h2>{block.label}</h2>
            <div className={styles.chips}>
              {block.items.map((it) => (
                <Link key={it.id} to={it.href} className={styles.chip}>
                  {shortTitle(it)}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function lectureNum(it: ManifestItem): number {
  if (it.lectureId != null && String(it.lectureId) !== "") {
    const n = Number(it.lectureId);
    if (!Number.isNaN(n)) return n;
  }
  const fromStem = String(it.stem || "").match(/lecture[_-]?(\d+)/i);
  if (fromStem) return Number(fromStem[1]);
  const fromTitle = String(it.title || "").match(/第?\s*(\d+)\s*讲/);
  if (fromTitle) return Number(fromTitle[1]);
  const any = String(it.stem || it.title || "").match(/(\d+)/);
  return any ? Number(any[1]) : 9999;
}

function compareShowcaseItems(a: ManifestItem, b: ManifestItem) {
  const courseRank = (it: ManifestItem) => (it.scope === "course" ? 0 : 1);
  const cr = courseRank(a) - courseRank(b);
  if (cr) return cr;

  const ln = lectureNum(a) - lectureNum(b);
  if (ln) return ln;

  const typeRank: Record<string, number> = {
    pipeline: 0,
    session: 1,
    kg: 0,
    mmkg: 1,
  };
  const tr = (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9);
  if (tr) return tr;

  const trunc = (it: ManifestItem) =>
    String(it.stem || it.id || "").includes("until") ? 1 : 0;
  const ur = trunc(a) - trunc(b);
  if (ur) return ur;

  const src = String(a.source || "").localeCompare(String(b.source || ""));
  if (src) return src;

  return String(a.title).localeCompare(String(b.title), "zh");
}

function shortTitle(it: ManifestItem) {
  if (it.lectureId) return `L${it.lectureId}${it.source === "mmkg" ? "·MM" : ""}`;
  if (it.scope === "course") return it.source === "mmkg" ? "课程 MMKG" : "课程 KG";
  if (it.type === "session") return it.title.replace(/^会话融合[·\s]*/, "") || it.title;
  if (it.type === "pipeline") {
    const m = it.title.match(/第?\s*(\d+)\s*讲/) || it.stem?.match(/(\d+)/);
    const truncated = String(it.stem || "").includes("until");
    return m ? `${truncated ? "截断 " : ""}L${m[1]}` : it.title.slice(0, 18);
  }
  return it.title;
}
