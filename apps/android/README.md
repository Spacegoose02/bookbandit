# BookBandit for Android tablets

A Capacitor 8 app that wraps the web app (`apps/web`) for Android tablets, including Amazon Fire
tablets (Fire OS 7 and later; Android 7+ in general). Sideload the APK from a GitHub Release.

Screenshots: `docs/screenshots/2026-11-14-android-*.png`.

## What it does

- **Pairing.** On first start the tablet shows a setup screen. A parent starts pairing in the web
  app (`POST /api/devices/pairings`), then the tablet scans the QR code with its camera (jsQR, no
  Google Play Services needed, so it works on Fire tablets) or the code is typed with the server
  address. Opening a `bookbandit://pair?server=…&code=…` link also starts the app on that screen.
  The tablet claims the code (`POST /api/devices/claim`) and keeps the device token natively.
- **Parent PIN.** Set at pairing (optional, recommended). Needed for tablet settings, unpinning and
  unpairing. Five wrong tries lock it for 30 s, doubling each time.
- **Offline reading.** "Save for offline" on a book's page, or "Save this reader's shelves" in
  tablet settings (up to 20 books), downloads the book file, cover and details. Offline, the app
  serves those plus the last good copy of every page the reader opened (shelves, book pages,
  covers). An "On this tablet" row is added to the top of the home shelves. Reading positions
  saved offline go up through the existing progress batch API when the network returns.
- **Screen pinning.** Tablet settings can pin the screen now, or automatically whenever a kid
  profile is reading (for storyteller mode and the youngest readers). Unpinning in the app needs
  the parent PIN. Android's own unpin gesture still works unless "Ask for PIN before unpinning" is
  turned on in Android's settings.
- **Tablet settings** (`/native/settings.html`, linked from the web app's Appearance page when in
  the app): offline books, kid safety, change PIN, device info, unpair (deletes offline books).

## How it fits together

```
WebView (https://localhost)                         Native (Java)
───────────────────────────                         ─────────────
apps/web build + /native/ pages
  GET /api/...  (fetch, <img>, foliate) ──────────▶ ApiWebViewClient → ApiRouter
                                                      online: ServerClient (OkHttp) → server,
                                                              cache JSON/covers per person
                                                      offline: cache, downloaded books
  POST/PUT/PATCH/DELETE /api/... ── shim.ts ──────▶ BookBanditPlugin.request → ServerClient
  window.BookBanditNative (download, pin, …) ─────▶ BookBanditPlugin
```

- The web app is bundled into the APK unchanged except for two script tags that
  `scripts/assemble-www.mjs` adds to `index.html`: `/native/state.js` (answered natively: paired?
  server? device name?) and `/native/shim.js` (`src/shim.ts`).
- **The device token never reaches JavaScript.** `ServerClient` adds `Authorization: Bearer bbd_…`
  and keeps the server's cookies (a kid's PIN sign-in session on a shared tablet) in its own jar.
- WebView can't read request bodies in `shouldInterceptRequest`, so requests with a body go
  through the plugin (`src/fetchShim.ts` patches `fetch`). GETs, covers and Range requests for book
  files are answered directly by `ApiWebViewClient`.
- **Content lock offline.** Everything stored offline is filed under the person who fetched it
  (learned from `GET /api/users/me`), so on a shared tablet one profile never sees another's
  cached pages or downloads. When the server answers 404 for a downloaded book (re-rated, removed),
  the tablet deletes its copy. Downloads ask the server for the book first, which applies the lock.
- Cleartext http is allowed so home servers on `http://192.168.x.x:8080` work. The setup screen
  warns when a plain http address isn't on the local network.

Files:

| Path | What |
| --- | --- |
| `src/shim.ts`, `src/fetchShim.ts` | Injected into the web app: redirect to setup, native fetch for writes, `window.BookBanditNative` |
| `src/setup/`, `src/settings/` | Pairing and tablet settings pages (plain TS + DOM) |
| `src/native.ts` | Plugin interface; `src/mockPlugin.ts` stands in for it in a desktop browser |
| `src/pairing.ts` | QR link / server address / PIN parsing |
| `android/app/src/main/java/app/bookbandit/tablet/` | `MainActivity`, `BookBanditPlugin`, `ApiWebViewClient`, `ApiRouter`, `ServerClient`, `CookieStore`, `OfflineStore`, `PinHasher`, `ByteRange`, `NativeState` |
| `android/app/src/test/` | JVM unit tests for the router, offline store, PIN and Range parsing |
| `../web/src/native/` | The web app's optional hooks: "Save for offline" button, "Tablet settings" link |

## Building

Needs Node 22, pnpm, JDK 21 and the Android SDK (platform 36). CI (`.github/workflows/android.yml`)
does all of this on every PR that touches the app or the web app.

```sh
pnpm install
pnpm --filter @bookbandit/shared build
pnpm --filter @bookbandit/web build
pnpm --filter @bookbandit/android build        # www/ = web build + native pages + shim
cd apps/android && pnpm exec cap sync android  # copy www/ into the Android project
cd android && ./gradlew testDebugUnitTest assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a tablet: `adb install -r app-debug.apk`, or copy it over and open it (allow "install
unknown apps"). On a Fire tablet: Settings → Security & Privacy → Apps from Unknown Sources.

Preview the pages in a desktop browser (mock plugin, no Android needed):
`pnpm --filter @bookbandit/android preview`, then open `http://localhost:4174/native/setup.html`
or `/native/settings.html?paired` (mock PIN 1234). Screenshots: see `scripts/screenshots.cjs`.

Unit tests: `pnpm --filter @bookbandit/android test` (TypeScript) and `./gradlew testDebugUnitTest`
in `android/` (Java).

## Releases and signing

When a `v*` tag's Docker workflow finishes (that's what creates the GitHub Release), the Android
workflow builds the APK for the tag and attaches `bookbandit-<version>.apk` to the release. Every
other run keeps the APK as a workflow artifact.

For APKs that install over each other, give CI one signing key. Once:

```sh
keytool -genkeypair -v -keystore bookbandit.keystore -alias bookbandit -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 bookbandit.keystore   # → secret ANDROID_KEYSTORE_BASE64
```

Then add repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` (`bookbandit`) and `ANDROID_KEY_PASSWORD`. Keep the keystore somewhere safe:
losing it means every tablet has to uninstall and re-pair once. Without the secrets, CI signs with a
throwaway debug key.

## Known gaps and next steps

- Not yet tried on real hardware: CI compiles and unit-tests it, but QR pairing, offline reading
  and pinning need a run on a Fire tablet and a stock Android tablet.
- Bookmarks added offline aren't queued (reading positions are).
- Browser uploads (`FormData`) aren't proxied; use a browser for admin uploads.
- Kiosk mode without Android's pinning prompt needs the app set as device owner (`adb shell dpm
  set-device-owner`); the manifest already allows lock task mode when whitelisted.
- The web app's "Who's reading?" picker and kid PIN sign-in come from the auth workstream; the
  tablet keeps whatever session cookie that flow sets.
