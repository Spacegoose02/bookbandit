import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The tablet app's own pages (pairing, tablet settings), served at /native/ inside the APK.
 * `vite.shim.config.ts` builds the script that is added to the web app's index.html.
 * `scripts/assemble-www.mjs` puts both next to apps/web's build in www/.
 */
export default defineConfig({
  root: "src",
  base: "/native/",
  build: {
    outDir: resolve(__dirname, "dist-native"),
    emptyOutDir: true,
    target: "chrome60",
    rollupOptions: {
      input: {
        setup: resolve(__dirname, "src/setup/setup.html"),
        settings: resolve(__dirname, "src/settings/settings.html"),
      },
    },
  },
});
