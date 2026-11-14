import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Builds src/shim.ts as one classic script (native/shim.js) so it runs before the web app. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist-native"),
    emptyOutDir: false,
    target: "chrome60",
    lib: {
      entry: resolve(__dirname, "src/shim.ts"),
      name: "BookBanditShim",
      formats: ["iife"],
      fileName: () => "shim.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
