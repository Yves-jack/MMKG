import type { Network } from "vis-network";

export type VisNetworkExportOptions = {
  /** 相对当前视口的像素倍率，默认 3（高清） */
  scale?: number;
  filename?: string;
  /** 画布底色；默认深色主题底 */
  background?: string;
};

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

/**
 * 将 vis-network 当前视口导出为高清 PNG（放大画布并同比放大 scale 后重绘，避免简单拉伸发糊）。
 */
export async function exportVisNetworkPng(
  network: Network,
  host: HTMLElement,
  opts: VisNetworkExportOptions = {}
): Promise<boolean> {
  const factor = Math.max(1, Math.min(4, Math.round(opts.scale ?? 3)));
  const background = opts.background || "#0b1220";
  const filename = opts.filename || `kg-export-${Date.now()}.png`;

  const w = Math.round(host.clientWidth);
  const h = Math.round(host.clientHeight);
  if (w < 16 || h < 16) return false;

  const viewScale = network.getScale();
  const viewPos = network.getViewPosition();
  const canvas = (network as unknown as { canvas?: { frame?: { canvas?: HTMLCanvasElement } } })
    .canvas?.frame?.canvas;
  if (!canvas) return false;

  const prevOverflow = host.style.overflow;
  const prevOpacity = host.style.opacity;
  host.style.overflow = "hidden";
  host.style.opacity = "0";

  try {
    network.setSize(`${w * factor}px`, `${h * factor}px`);
    network.moveTo({
      position: viewPos,
      scale: viewScale * factor,
      animation: false,
    });
    network.redraw();

    await new Promise<void>((resolve) => {
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
        window.setTimeout(done, 160);
      } catch {
        resolve();
      }
    });

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(canvas, 0, 0);

    const blob = await canvasToPngBlob(exportCanvas);
    if (!blob) return false;
    downloadBlob(blob, filename);
    return true;
  } finally {
    try {
      network.setSize(`${w}px`, `${h}px`);
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
  }
}
