export type ManifestItem = {
  id: string;
  type:
    | "pipeline"
    | "session"
    | "kg"
    | "mmkg"
    | "importance"
    | "mindmap"
    | "textbook"
    | "assets";
  group: string;
  title: string;
  href: string;
  dataUrl: string;
  stem?: string;
  lectureId?: string;
  source?: "kg" | "mmkg";
  scope?: "lecture" | "course" | "session";
  /** 相邻两讲会话，如 "1_2" */
  sessionId?: string;
  lectureIds?: string[];
};

export type Manifest = {
  courseId: string;
  generatedAt: string;
  items: ManifestItem[];
};

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch("/data/manifest.json");
  if (!res.ok) {
    throw new Error("缺少 manifest.json，请先运行 npm run sync-data");
  }
  return res.json();
}

export function groupItems(items: ManifestItem[]): Record<string, ManifestItem[]> {
  const out: Record<string, ManifestItem[]> = {};
  for (const it of items) {
    (out[it.group] ||= []).push(it);
  }
  return out;
}
