/**
 * 导图画布 DOM → 高清 PNG。
 *
 * 旧实现把整棵 DOM（含嵌套 SVG）塞进 foreignObject 再栅格化：
 * 1) 浏览器几乎不渲染 foreignObject 里的嵌套 <svg>/<path> → 连线缺失
 * 2) scrollWidth 不含 transform 挪出去的子树 → 图片被裁切
 *
 * 现实现：
 * - 用节点/路径的真实包围盒定画布尺寸
 * - HTML 节点单独 foreignObject 栅格化（去掉 svg，透明底）
 * - 连线/下划线用 Canvas Path2D 按 live SVG 几何重绘（画在节点之下）
 */

export type MindmapExportOptions = {
  /** 相对像素倍率，默认 2 */
  scale?: number;
  filename?: string;
  background?: string;
};

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

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

function isTransparentBg(bg: string): boolean {
  const s = bg.trim().toLowerCase();
  return !s || s === "transparent" || s === "rgba(0, 0, 0, 0)" || s === "rgba(0,0,0,0)";
}

/** 导图页底（#fafafa / 纸面奶油色等）— 导出时应挖成透明，保留卡片白底 */
function isPageCanvasBg(bg: string): boolean {
  const s = bg.trim().toLowerCase().replace(/\s+/g, "");
  if (isTransparentBg(s)) return true;
  if (s === "#fafafa" || s === "#fcfaf6" || s === "#f7f4ef" || s === "#faf8f5") return true;
  const m = s.match(/^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/);
  if (!m) return false;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const a = m[4] != null ? Number(m[4]) : 1;
  if (a < 0.05) return true;
  // #fafafa / #fcfaf6 / 近白灰纸面
  if (r >= 245 && g >= 240 && b >= 235 && Math.abs(r - g) <= 12 && Math.abs(g - b) <= 12) {
    // 纯白卡片 rgb(255,255,255) 保留
    if (r >= 253 && g >= 253 && b >= 253) return false;
    return true;
  }
  return false;
}

function neutralizePageBackgrounds(root: HTMLElement) {
  const kill = (el: HTMLElement) => {
    const bg = el.style.backgroundColor || "";
    if (!isPageCanvasBg(bg)) return;
    el.style.backgroundColor = "transparent";
    // 纯色纸面底才清掉 shorthand；保留卡片上的渐变/图案
    const image = (el.style.backgroundImage || "").trim().toLowerCase();
    if (!image || image === "none") {
      el.style.background = "transparent";
    }
  };
  kill(root);
  root.querySelectorAll<HTMLElement>("*").forEach(kill);
}

/** 与 MindmapTree 边布局一致：抵消 pan 缩放，得到 canvas 本地 CSS 像素 */
function hostScale(host: HTMLElement) {
  const rr = host.getBoundingClientRect();
  const sx = host.offsetWidth > 0 ? rr.width / host.offsetWidth : 1;
  const sy = host.offsetHeight > 0 ? rr.height / host.offsetHeight : 1;
  return { rr, sx: sx || 1, sy: sy || 1 };
}

function expandBounds(b: Bounds, x1: number, y1: number, x2: number, y2: number) {
  b.minX = Math.min(b.minX, x1, x2);
  b.minY = Math.min(b.minY, y1, y2);
  b.maxX = Math.max(b.maxX, x1, x2);
  b.maxY = Math.max(b.maxY, y1, y2);
}

function measureContentBounds(host: HTMLElement): Bounds {
  const { rr, sx, sy } = hostScale(host);
  const b: Bounds = {
    minX: 0,
    minY: 0,
    maxX: Math.max(host.offsetWidth, host.scrollWidth, 16),
    maxY: Math.max(host.offsetHeight, host.scrollHeight, 16),
  };

  const expandEl = (el: Element) => {
    const er = el.getBoundingClientRect();
    if (er.width < 0.5 && er.height < 0.5) return;
    expandBounds(
      b,
      (er.left - rr.left) / sx,
      (er.top - rr.top) / sy,
      (er.right - rr.left) / sx,
      (er.bottom - rr.top) / sy
    );
  };

  host
    .querySelectorAll(
      "[data-mind-tree], [data-mind-bubble], [data-mind-branch], [data-mind-child-row], [data-mind-child-col]"
    )
    .forEach(expandEl);

  host.querySelectorAll("svg path, svg line, svg polyline, svg polygon").forEach((el) => {
    try {
      const bb = (el as SVGGraphicsElement).getBBox();
      if (!Number.isFinite(bb.width) || !Number.isFinite(bb.height)) return;
      const pad = 8;
      expandBounds(b, bb.x - pad, bb.y - pad, bb.x + bb.width + pad, bb.y + bb.height + pad);
    } catch {
      expandEl(el);
    }
  });

  const pad = 40;
  b.minX -= pad;
  b.minY -= pad;
  b.maxX += pad;
  b.maxY += pad;
  return b;
}

function inlineHtmlStyles(source: Element, target: Element) {
  const walk = (from: Element, to: Element) => {
    if (from instanceof HTMLElement && to instanceof HTMLElement) {
      const cs = window.getComputedStyle(from);
      let css = "";
      for (let i = 0; i < cs.length; i++) {
        const prop = cs.item(i);
        if (!prop) continue;
        if (prop.startsWith("transition") || prop.startsWith("animation")) continue;
        css += `${prop}:${cs.getPropertyValue(prop)};`;
      }
      to.setAttribute("style", css);
    }
    const fc = Array.from(from.children);
    const tc = Array.from(to.children);
    for (let i = 0; i < fc.length && i < tc.length; i++) walk(fc[i], tc[i]);
  };
  walk(source, target);
}

/** 栅格化 HTML 节点层（透明底，不含 svg） */
async function rasterizeHtmlLayer(
  host: HTMLElement,
  bounds: Bounds,
  factor: number
): Promise<HTMLCanvasElement | null> {
  const w = Math.ceil(bounds.maxX - bounds.minX);
  const h = Math.ceil(bounds.maxY - bounds.minY);
  if (w < 8 || h < 8) return null;

  const clone = host.cloneNode(true) as HTMLElement;
  inlineHtmlStyles(host, clone);
  clone.querySelectorAll("svg").forEach((el) => el.remove());
  clone
    .querySelectorAll("[data-mind-edit],[data-mind-zoom],[data-mind-chrome],[data-mind-ctx]")
    .forEach((el) => el.remove());

  clone.style.margin = "0";
  clone.style.transform = "none";
  clone.style.position = "absolute";
  clone.style.left = `${-bounds.minX}px`;
  clone.style.top = `${-bounds.minY}px`;
  clone.style.width = `${Math.max(host.offsetWidth, host.scrollWidth)}px`;
  clone.style.height = `${Math.max(host.offsetHeight, host.scrollHeight)}px`;
  clone.style.overflow = "visible";
  clone.style.background = "transparent";
  neutralizePageBackgrounds(clone);

  let xhtml = new XMLSerializer().serializeToString(clone);
  if (!/\sxmlns=/.test(xhtml.slice(0, 120))) {
    xhtml = xhtml.replace(
      /^<([a-zA-Z0-9:-]+)/,
      '<$1 xmlns="http://www.w3.org/1999/xhtml"'
    );
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <foreignObject width="100%" height="100%" x="0" y="0">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;position:relative;overflow:visible;background:transparent;">
      ${xhtml}
    </div>
  </foreignObject>
</svg>`;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("html rasterize failed"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * factor);
    canvas.height = Math.round(h * factor);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return null;
  }
}

function parseDash(dash: string): number[] {
  if (!dash || dash === "none") return [];
  return dash
    .split(/[, ]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

/** 按 live DOM 的 SVG 路径重绘连线（不经过 foreignObject） */
function paintSvgOverlays(
  ctx: CanvasRenderingContext2D,
  host: HTMLElement,
  bounds: Bounds,
  factor: number
) {
  const nodes = host.querySelectorAll("svg path, svg line");
  for (const el of Array.from(nodes)) {
    const cs = window.getComputedStyle(el);
    const stroke = cs.stroke || cs.getPropertyValue("stroke");
    if (!stroke || stroke === "none") continue;
    const opacity = Number(cs.opacity || "1");
    if (opacity <= 0) continue;

    ctx.save();
    ctx.setTransform(factor, 0, 0, factor, -bounds.minX * factor, -bounds.minY * factor);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(
      0.5,
      Number.parseFloat(cs.strokeWidth || cs.getPropertyValue("stroke-width")) || 1
    );
    ctx.lineCap = (cs.strokeLinecap as CanvasLineCap) || "round";
    ctx.lineJoin = (cs.strokeLinejoin as CanvasLineJoin) || "round";
    ctx.globalAlpha = opacity;
    ctx.setLineDash(parseDash(cs.strokeDasharray || ""));

    if (el instanceof SVGPathElement) {
      const d = el.getAttribute("d");
      if (d) {
        try {
          ctx.stroke(new Path2D(d));
        } catch {
          /* ignore bad path */
        }
      }
    } else if (el instanceof SVGLineElement) {
      ctx.beginPath();
      ctx.moveTo(el.x1.baseVal.value, el.y1.baseVal.value);
      ctx.lineTo(el.x2.baseVal.value, el.y2.baseVal.value);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * 导出 mindmap 画布元素为 PNG。
 * @param host 通常为 MindmapTree 的 .canvas（canvasRef）
 */
export async function exportMindmapPng(
  host: HTMLElement,
  opts: MindmapExportOptions = {}
): Promise<boolean> {
  const factor = Math.max(1, Math.min(3, Math.round(opts.scale ?? 2)));
  // 默认透明底，便于贴到任意界面；需要实心底时显式传 background
  const background = opts.background ?? "transparent";
  const filename = opts.filename || `mindmap-export-${Date.now()}.png`;

  const bounds = measureContentBounds(host);
  const w = Math.ceil(bounds.maxX - bounds.minX);
  const h = Math.ceil(bounds.maxY - bounds.minY);
  if (w < 8 || h < 8) return false;

  const maxSide = 8192;
  let useFactor = factor;
  if (w * useFactor > maxSide || h * useFactor > maxSide) {
    useFactor = Math.max(1, Math.floor(maxSide / Math.max(w, h)));
  }

  const htmlCanvas = await rasterizeHtmlLayer(host, bounds, useFactor);
  if (!htmlCanvas) return false;

  const out = document.createElement("canvas");
  out.width = htmlCanvas.width;
  out.height = htmlCanvas.height;
  const octx = out.getContext("2d");
  if (!octx) return false;

  // 透明底 → 连线/下划线 → 节点卡片（卡片自带白底保留）
  octx.clearRect(0, 0, out.width, out.height);
  if (!isTransparentBg(background)) {
    octx.fillStyle = background;
    octx.fillRect(0, 0, out.width, out.height);
  }
  paintSvgOverlays(octx, host, bounds, useFactor);
  octx.drawImage(htmlCanvas, 0, 0);

  const blob = await canvasToPngBlob(out);
  if (!blob) return false;
  downloadBlob(blob, filename);
  return true;
}
