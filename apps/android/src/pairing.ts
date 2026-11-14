/**
 * Reading the pairing QR code and the typed server address.
 *
 * The server's POST /api/devices/pairings returns `qr: "bookbandit://pair?server=<url>&code=<code>"`
 * (apps/server/src/routes/devices.ts). The code is also shown as text for typing in.
 */

export interface PairingInfo {
  server: string | null;
  code: string | null;
}

/** Reads a bookbandit://pair link (or a plain https link with ?server=&code=). Null if it isn't one. */
export function parsePairLink(text: string): PairingInfo | null {
  const raw = text.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isPairScheme = url.protocol === "bookbandit:";
  // `new URL("bookbandit://pair?..")` puts "pair" in host for special parsers and in pathname otherwise.
  const target = (url.host || url.pathname.replace(/^\/+/, "")).toLowerCase();
  if (isPairScheme && target !== "pair") return null;
  const code = url.searchParams.get("code");
  const server = url.searchParams.get("server");
  if (!isPairScheme && !code) return null;
  return { server: server ? normalizeServer(server) : null, code: code ? normalizeCode(code) : null };
}

/**
 * Turns what someone typed into a server base URL: adds http:// for bare LAN addresses and
 * https:// for names, drops trailing slashes and any path after /api or a page route.
 * Returns null when it can't be an address.
 */
export function normalizeServer(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/:]/)[0] ?? "";
    const local = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === "localhost" || host.endsWith(".local") || !host.includes(".");
    s = (local ? "http://" : "https://") + s;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  let path = url.pathname.replace(/\/+$/, "");
  const api = path.indexOf("/api");
  if (api >= 0) path = path.slice(0, api);
  return `${url.protocol}//${url.host}${path}`;
}

/** Pairing codes are shown in groups ("ABCD-EFGH"); accept any case and spacing. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

export function isPlausibleCode(code: string): boolean {
  const c = normalizeCode(code);
  return c.length >= 4 && c.length <= 32;
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

/** Plain http to a non-local host sends the device token in the clear: worth a warning. */
export function insecureWarning(server: string): string | null {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  const h = url.hostname;
  const lan =
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "localhost" ||
    h.endsWith(".local") ||
    !h.includes(".");
  return lan ? null : "This address isn't encrypted (http). Use https:// if the server is reachable from the internet.";
}
