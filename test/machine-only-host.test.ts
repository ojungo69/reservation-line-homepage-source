import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { WorkerBindings } from "../src/bindings";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

// instance-config.json lists machine.example.invalid as a machine-only host.
const MACHINE_HOST = "machine.example.invalid";

const send = async (host: string, path: string, environment: string, init: RequestInit = {}) => {
  const db = createMigratedSqliteD1();
  const assets = { fetch: vi.fn(async () => new Response("public asset stub", { status: 200 })) };
  try {
    return await worker.fetch(
      new Request(`https://${host}${path}`, { ...init, headers: { host, ...init.headers } }),
      { DB: db, ENVIRONMENT: environment, ASSETS: assets } as unknown as WorkerBindings,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext
    );
  } finally {
    db.sqlite.close();
  }
};

describe("machine-only host", () => {
  it.each(["/", "/index.html", "/source", "/api/public/availability?storeId=kyoto"])(
    "returns 404 for %s in production",
    async (path) => {
      expect((await send(MACHINE_HOST, path, "production")).status).toBe(404);
    }
  );

  it("refuses a reservation submission in production", async () => {
    const response = await send(MACHINE_HOST, "/api/public/reservations", "production", {
      method: "POST", body: "{}", headers: { "content-type": "application/json" }
    });
    expect(response.status).toBe(404);
  });

  it("keeps the probes and the signed webhooks reachable in production", async () => {
    expect((await send(MACHINE_HOST, "/api/health", "production")).status).toBe(200);
    expect((await send(MACHINE_HOST, "/api/public/reservation-options", "production")).status).not.toBe(404);
    const line = await send(MACHINE_HOST, "/api/line/webhook", "production", {
      method: "POST", body: "{}", headers: { "content-type": "application/json", "x-line-signature": "invalid" }
    });
    expect(line.status).not.toBe(404);
    const google = await send(MACHINE_HOST, "/api/google/calendar/webhook", "production", { method: "POST", body: "{}" });
    expect(google.status).not.toBe(404);
  });

  it("serves the public pages on the public host and outside production", async () => {
    expect((await send("reserve.example.invalid", "/", "production")).status).toBe(200);
    expect((await send(MACHINE_HOST, "/", "staging")).status).toBe(200);
  });
});
