/** 搜索候选按中文名去重，避免「图论」「图论/graph theory」等多条同义项。 */

export function zhEntityKey(raw: string): string {
  return String(raw || "")
    .split("/")[0]
    .trim()
    .toLowerCase();
}

export function dedupeEntityMatchesByZh<T extends { label: string; score?: number; id?: string }>(
  items: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = zhEntityKey(item.label) || zhEntityKey(String(item.id || ""));
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, item);
      continue;
    }
    const prevScore = Number(prev.score) || 0;
    const nextScore = Number(item.score) || 0;
    if (nextScore > prevScore) byKey.set(key, item);
  }
  return [...byKey.values()];
}
