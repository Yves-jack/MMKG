/**
 * 导图画布 DOM → 高清 PNG（与 exportVisNetworkPng 对称；不依赖 vis-network）。
 * 使用 SVG foreignObject 栅格化当前视口内的画布节点。
 */

export type MindmapExportOptions = {
  /** 相对像素倍率，默认 2 */
  scale?: number;
  filename?: string;
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

function inlineComputedStyles(source: HTMLElement, target: HTMLElement) {
  const walk = (from: Element, to: Element) => {
    if (!(from instanceof HTMLElement) || !(to instanceof HTMLElement)) return;
    const cs = window.getComputedStyle(from);
    let css = "";
    for (let i = 0; i < cs.length; i++) {
      const prop = cs.item(i);
      if (!prop) continue;
      css += `${prop}:${cs.getPropertyValue(prop)};`;
    }
    to.setAttribute("style", css);
    const fc = Array.from(from.children);
    const tc = Array.from(to.children);
    for (let i = 0; i < fc.length && i < tc.length; i++) walk(fc[i], tc[i]);
  };
  walk(source, target);
}

/**
 * 导出 mindmap 画布元素为 PNG。
 * @param host 通常为带 data-mind-viewport 或 .canvas 的容器
 */
export async function exportMindmapPng(
  host: HTMLElement,
  opts: MindmapExportOptions = {}
): Promise<boolean> {
  const factor = Math.max(1, Math.min(3, Math.round(opts.scale ?? 2)));
  const background = opts.background || "#0b1220";
  const filename = opts.filename || `mindmap-export-${Date.now()}.png`;

  const w = Math.max(host.scrollWidth, host.clientWidth, 16);
  const h = Math.max(host.scrollHeight, host.clientHeight, 16);

  const clone = host.cloneNode(true) as HTMLElement;
  inlineComputedStyles(host, clone);
  clone.style.margin = "0";
  clone.style.transform = "none";
  clone.style.position = "static";
  clone.querySelectorAll("[data-mind-edit],[data-mind-zoom]").forEach((el) => el.remove());

  const serializer = new XMLSerializer();
  const xhtml = serializer.serializeToString(clone);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:${background};">
      ${xhtml}
    </div>
  </foreignObject>
</svg>`;

  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("svg rasterize failed"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * factor);
    canvas.height = Math.round(h * factor);
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(factor, factor);
    ctx.drawImage(img, 0, 0);
    const blob = await canvasToPngBlob(canvas);
    if (!blob) return false;
    downloadBlob(blob, filename);
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}
