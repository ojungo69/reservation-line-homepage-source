import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

it("enforces the same native Node/npm policy at both install roots", () => {
  const contract = {
    engines: { node: ">=24.15.0 <25", npm: "12.2.2" },
    packageManager: "npm@12.2.2",
    devEngines: {
      runtime: { name: "node", version: ">=24.15.0 <25", onFail: "error" },
      packageManager: { name: "npm", version: "12.2.2", onFail: "error" },
    },
  };
  for (const prefix of ["", "admin-app/"]) {
    const manifest = JSON.parse(read(prefix + "package.json"));
    for (const [key, value] of Object.entries(contract)) expect(manifest[key]).toEqual(value);
    expect(read(prefix + ".npmrc")).toBe("engine-strict=true\n");
    expect(JSON.parse(read(prefix + "package-lock.json")).packages[""].engines).toEqual(contract.engines);
  }
  expect(JSON.parse(read("admin-app/package.json")).allowScripts).toEqual({});
});

it("attests the standalone bootstrap and its complete CI call structure", () => {
  const path = ".github/scripts/npm-toolchain.mjs";
  expect(createHash("sha256").update(read(path)).digest("hex")).toBe("10b03ce7f2a1e796dc7ca39c0f06aa61f816d6b5684047065316a211eb7ee6d7");
  const doc = parse(read(".github/workflows/ci.yml"));
  const steps = doc.jobs.validate.steps;
  const setup = steps.findIndex((step: { uses?: string }) => step.uses?.startsWith("actions/setup-node@"));
  const env = { TOOLCHAIN_DIRECTORY: "$" + "{{ steps.npm-toolchain.outputs.directory }}" };
  expect(steps[setup].with["node-version-file"]).toBe("package.json");
  expect(steps[setup].with["node-version"]).toBeUndefined();
  expect(steps[setup + 1]).toEqual({ name: "Bootstrap job-local npm", id: "npm-toolchain", shell: "bash", run: "node " + path + " bootstrap" });
  expect(steps[setup + 2]).toEqual({ name: "Verify project toolchain", shell: "bash", env, run: "node " + path + " verify" });
  expect(steps.at(-1)).toEqual({ name: "Cleanup job-local npm", if: "always()", shell: "bash", env, run: "node " + path + " cleanup" });
  const executableReferences = JSON.stringify(doc).replaceAll("--test-coverage-include='.github/scripts/npm-toolchain.mjs'", "");
  expect(executableReferences.split(path).length - 1).toBe(3);
});

function attestSetupNodeCache(content: string): number {
  const doc = parse(content);
  const steps = Object.keys(doc.jobs ?? {}).flatMap(name => doc.jobs[name].steps ?? []);
  const setup = steps.filter(step => step.uses?.startsWith("actions/setup-node@"));
  for (const step of setup) {
    expect(step.with?.["package-manager-cache"], "Automatic package cache must be disabled").toBe(false);
    expect(step.with?.cache, "Explicit package cache must be absent").toBeUndefined();
  }
  return setup.length;
}

it("disables both package cache paths in every setup-node step", () => {
  const files = readdirSync(new URL("../.github/workflows/", import.meta.url)).filter(file => /\.ya?ml$/.test(file));
  const count = files.reduce((sum, file) => sum + attestSetupNodeCache(read(".github/workflows/" + file)), 0);
  expect(count).toBe(3);
});

it.each([
  {}, { "package-manager-cache": true },
  { "package-manager-cache": false, cache: "npm" },
  { "package-manager-cache": false, cache: "yarn" },
])("rejects package cache inputs before the pinned npm exists: %j", inputs => {
  const doc = parse(read(".github/workflows/sonarqube.yml"));
  const setup = doc.jobs.analyze.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/setup-node@"));
  setup.with = { "node-version": 24, ...inputs };
  expect(() => attestSetupNodeCache(JSON.stringify(doc))).toThrow(/package cache/);
});
