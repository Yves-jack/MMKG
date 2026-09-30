/** 部署在子路径（如 /teachkg/）时，给绝对路径补上 Vite BASE_URL。 */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  if (!path) return base;
  if (/^https?:\/\//i.test(path) || path.startsWith("data:") || path.startsWith("blob:")) {
    return path;
  }
  if (base === "/") return path.startsWith("/") ? path : `/${path}`;
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`)) {
    return normalizedPath;
  }
  return `${normalizedBase}${normalizedPath}`;
}
