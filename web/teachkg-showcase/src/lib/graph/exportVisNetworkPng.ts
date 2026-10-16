import type { Network } from "vis-network";

export type VisNetworkExportOptions = {
  /** 相对网络坐标的像素倍率，默认 3（高清）；过大图会自动下调以免爆内存 */
  scale?: number;
  filename?: string;
  /**
   * 画布底色；默认 transparent（便于贴到其他界面）。
   * 传实色如 "#fafafa" 可恢复不透明底。
   */
  background?: string;
  /** 包围盒外边距（网络坐标），默认 56 */
  padding?: number;
};

function isTransparentBg(bg: string): boolean {
  const s = bg.trim().toLowerCase();
  return !s || s === "transparent" || s === "rgba(0, 0, 0, 0)" || s === "rgba(0,0,0,0)";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => resolve(b), "image/png");
      return;
    }
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const raw = atob(dataUrl.split(",")[1] || "");
      const arr = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      resolve(new Blob([arr], { type: "image/png" }));
    } catch {
      resolve(null);
    }
  });
}

function waitAfterDrawing(network: Network, ms = 200): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        network.off("afterDrawing", done);
      } catch {
        /* ignore */
      }
      resolve();
    };
    try {
      network.on("afterDrawing", done);
      network.redraw();
      window.setTimeout(done, ms);
    } catch {
      resolve();
    }
  });
}

type GraphBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** 按节点包围盒（含标签）计算整图范围；失败则退回节点中心点。 */
function computeGraphBounds(network: Network): GraphBounds | null {
  let positions: Record<string, { x: number; y: number }>;
  try {
    positions = network.getPositions() as Record<string, { x: number; y: number }>;
  } catch {
    return null;
  }
  const ids = Object.keys(positions);
  if (!ids.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hit = 0;

  for (const id of ids) {
    try {
      const bb = network.getBoundingBox(id);
      if (
        bb &&
        Number.isFinite(bb.left) &&
        Number.isFinite(bb.right) &&
        Number.isFinite(bb.top) &&
        Number.isFinite(bb.bottom)
      ) {
        minX = Math.min(minX, bb.left);
        maxX = Math.max(maxX, bb.right);
        minY = Math.min(minY, bb.top);
        maxY = Math.max(maxY, bb.bottom);
        hit += 1;
        continue;
      }
    } catch {
      /* fall through */
    }
    const p = positions[id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    hit += 1;
  }

  if (!hit || !Number.isFinite(minX) || !(maxX > minX) || !(maxY > minY)) {
    // 单点或退化：给一个最小画布
    if (hit === 1 && Number.isFinite(minX)) {
      return {
        minX: minX - 80,
        minY: minY - 80,
        maxX: maxX + 80,
        maxY: maxY + 80,
      };
    }
    return null;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 将 vis-network **整图**（全部节点包围盒，而非当前屏幕视口）导出为高清 PNG。
 * 临时放大画布并适配中心/缩放后重绘，再恢复用户当前视口。
 */
export async function exportVisNetworkPng(
  network: Network,
  host: HTMLElement,
  opts: VisNetworkExportOptions = {}
): Promise<boolean> {
  const factor = Math.max(1, Math.min(4, Number(opts.scale ?? 3) || 3));
  const background = opts.background ?? "transparent";
  const filename = opts.filename || `kg-export-${Date.now()}.png`;
  const padding = Math.max(16, Number(opts.padding ?? 56) || 56);

  const hostW = Math.round(host.clientWidth);
  const hostH = Math.round(host.clientHeight);
  if (hostW < 16 || hostH < 16) return false;

  const viewScale = network.getScale();
  const viewPos = network.getViewPosition();
  const canvas = (network as unknown as { canvas?: { frame?: { canvas?: HTMLCanvasElement } } })
    .canvas?.frame?.canvas;
  if (!canvas) return false;

  const bounds = computeGraphBounds(network);
  if (!bounds) {
    // 无节点位置时退回：先 fit 再按当前视口导出
    try {
      network.fit({ animation: false });
      await waitAfterDrawing(network, 120);
    } catch {
      /* ignore */
    }
  }

  const bb = bounds ?? (() => {
    // fit 后仍无 bounds：按宿主视口导出（保底）
    return null;
  })();

  let exportW: number;
  let exportH: number;
  let exportScale: number;
  let center: { x: number; y: number };

  if (bb) {
    const graphW = Math.max(64, bb.maxX - bb.minX + padding * 2);
    const graphH = Math.max(64, bb.maxY - bb.minY + padding * 2);
    center = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };

    // 硬顶避免超大图 OOM；优先保边长
    const maxDim = 8192;
    exportScale = factor;
    exportW = Math.ceil(graphW * exportScale);
    exportH = Math.ceil(graphH * exportScale);
    if (exportW > maxDim || exportH > maxDim) {
      exportScale = Math.min(maxDim / graphW, maxDim / graphH);
      exportW = Math.max(64, Math.ceil(graphW * exportScale));
      exportH = Math.max(64, Math.ceil(graphH * exportScale));
    }
  } else {
    // 保底：当前视口高清
    center = { ...viewPos };
    exportScale = viewScale * factor;
    exportW = Math.round(hostW * factor);
    exportH = Math.round(hostH * factor);
  }

  const prevOverflow = host.style.overflow;
  const prevOpacity = host.style.opacity;
  const prevPointer = host.style.pointerEvents;
  host.style.overflow = "hidden";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";

  try {
    network.setSize(`${exportW}px`, `${exportH}px`);
    network.moveTo({
      position: center,
      scale: exportScale,
      animation: false,
    });
    network.redraw();
    await waitAfterDrawing(network, 220);

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width || exportW;
    exportCanvas.height = canvas.height || exportH;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return false;
    ctx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
    if (!isTransparentBg(background)) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    }
    ctx.drawImage(canvas, 0, 0);

    const blob = await canvasToPngBlob(exportCanvas);
    if (!blob) return false;
    downloadBlob(blob, filename);
    return true;
  } finally {
    try {
      network.setSize(`${hostW}px`, `${hostH}px`);
      network.moveTo({
        position: viewPos,
        scale: viewScale,
        animation: false,
      });
      network.redraw();
    } catch {
      /* ignore */
    }
    host.style.overflow = prevOverflow;
    host.style.opacity = prevOpacity;
    host.style.pointerEvents = prevPointer;
  }
}
