/**
 * Encryption for secrets kept in the settings table (API tokens, SMTP passwords).
 * AES-256-GCM with a key stored in CONFIG_DIR/secret.key, created on first use.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PREFIX = "enc:v1:";

export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function loadOrCreateKey(configDir: string): Buffer {
  const file = join(configDir, "secret.key");
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (key.length !== 32) throw new Error(`${file} must hold 32 bytes of hex`);
    return key;
  }
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600, flag: "wx" });
  return key;
}

export function secretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("secret key must be 32 bytes");
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    open(sealed) {
      if (!sealed.startsWith(PREFIX)) throw new Error("not a sealed secret");
      const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
