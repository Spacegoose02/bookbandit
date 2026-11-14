import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.bookbandit.tablet",
  appName: "BookBandit",
  // Built by `pnpm build`: the web app from apps/web plus this app's own pages (pairing, tablet settings).
  webDir: "www",
  android: {
    // Fire tablets ship older WebViews; Capacitor 8 needs Chrome 60+, which Fire OS 7 and later have.
    minWebViewVersion: 60,
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
    hostname: "localhost",
  },
  plugins: {
    // Off on purpose: the native layer in MainActivity proxies /api itself, so the device token
    // never reaches JavaScript. See README.md.
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
  },
};

export default config;
