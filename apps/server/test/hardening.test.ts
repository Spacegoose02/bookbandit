import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { devices, userIdentities, users } from "../src/db/schema.js";
import { hashSecret } from "../src/auth/secrets.js";
import { family, type Family } from "./helpers.js";

let f: Family | undefined;
let webDir: string | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
  if (webDir) rmSync(webDir, { recursive: true, force: true });
  webDir = undefined;
});

describe("security headers", () => {
  it("sends a CSP on pages and no-store on API answers", async () => {
    webDir = mkdtempSync(join(tmpdir(), "bb-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Bookbandit</title>");
    f = await family({}, { WEB_DIR: webDir });
    const page = await f.app.inject({ url: "/library" });
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(page.headers["strict-transport-security"]).toBeUndefined();

    const api = await f.app.inject({ url: "/api/books", headers: f.as("adult") });
    expect(api.headers["cache-control"]).toBe("no-store");
    expect(api.headers["content-security-policy"]).toBeUndefined();
    expect(api.headers["referrer-policy"]).toBe("same-origin");

    // HSTS only when the request reached the proxy over HTTPS.
    const https = await f.app.inject({ url: "/api/health", headers: { "x-forwarded-proto": "https" } });
    expect(https.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  });

  it("lets CONTENT_SECURITY_POLICY replace or turn off the policy", async () => {
    webDir = mkdtempSync(join(tmpdir(), "bb-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Bookbandit</title>");
    f = await family({}, { WEB_DIR: webDir, CONTENT_SECURITY_POLICY: "off" });
    const page = await f.app.inject({ url: "/" });
    expect(page.headers["content-security-policy"]).toBeUndefined();
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("paired device expiry", () => {
  async function pair(fam: Family) {
    const start = await fam.app.inject({ method: "POST", url: "/api/devices/pairings", headers: fam.as("parent"), payload: { name: "Den tablet" } });
    expect(start.statusCode).toBe(201);
    const claim = await fam.app.inject({ method: "POST", url: "/api/devices/claim", payload: { code: start.json().code } });
    expect(claim.statusCode).toBe(201);
    return { token: claim.json().deviceToken as string, id: claim.json().device.id as string };
  }

  it("treats a device unused for DEVICE_IDLE_DAYS as revoked", async () => {
    f = await family({}, { DEVICE_IDLE_DAYS: "30" });
    const d = await pair(f);
    const ok = await f.app.inject({ url: "/api/devices/current", headers: { authorization: `Bearer ${d.token}` } });
    expect(ok.statusCode).toBe(200);

    f.db.update(devices).set({ lastSeenAt: Date.now() - 31 * 86_400_000 }).where(eq(devices.id, d.id)).run();
    const stale = await f.app.inject({ url: "/api/auth/status", headers: { authorization: `Bearer ${d.token}` } });
    expect(stale.json().device).toBeNull();
    expect(f.db.select().from(devices).where(eq(devices.id, d.id)).get()!.revokedAt).not.toBeNull();
  });

  it("never expires devices with DEVICE_IDLE_DAYS=0", async () => {
    f = await family({}, { DEVICE_IDLE_DAYS: "0" });
    const d = await pair(f);
    f.db.update(devices).set({ lastSeenAt: Date.now() - 3000 * 86_400_000 }).where(eq(devices.id, d.id)).run();
    const res = await f.app.inject({ url: "/api/auth/status", headers: { authorization: `Bearer ${d.token}` } });
    expect(res.json().device).not.toBeNull();
  });
});

describe("password sign-in limits", () => {
  it("locks an address that sprays guesses over many usernames", async () => {
    f = await family();
    const hash = await hashSecret("correct horse battery");
    f.db.update(users).set({ secretHash: hash }).where(eq(users.id, f.ids.adult)).run();
    f.db.insert(userIdentities).values({ userId: f.ids.adult, provider: "local", subject: "aunt" }).run();

    let last = 0;
    for (let i = 0; i < 60; i++) {
      const res = await f.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: `guess${i}`, password: "nope-nope" } });
      last = res.statusCode;
      if (res.statusCode === 429) break;
    }
    expect(last).toBe(429);
    // Even the right password for a real account waits until the lock passes.
    const real = await f.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "aunt", password: "correct horse battery" } });
    expect(real.statusCode).toBe(429);
    expect(Number(real.headers["retry-after"])).toBeGreaterThan(0);
  });
});
