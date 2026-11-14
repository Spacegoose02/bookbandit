/**
 * Web search through SearXNG's JSON API. Results come back as numbered sources the model
 * cites as [1], [2]… Kids always get strict safe search and only allowlisted sites.
 */
import { postJson, trimSlash, type FetchLike } from "./providers/types.js";
import type { AiSettings } from "./settings.js";

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
}

interface SearxResponse {
  results?: { url?: string; title?: string; content?: string }[];
}

export function hostAllowed(url: string, allowlist: string[]): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return allowlist.some((entry) => {
    const d = entry.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "").replace(/^www\./, "");
    return host === d || host.endsWith(`.${d}`);
  });
}

export async function webSearch(
  fetchImpl: FetchLike,
  search: AiSettings["search"],
  query: string,
  opts: { kid: boolean; language?: string },
): Promise<WebSource[]> {
  if (!search.enabled || !search.url) return [];
  const params = new URLSearchParams({
    q: query.slice(0, 300),
    format: "json",
    safesearch: String(opts.kid ? 2 : search.safeSearch),
  });
  if (opts.language) params.set("language", opts.language);
  const r = await postJson<SearxResponse>(fetchImpl, `${trimSlash(search.url)}/search?${params}`, {
    headers: {},
    timeoutMs: 15_000,
    label: "SearXNG",
  });
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const res of r.results ?? []) {
    if (!res.url || !res.title || seen.has(res.url)) continue;
    if (!/^https?:\/\//i.test(res.url)) continue;
    if (opts.kid && !hostAllowed(res.url, search.kidAllowlist)) continue;
    seen.add(res.url);
    out.push({ title: res.title.slice(0, 200), url: res.url, snippet: (res.content ?? "").slice(0, 500) });
    if (out.length >= search.maxResults) break;
  }
  return out;
}
