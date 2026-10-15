/** 资源库人工编辑：写回 assets_library.json */

import type { AssetCard, AssetsLibrary } from "@/lib/kg/assetsLibrary";
import { withBase } from "@/lib/withBase";

export async function saveAssetsLibrary(
  courseId: string,
  library: AssetsLibrary
): Promise<AssetsLibrary> {
  const q = new URLSearchParams({ courseId });
  const res = await fetch(withBase(`/api/assets-library?${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId, library }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `save assets-library failed: ${res.status}`);
  }
  const data = await res.json();
  return (data?.library || library) as AssetsLibrary;
}

export function patchCardInLibrary(
  library: AssetsLibrary,
  assetId: string,
  patch: Partial<AssetCard>
): AssetsLibrary {
  const cards = (library.cards || []).map((c) =>
    c.asset_id === assetId ? { ...c, ...patch, asset_id: assetId } : c
  );
  return { ...library, cards, card_count: cards.length };
}

export function removeCardFromLibrary(
  library: AssetsLibrary,
  assetId: string
): AssetsLibrary {
  const cards = (library.cards || []).filter((c) => c.asset_id !== assetId);
  return { ...library, cards, card_count: cards.length };
}
