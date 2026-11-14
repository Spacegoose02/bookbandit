/** Hashing for passwords, kid PINs and picture sequences, and random tokens. */
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scryptAsync(secret: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** `scrypt$N$r$p$salt$hash` (base64url). */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Spend the same time as a real check so a missing secret isn't detectable by timing.
    await scryptAsync(secret, randomBytes(16), N, R, P);
    return false;
  }
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scryptAsync(secret, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Picture sequences are stored like a PIN: the ordered ids joined with "-". */
export function pictureSecret(pictures: readonly string[]): string {
  return `pictures:${pictures.join("-")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** No 0/O, 1/I/L: easy to read off a screen and type on a tablet. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A short one-time code, e.g. "K7QM-4XPA". Shown as a QR code and as text. */
export function pairingCode(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accept "k7qm 4xpa", "K7QM4XPA" etc. */
export function normalizePairingCode(input: string): string {
  const s = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}
