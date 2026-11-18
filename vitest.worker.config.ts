import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Native CJS loading avoids Jiti's default interop error in Knip's config reader.
const { unstable_splitSqlQuery } = createRequire(import.meta.url)("wrangler") as typeof import("wrangler");

// Wrangler's splitter mistakes "BEGIN TRANSACTION" in old comment lines for SQL.
// Strip only whole-line comments in the test reader; committed migrations stay intact.
const migrations = readdirSync("./migrations").filter((name) => name.endsWith(".sql")).sort().map((name) => ({
  name,
  queries: unstable_splitSqlQuery(readFileSync(`./migrations/${name}`, "utf8").replace(/^\s*--.*$/gm, ""))
}));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc"
      },
      miniflare: {
        bindings: { MINIMO_TEST_MIGRATIONS: migrations }
      }
    })
  ],
  test: {
    include: ["test/**/*.worker.test.ts"],
    testTimeout: 30_000
  }
});
