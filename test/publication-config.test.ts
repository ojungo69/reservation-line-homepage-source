import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    const options = await listPublicReservationOptions({ db, env });
    if (!options.ok) throw new Error(options.reason);
    const result = await createPublicReservation({
      db, env, now,
      line: { lineUserId: "fixture-line-user", channelId: "fixture-login-channel" },
      request: {
        idempotencyKey: "bootstrap-booking", storeId: "kyoto",
        serviceId: "service_kyoto_bootstrap", resourceId: "resource_kyoto_bootstrap",
        startAt: "2030-01-02T01:00:00.000Z",
        customer: { displayName: "Example Customer", phone: "09000000000" },
        consents: {
          noticeVersion: options.consentVersions.notice,
          cancellationPolicyVersion: options.consentVersions.cancellationPolicy,
          privacyPolicyVersion: options.consentVersions.privacyPolicy
        }
      }
    });
    expect(result).toMatchObject({ ok: true, status: "pending_approval", storeId: "kyoto" });
    expect(database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
