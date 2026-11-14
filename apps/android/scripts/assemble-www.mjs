#!/usr/bin/env node
/**
 * Builds www/ for Capacitor: the web app's build (apps/web/dist) with this app's pages in
 * www/native/, and two script tags added to the top of index.html:
 *
 *   /native/state.js  answered by the native layer (paired? server? device name?)
 *   /native/shim.js   routes /api requests natively, exposes window.BookBanditNative
 *
 * Run after `pnpm --filter @bookbandit/web build` and this package's `vite build`s.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const webDist = join(app, "..", "web", "dist");
const nativeDist = join(app, "dist-native");
const www = join(app, "www");

if (!existsSync(join(webDist, "index.html"))) {
  console.error("apps/web/dist is missing. Run: pnpm --filter @bookbandit/web build");
  process.exit(1);
}
for (const f of ["shim.js", "setup/setup.html", "settings/settings.html"]) {
  if (!existsSync(join(nativeDist, f))) {
    console.error(`dist-native/${f} is missing. Run: pnpm --filter @bookbandit/android build`);
    process.exit(1);
  }
}

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(webDist, www, { recursive: true });
cpSync(nativeDist, join(www, "native"), { recursive: true });
// Short paths for the two pages.
cpSync(join(nativeDist, "setup", "setup.html"), join(www, "native", "setup.html"));
cpSync(join(nativeDist, "settings", "settings.html"), join(www, "native", "settings.html"));
rmSync(join(www, "native", "setup"), { recursive: true, force: true });
rmSync(join(www, "native", "settings"), { recursive: true, force: true });

// The web app's service worker / PWA manifest aren't wanted inside the APK.
rmSync(join(www, "manifest.webmanifest"), { force: true });

const indexPath = join(www, "index.html");
const html = readFileSync(indexPath, "utf8");
const tags = '<script src="/native/state.js"></script><script src="/native/shim.js"></script>';
if (!html.includes("<head>")) {
  console.error("apps/web/dist/index.html has no <head>");
  process.exit(1);
}
writeFileSync(indexPath, html.replace("<head>", `<head>\n    ${tags}`).replace(/\s*<link rel="manifest"[^>]*>/, ""));
console.log(`www/ assembled from apps/web/dist and dist-native (${tags.length} bytes of tags added)`);
