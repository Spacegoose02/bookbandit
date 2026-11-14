/** Small display helpers, shared by the pages. */

export function percentLabel(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p) || p <= 0) return "Not started";
  if (p >= 0.99) return "Finished";
  return `${Math.max(1, Math.round(p * 100))}%`;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** MIME type for a blob of a saved book, so foliate-js picks the right parser. */
export function mimeFor(format: string): string {
  switch (format) {
    case "epub":
      return "application/epub+zip";
    case "pdf":
      return "application/pdf";
    case "cbz":
      return "application/vnd.comicbook+zip";
    case "fb2":
      return "application/x-fictionbook+xml";
    case "mobi":
    case "azw3":
      return "application/x-mobipocket-ebook";
    default:
      return "application/octet-stream";
  }
}

/** What the setup form's address box holds: a pairing link fills in the code as well. */
export function splitPairLink(input: string): { address: string; code: string | null } {
  const s = input.trim();
  if (!s.toLowerCase().startsWith("bookbandit://")) return { address: s, code: null };
  try {
    const q = new URL(s.replace(/^bookbandit:\/\//i, "https://x/")).searchParams;
    return { address: q.get("server") ?? "", code: q.get("code") };
  } catch {
    return { address: s, code: null };
  }
}

/** Escapes text for innerHTML templates. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
