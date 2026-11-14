import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Two local pages: the launcher (server setup) and the offline library + reader.
// Everything else the app shows is the family's own BookBandit server, loaded in the window.
export default defineConfig({
  clearScreen: false,
  build: {
    target: "es2022",
    rollupOptions: {
      input: { index: resolve(__dirname, "index.html"), offline: resolve(__dirname, "offline.html") },
    },
  },
  server: { port: 1420, strictPort: true },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
