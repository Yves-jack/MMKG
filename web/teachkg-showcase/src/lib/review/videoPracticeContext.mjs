const clean = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const label = (point) => String(point.zh || point.id.split("/")[0]).trim();

function concepts(points) {
  const seen = new Set();
  return points.filter((point) => {
    if (!point?.id || seen.has(point.id) || /^(?:__|chapter:|part:)/.test(point.id)) return false;
    seen.add(point.id);
    return true;
  }).map((point) => ({ id: point.id, zh: label(point) }));
}

/** Explicit user intent first; otherwise inspect subtitles strictly at or before the playhead. */
export function resolveVideoPracticeContext({ selected, search = "", catalog = [], points = [], captions = [], sec }) {
  if (selected?.id) return { source: "selection", points: [{ id: selected.id, zh: label(selected) }] };
  const available = concepts([...points, ...catalog]);
  const needle = clean(search);
  if (needle) {
    const exactId = available.find((point) => clean(point.id) === needle);
    const names = available.filter((point) => clean(point.zh) === needle || clean(point.id.split("/")[0]) === needle);
    const match = exactId || (names.length === 1 ? names[0] : null);
    if (match) return { source: "search", points: [match] };
  }
  if (!Number.isFinite(sec) || sec < 0) return null;
  const previous = captions.filter((caption) => Number.isFinite(caption.start) && caption.start >= 0 && caption.start <= sec)
    .slice().sort((a, b) => b.start - a.start);
  for (const caption of previous) {
    const text = clean(caption.text);
    if (!text) continue;
    const matches = [];
    for (const point of available) {
      const names = [...new Set([point.zh, point.id.split("/")[0]])].map(clean).filter((name) => name.length >= 2);
      for (const name of names) {
        const start = text.indexOf(name);
        if (start >= 0) matches.push({ point, start, end: start + name.length });
      }
    }
    // Prefer a full concept over a shorter name contained in the same mention.
    const specific = matches.filter((match) => !matches.some((other) =>
      other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start));
    specific.sort((a, b) => a.start - b.start || b.end - a.end);
    const ids = new Set();
    const hits = specific.filter(({ point }) => !ids.has(point.id) && ids.add(point.id)).map(({ point }) => point);
    if (hits.length) return { source: "subtitle", points: hits, captionStart: caption.start };
  }
  return null;
}

/** Only officially matched practice IDs cross the iframe boundary, never a question's unrelated KP. */
export async function buildVideoPracticeResource(context, courseId, matchPoint) {
  const rows = await Promise.all(context.points.map(async (point) => {
    const result = await matchPoint(point);
    const match = result?.match?.matched_knowledge_points?.find((row) => typeof row.id === "string" && row.id.trim());
    return match ? { id: match.id.trim(), zh: String(match.content || point.zh).trim() } : null;
  }));
  const matched = rows.filter(Boolean);
  if (!matched.length) throw new Error("未找到对应的练习知识点，请选择具体知识点后重试");
  const ids = [...new Set(matched.map((point) => point.id))];
  return {
    resource_type: "exercise", resource_id: ids[0], course_id: courseId,
    title: "按当前知识点练习", knowledge_point_ids: ids,
    metadata: {
      course_id: courseId, practice_mode: "knowledge_point",
      knowledge_point_id: ids[0], seed_knowledge_point_id: ids[0], knowledge_point_ids: ids,
      seed_knowledge_point_label: matched[0].zh,
      context_source: context.source,
      ...(context.captionStart !== undefined ? { subtitle_start_sec: context.captionStart } : {}),
    },
  };
}
