import {
  layoutPackedMindmap,
  type PackedInput,
} from "./packedMindmapLayout.mjs";
self.onmessage = (event: MessageEvent<PackedInput>) => {
  try {
    self.postMessage({ layout: layoutPackedMindmap(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
