/** Tiny Atom/OPDS 1.2 writer. Every value goes through `esc`; nothing else builds XML. */

export const ATOM_NAV = "application/atom+xml;profile=opds-catalog;kind=navigation";
export const ATOM_ACQ = "application/atom+xml;profile=opds-catalog;kind=acquisition";
export const OPENSEARCH = "application/opensearchdescription+xml";
export const REL_ACQUISITION = "http://opds-spec.org/acquisition";
export const REL_IMAGE = "http://opds-spec.org/image";
export const REL_THUMBNAIL = "http://opds-spec.org/image/thumbnail";

export function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface Link {
  rel: string;
  href: string;
  type?: string;
  title?: string;
  length?: number;
}

export function link(l: Link): string {
  const attrs = [`rel="${esc(l.rel)}"`, `href="${esc(l.href)}"`];
  if (l.type) attrs.push(`type="${esc(l.type)}"`);
  if (l.title) attrs.push(`title="${esc(l.title)}"`);
  if (l.length !== undefined) attrs.push(`length="${l.length}"`);
  return `<link ${attrs.join(" ")}/>`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface FeedOptions {
  id: string;
  title: string;
  self: string;
  kind: "navigation" | "acquisition";
  links?: Link[];
  entries: string[];
  /** For paged acquisition feeds. */
  paging?: { total: number; perPage: number; startIndex: number };
  updated?: number;
}

export function feed(o: FeedOptions): string {
  const type = o.kind === "navigation" ? ATOM_NAV : ATOM_ACQ;
  const links = [
    link({ rel: "self", href: o.self, type }),
    link({ rel: "start", href: "/opds", type: ATOM_NAV, title: "Bookbandit" }),
    link({ rel: "up", href: "/opds", type: ATOM_NAV }),
    link({ rel: "search", href: "/opds/search.xml", type: OPENSEARCH, title: "Search" }),
    link({ rel: "search", href: "/opds/search?q={searchTerms}", type: ATOM_ACQ, title: "Search" }),
    ...(o.links ?? []).map(link),
  ];
  const paging = o.paging
    ? `<opensearch:totalResults>${o.paging.total}</opensearch:totalResults>` +
      `<opensearch:itemsPerPage>${o.paging.perPage}</opensearch:itemsPerPage>` +
      `<opensearch:startIndex>${o.paging.startIndex}</opensearch:startIndex>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" ` +
    `xmlns:dc="http://purl.org/dc/terms/" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">\n` +
    `<id>${esc(o.id)}</id>\n<title>${esc(o.title)}</title>\n<updated>${iso(o.updated ?? Date.now())}</updated>\n` +
    `<author><name>Bookbandit</name></author>\n<icon>/favicon.ico</icon>\n` +
    `${links.join("\n")}\n${paging}\n${o.entries.join("\n")}\n</feed>\n`
  );
}

export function navEntry(o: { id: string; title: string; href: string; content?: string; kind?: "navigation" | "acquisition"; count?: number }): string {
  const attrs = o.count !== undefined ? ` thr:count="${o.count}" xmlns:thr="http://purl.org/syndication/thread/1.0"` : "";
  const l = `<link rel="subsection" href="${esc(o.href)}" type="${o.kind === "navigation" ? ATOM_NAV : ATOM_ACQ}"${attrs}/>`;
  return (
    `<entry><title>${esc(o.title)}</title><id>${esc(o.id)}</id><updated>${iso(Date.now())}</updated>` +
    `${o.content ? `<content type="text">${esc(o.content)}</content>` : ""}${l}</entry>`
  );
}

export function openSearchDescription(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">` +
    `<ShortName>Bookbandit</ShortName><Description>Search the family library</Description>` +
    `<InputEncoding>UTF-8</InputEncoding><OutputEncoding>UTF-8</OutputEncoding>` +
    `<Url type="${esc(ATOM_ACQ)}" template="/opds/search?q={searchTerms}"/>` +
    `<Url type="application/atom+xml" template="/opds/search?q={searchTerms}"/>` +
    `</OpenSearchDescription>\n`
  );
}
