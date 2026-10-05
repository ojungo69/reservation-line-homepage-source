import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/admin-app/",
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    outDir: "../public/admin-app",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Single vendor chunk for all node_modules. App-only deploys then leave
        // the (content-hashed, immutable-cached) vendor bundle untouched, so
        // returning admins re-download only the small app entry. One chunk —
        // not per-package vendor chunks — avoids cross-chunk imports that would
        // cascade hash invalidation and defeat the caching win.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // Leave style assets to Vite's CSS pipeline so per-route CSS
          // code-splitting is preserved; only JS deps go in the vendor chunk.
          // Extension set mirrors Vite's own CSS_LANGS_RE; query-suffix guard
          // handles ids like `foo.css?used`.
          if (/\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(\?.*)?$/.test(id))
            return;
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
