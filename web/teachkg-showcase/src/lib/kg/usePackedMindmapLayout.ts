import { useEffect, useMemo, useState } from "react";
import type { PackedInput, PackedLayout } from "./packedMindmapLayout.mjs";

const cache = new Map<string, PackedLayout>();
/** Beam search runs off the UI thread; reopening a known fold state reuses its geometry. */
export function usePackedMindmapLayout(input: PackedInput, enabled = true) {
  const key = useMemo(
    () =>
      JSON.stringify(
        input.records.map((record) => [
          record.key,
          record.node.zh,
          record.children,
          record.spec,
          (record.node as { __hasChildren?: boolean }).__hasChildren,
          (record.node as { __open?: boolean }).__open,
        ]),
      ),
    [input],
  );
  const [state, setState] = useState<{
    key: string;
    layout?: PackedLayout;
    error?: string;
  }>({ key: "" });
  useEffect(() => {
    if (!enabled) return;
    const cached = cache.get(key);
    if (cached) {
      setState({ key, layout: cached });
      return;
    }
    const worker = new Worker(
      new URL("./packedMindmapLayout.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (
      event: MessageEvent<{ layout?: PackedLayout; error?: string }>,
    ) => {
      if (event.data.layout) {
        cache.set(key, event.data.layout);
        if (cache.size > 8) cache.delete(cache.keys().next().value!);
      }
      setState({ key, ...event.data });
      worker.terminate();
    };
    worker.onerror = () => setState({ key, error: "子树布局计算失败，请重试" });
    worker.postMessage(input);
    return () => worker.terminate();
  }, [key, enabled]);
  return state.key === key ? state : { key };
}
