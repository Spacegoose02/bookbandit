/**
 * A random v4 UUID that works everywhere the app runs.
 *
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS or localhost). Families often open
 * BookBandit at a plain-HTTP LAN address such as http://192.168.1.20:8080, where calling it throws
 * "crypto.randomUUID is not a function" and, inside a React effect, blanks the whole page.
 * `crypto.getRandomValues()` is available in insecure contexts too, so fall back to it.
 * Never call `crypto.randomUUID()` directly in the web app; a test checks for it.
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
