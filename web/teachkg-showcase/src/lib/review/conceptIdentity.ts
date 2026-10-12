/** 概念身份：树可以改，跳转挂在稳定 id 上。 */

export type ConceptLink = {
  id: string;
  concept_id: string;
  target_kind: string;
  target_id: string;
  label?: string;
};

export type RemoteLinkLike = {
  id: string;
  from: string;
  to: string;
  label?: string;
};

export function resolveConceptId(
  id: string,
  redirects: Record<string, string> | null | undefined,
  maxHops = 16
): string {
  let cur = String(id || "").trim();
  if (!cur || !redirects) return cur;
  const seen = new Set<string>();
  for (let i = 0; i < maxHops; i++) {
    const next = String(redirects[cur] || "").trim();
    if (!next || next === cur || seen.has(cur)) break;
    seen.add(cur);
    cur = next;
  }
  return cur;
}

export function collectSubtreeIds(node: {
  id: string;
  children?: { id: string; children?: unknown[] }[];
}): string[] {
  const out: string[] = [];
  const walk = (n: { id: string; children?: { id: string; children?: unknown[] }[] }) => {
    if (n.id) out.push(n.id);
    for (const c of n.children || []) walk(c as { id: string; children?: { id: string; children?: unknown[] }[] });
  };
  walk(node);
  return out;
}

export function addIdRedirects(
  existing: Record<string, string> | null | undefined,
  gone: Iterable<string>,
  canonical: string
): Record<string, string> {
  const next = { ...(existing || {}) };
  const dest = String(canonical || "").trim();
  if (!dest) return next;
  for (const raw of gone) {
    const src = String(raw || "").trim();
    if (!src || src === dest) continue;
    next[src] = dest;
  }
  for (const src of Object.keys(next)) {
    next[src] = resolveConceptId(src, next);
    if (next[src] === src) delete next[src];
  }
  return next;
}

export function rewriteRemoteLinks(
  links: RemoteLinkLike[],
  redirects: Record<string, string>,
  gone?: Set<string>
): RemoteLinkLike[] {
  const out: RemoteLinkLike[] = [];
  const seen = new Set<string>();
  for (const link of links || []) {
    const from = resolveConceptId(link.from, redirects);
    const to = resolveConceptId(link.to, redirects);
    if (!from || !to || from === to) continue;
    if (gone?.has(from) || gone?.has(to)) continue;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...link, from, to });
  }
  return out;
}

export function rewriteConceptLinks(
  links: ConceptLink[],
  redirects: Record<string, string>,
  gone?: Set<string>
): ConceptLink[] {
  const out: ConceptLink[] = [];
  const seen = new Set<string>();
  for (const link of links || []) {
    const concept_id = resolveConceptId(link.concept_id, redirects);
    if (!concept_id || gone?.has(concept_id)) continue;
    const key = `${concept_id}|${link.target_kind}|${link.target_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...link, concept_id });
  }
  return out;
}

export function retargetIdentity(opts: {
  gone: Iterable<string>;
  canonical: string | null;
  idRedirects?: Record<string, string>;
  remoteLinks?: RemoteLinkLike[];
  conceptLinks?: ConceptLink[];
}): {
  id_redirects: Record<string, string>;
  remoteLinks: RemoteLinkLike[];
  concept_links: ConceptLink[];
} {
  const goneSet = new Set(
    [...opts.gone].map((x) => String(x || "").trim()).filter(Boolean)
  );
  const canonical = String(opts.canonical || "").trim();
  const id_redirects = canonical
    ? addIdRedirects(opts.idRedirects, goneSet, canonical)
    : { ...(opts.idRedirects || {}) };
  return {
    id_redirects,
    remoteLinks: rewriteRemoteLinks(opts.remoteLinks || [], id_redirects, goneSet),
    concept_links: rewriteConceptLinks(opts.conceptLinks || [], id_redirects, goneSet),
  };
}
