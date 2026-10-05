import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `cloudflare:workers` is only provided inside the Workers runtime
      // (via @cloudflare/vitest-pool-workers for *.worker.test.ts).
      // Node-pool tests load LineRateLimiter via src/index.ts's re-export
      // chain but never instantiate it — provide a minimal stub so the
      // import resolves.
      "cloudflare:workers": new URL("./test/cloudflare-workers-stub.ts", import.meta.url).pathname,
      "cloudflare:workflows": new URL("./test/cloudflare-workers-stub.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.worker.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/worker-configuration.d.ts"],
      reporter: ["text", "json", "html", "lcov"]
    }
  }
});
