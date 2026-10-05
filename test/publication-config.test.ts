import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("public repository configuration", () => {
  it("keeps runtime resources fictional and production environment trees private", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    expect(config.env).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.vars.ENVIRONMENT).toBe("local");
    for (const namespace of config.kv_namespaces) expect(namespace.id).toBe("0".repeat(32));
    for (const database of config.d1_databases) expect(database.database_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(config.assets.html_handling).toBe("auto-trailing-slash");
    expect(config.assets.run_worker_first).toBe(true);
  });

  it("uses disposable hosted runners and never holds production credentials", () => {
    for (const name of readdirSync(new URL("../.github/workflows/", import.meta.url))) {
      const text = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
      const workflow = parse(text, { uniqueKeys: true });
      for (const job of Object.values(workflow.jobs) as Array<{ "runs-on": string }>) {
        expect(job["runs-on"]).toBe("ubuntu-latest");
      }
      expect(text).not.toMatch(/CLOUDFLARE_API_TOKEN|CF_API_TOKEN|ENV_PRODUCTION|ENV_STAGING|CI_USE_SELF_HOSTED/);
    }
  });
});
