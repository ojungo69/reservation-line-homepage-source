import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { resolveHumanAdmin } from "../src/admin/access";
import { listPublicAvailability, listPublicReservationOptions } from "../src/reservations/public-options";
import { createPublicReservation } from "../src/reservations/public-submit";
import { SqliteD1Database } from "./helpers/sqlite-d1";

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

describe("trusted Sonar coverage import", () => {
  const directories: string[] = [];
  const workflow = parse(readFileSync(new URL("../.github/workflows/sonarqube.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.analyze.steps as Array<{
    name: string;
    id?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
  }>;
  const prepare = steps.find(step => step.name === "Prepare coverage destination")!;
  const download = steps.find(step => step.name === "Download coverage from CI")!;
  const importReports = steps.find(step => step.name === "Import validated coverage reports");
  const validate = steps.find(step => step.name === "Validate analysis inputs")!;
  const reports = ["coverage/lcov.info", "admin-app/coverage/lcov.info"];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  const fixture = () => {
    const directory = mkdtempSync(join(tmpdir(), "public-sonar-coverage-"));
    directories.push(directory);
    const workspace = join(directory, "checkout");
    const runnerTemp = join(directory, "runner-temp");
    const githubOutput = join(directory, "github-output");
    for (const path of ["src", "public", "admin-app/src", ".git"]) mkdirSync(join(workspace, path), { recursive: true });
    mkdirSync(runnerTemp);
    writeFileSync(githubOutput, "");
    writeFileSync(join(workspace, "src/app.ts"), "export const source = 'checked-out revision';\n");
    writeFileSync(join(workspace, "admin-app/src/app.ts"), "export const source = 'checked-out admin';\n");
    writeFileSync(join(workspace, ".git/config"), "[core]\n\tbare = false\n");
    const env = { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: githubOutput };
    const run = (step: { run?: string }, extra: Record<string, string> = {}) => spawnSync("bash", ["-c", step.run ?? ""], {
      cwd: workspace, env: { ...env, ...extra }, encoding: "utf8", timeout: 5000
    });
    const prepared = run(prepare);
    expect(prepared.status, prepared.stderr).toBe(0);
    const output = Object.fromEntries(readFileSync(githubOutput, "utf8").trim().split("\n").filter(Boolean).map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    // Replay the actual destination, including the old unsafe workspace path.
    const artifact = download.with?.path === "." ? workspace : output.artifact_directory;
    expect(artifact).toBeTruthy();
    for (const [index, report] of reports.entries()) {
      mkdirSync(dirname(join(artifact, report)), { recursive: true });
      writeFileSync(join(artifact, report), `TN:\nSF:${index === 0 ? "src/app.ts" : "admin-app/src/app.ts"}\nDA:1,1\nend_of_record\n`);
    }
    const ingest = () => run(importReports ?? {}, { COVERAGE_ARTIFACT_DIR: artifact });
    return { directory, workspace, runnerTemp, artifact, run, ingest };
  };

  it("keeps artifact source and Git configuration entries out of the checkout", () => {
    const f = fixture();
    const protectedPaths = ["src/app.ts", ".git/config"];
    const originals = protectedPaths.map(path => readFileSync(join(f.workspace, path)));
    for (const path of protectedPaths) {
      mkdirSync(dirname(join(f.artifact, path)), { recursive: true });
      writeFileSync(join(f.artifact, path), "artifact replacement\n");
    }
    const imported = f.ingest();
    expect(imported.status, imported.stderr).toBe(0);
    const validated = f.run(validate);
    expect(validated.status, validated.stderr).toBe(0);
    protectedPaths.forEach((path, index) => expect(readFileSync(join(f.workspace, path))).toEqual(originals[index]));
    expect(dirname(f.artifact)).toBe(f.runnerTemp);
    for (const report of reports) expect(readFileSync(join(f.workspace, report))).toEqual(readFileSync(join(f.artifact, report)));
    expect(prepare.id).toBe("coverage_destination");
    expect(download.with?.path).toBe("${{ steps.coverage_destination.outputs.artifact_directory }}");
    expect(importReports?.env?.COVERAGE_ARTIFACT_DIR).toBe(download.with?.path);
  });

  it.each(reports.flatMap(report => ["missing", "empty", "symlink", "directory"].map(kind => [report, kind])))
    ("rejects a %s report that is %s before copying either report", (report, kind) => {
      const f = fixture();
      const path = join(f.artifact, report);
      rmSync(path);
      if (kind === "empty") writeFileSync(path, "");
      if (kind === "symlink") symlinkSync(join(f.workspace, "src/app.ts"), path);
      if (kind === "directory") mkdirSync(path);
      expect(f.ingest().status).not.toBe(0);
      for (const target of reports) expect(existsSync(join(f.workspace, target))).toBe(false);
    });

  it.each(["", "coverage", "admin-app", "admin-app/coverage"])
    ("rejects a symlink in the report parent path %s before copying", (parent) => {
      const f = fixture();
      const path = join(f.artifact, parent);
      const moved = join(f.directory, "moved-artifact-parent");
      renameSync(path, moved);
      symlinkSync(moved, path);
      expect(f.ingest().status).not.toBe(0);
      for (const target of reports) expect(existsSync(join(f.workspace, target))).toBe(false);
    });
});

describe("one-store OSS installation", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  const freshDatabase = () => {
    const sqlite = new DatabaseSync(":memory:");
    databases.push(sqlite);
    sqlite.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    return new SqliteD1Database(sqlite);
  };

  it.each(["config", "database"])("documented setup stops before overwriting existing %s", (existing) => {
    const directory = mkdtempSync(join(tmpdir(), "oss-install-guard-"));
    try {
      const bin = join(directory, "bin");
      mkdirSync(bin);
      // A broken guide must not run real package-manager/network operations in this test.
      writeFileSync(join(bin, "npm"), "#!/bin/sh\nprintf called > setup-started\nexit 0\n", { mode: 0o700 });
      writeFileSync(join(directory, ".env.example"), "replacement\n");
      const config = join(directory, ".dev.vars");
      if (existing === "config") writeFileSync(config, "preserve-existing-config\n");
      else mkdirSync(join(directory, ".wrangler/oss-install"), { recursive: true });
      const guide = readFileSync(new URL("../docs/INSTALL.md", import.meta.url), "utf8");
      const commands = guide.split("```sh\n")[1]?.split("```")[0];
      expect(commands).toBeTruthy();
      const result = spawnSync("sh", ["-c", commands ?? ""], {
        cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
      });
      expect(result.status).toBe(1);
      expect(readdirSync(directory)).not.toContain("setup-started");
      if (existing === "config") expect(readFileSync(config, "utf8")).toBe("preserve-existing-config\n");
      else expect(readdirSync(directory)).not.toContain(".dev.vars");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("initializes one fictional store with a public menu, capacity and a pending human owner", async () => {
    const database = freshDatabase();
    database.sqlite.exec(readFileSync(new URL("../seeds/bootstrap.sql", import.meta.url), "utf8"));

    const options = await listPublicReservationOptions({
      db: database as unknown as D1Database,
      env: {}
    });
    expect(options.ok).toBe(true);
    if (!options.ok) throw new Error(options.reason);
    expect(options.stores.map((store) => store.id)).toEqual(["kyoto"]);
    expect(options.services.map((service) => service.id)).toEqual(["service_kyoto_bootstrap"]);
    expect(options.resources.map((resource) => resource.id)).toEqual(["resource_kyoto_bootstrap"]);
    expect(options.businessHours).toHaveLength(7);
    expect(database.sqlite.prepare(
      "SELECT email, role, access_subject, active, is_service_token FROM admin_users"
    ).all()).toEqual([{
      email: "owner@example.invalid",
      role: "owner",
      access_subject: "pending:bootstrap-owner",
      active: 1,
      is_service_token: 0
    }]);
    expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    "INSERT INTO stores (id, name) VALUES ('existing', 'Existing Store')",
    "INSERT INTO admin_users (id, email, access_subject, role, active) VALUES ('existing', 'existing@example.invalid', 'pending:existing', 'owner', 0)",
    "INSERT INTO customers (id, display_name) VALUES ('existing', 'Existing Customer')"
  ])("refuses existing core data before adding a store or owner: %s", (existingSql) => {
    const database = freshDatabase();
    database.sqlite.exec(existingSql);
    const adminsBefore = database.sqlite.prepare("SELECT * FROM admin_users ORDER BY id").all();
    const storesBefore = database.sqlite.prepare("SELECT * FROM stores ORDER BY id").all();
    const customersBefore = database.sqlite.prepare("SELECT * FROM customers ORDER BY id").all();

    expect(() => database.sqlite.exec(
      readFileSync(new URL("../seeds/bootstrap.sql", import.meta.url), "utf8")
    )).toThrow("NOT NULL constraint failed: stores.name");
    expect(database.sqlite.prepare("SELECT * FROM admin_users ORDER BY id").all()).toEqual(adminsBefore);
    expect(database.sqlite.prepare("SELECT * FROM stores ORDER BY id").all()).toEqual(storesBefore);
    expect(database.sqlite.prepare("SELECT * FROM customers ORDER BY id").all()).toEqual(customersBefore);
  });

  it("binds only the pre-registered verified owner and never reactivates that owner on rerun", async () => {
    const database = freshDatabase();
    const bootstrap = readFileSync(new URL("../seeds/bootstrap.sql", import.meta.url), "utf8");
    database.sqlite.exec(bootstrap);
    const db = database as unknown as D1Database;
    const now = "2030-01-01T00:00:00.000Z";
    const principal = { email: "owner@example.invalid", sub: "verified-owner-subject" };

    expect(await resolveHumanAdmin(db, { ...principal, email: "other@example.invalid" }, now))
      .toEqual({ ok: false, reason: "admin_not_registered" });
    expect(await resolveHumanAdmin(db, principal, now)).toMatchObject({
      ok: true, admin: { role: "owner", store_id: "kyoto" }
    });
    expect(await resolveHumanAdmin(db, { ...principal, sub: "different-subject" }, now))
      .toEqual({ ok: false, reason: "admin_not_registered" });

    database.sqlite.exec("UPDATE admin_users SET active = 0");
    const before = database.sqlite.prepare("SELECT * FROM admin_users").all();
    expect(() => database.sqlite.exec(bootstrap)).toThrow("NOT NULL constraint failed: stores.name");
    expect(await resolveHumanAdmin(db, principal, now))
      .toEqual({ ok: false, reason: "admin_not_registered" });
    expect(database.sqlite.prepare("SELECT * FROM admin_users").all()).toEqual(before);
  });

  it("offers a slot and creates a pending reservation with an already verified fixture identity", async () => {
    const database = freshDatabase();
    database.sqlite.exec(readFileSync(new URL("../seeds/bootstrap.sql", import.meta.url), "utf8"));
    const db = database as unknown as D1Database;
    const env = { GOOGLE_LIVE_AVAILABILITY_ENABLED: "false", GOOGLE_IMPORT_ENABLED: "false" };
    const now = () => Date.parse("2030-01-01T00:00:00.000Z");
    const availability = await listPublicAvailability({
      db, env, now, storeId: "kyoto", serviceId: "service_kyoto_bootstrap",
      resourceId: "resource_kyoto_bootstrap", date: "2030-01-02"
    });
    expect(availability.ok).toBe(true);
    if (!availability.ok) throw new Error(availability.reason);
    expect(availability.availabilityStatus).toBe("ready");
    expect(availability.slots.length).toBeGreaterThan(0);
    const slot = availability.slots[0];
    if (!slot) throw new Error("Bootstrap must advertise a bookable slot");

    const options = await listPublicReservationOptions({ db, env });
    if (!options.ok) throw new Error(options.reason);
    const result = await createPublicReservation({
      db, env, now,
      line: { lineUserId: "fixture-line-user", channelId: "fixture-login-channel" },
      request: {
        idempotencyKey: "bootstrap-booking", storeId: "kyoto",
        serviceId: "service_kyoto_bootstrap", resourceId: "resource_kyoto_bootstrap",
        startAt: slot.startAt,
        customer: { displayName: "Example Customer", phone: "09000000000" },
        consents: {
          noticeVersion: options.consentVersions.notice,
          cancellationPolicyVersion: options.consentVersions.cancellationPolicy,
          privacyPolicyVersion: options.consentVersions.privacyPolicy
        }
      }
    });
    expect(result).toMatchObject({
      ok: true, status: "pending_approval", storeId: "kyoto",
      startAt: slot.startAt, endAt: slot.endAt
    });
    expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
