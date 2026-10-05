import { describe, expect, it } from "vitest";

import { buildImportDisabledLog, classifyReservationQueue } from "../src/index";
import {
  D1_DR_FREEZE_MAINTENANCE_MODE,
  isD1DrFreezeMaintenanceMode,
  isGoogleImportEnabled
} from "../src/runtime-config";

describe("worker runtime configuration", () => {
  it("enables Google Calendar import by default", () => {
    expect(isGoogleImportEnabled({})).toBe(true);
  });

  it("can disable Google Calendar import for MVP outbound-only operation", () => {
    expect(isGoogleImportEnabled({ GOOGLE_IMPORT_ENABLED: "false" })).toBe(false);
  });

  it("enables D1 DR freeze maintenance mode only for the explicit sentinel value", () => {
    expect(isD1DrFreezeMaintenanceMode({ MAINTENANCE_MODE: D1_DR_FREEZE_MAINTENANCE_MODE })).toBe(true);
    expect(isD1DrFreezeMaintenanceMode({ MAINTENANCE_MODE: "true" })).toBe(false);
    expect(isD1DrFreezeMaintenanceMode({})).toBe(false);
  });

  it("allows the emergency D1 freeze secret to override the normal maintenance variable", () => {
    expect(isD1DrFreezeMaintenanceMode({ EMERGENCY_D1_FREEZE: "true" })).toBe(true);
    expect(
      isD1DrFreezeMaintenanceMode({
        MAINTENANCE_MODE: "",
        EMERGENCY_D1_FREEZE: "true"
      })
    ).toBe(true);
    expect(isD1DrFreezeMaintenanceMode({ EMERGENCY_D1_FREEZE: "false" })).toBe(false);
  });

});

describe("import-disabled observability payload", () => {
  it("emits a stable structured payload Cloudflare Tail can filter on", () => {
    const payload = JSON.parse(buildImportDisabledLog({ ENVIRONMENT: "staging" }));
    expect(payload).toEqual({
      event_type: "scheduled_handler_google_import_disabled",
      outcome: "noop",
      environment: "staging"
    });
  });

  it("falls back to environment='unknown' when ENVIRONMENT is missing or non-string", () => {
    const missing = JSON.parse(buildImportDisabledLog({}));
    expect(missing.environment).toBe("unknown");
    const nonString = JSON.parse(buildImportDisabledLog({ ENVIRONMENT: 123 as unknown as string }));
    expect(nonString.environment).toBe("unknown");
  });

  it("never embeds secrets — only the env name is surfaced", () => {
    const payload = buildImportDisabledLog({
      ENVIRONMENT: "production",
      LINE_CHANNEL_SECRET: "should-not-leak",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "should-not-leak"
    } as unknown as Partial<{
      ENVIRONMENT: string;
      LINE_CHANNEL_SECRET: string;
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
    }>);
    expect(payload).not.toContain("should-not-leak");
  });
});

describe("queue routing", () => {
  it("recognizes local and environment-specific Google sync queues", () => {
    expect(classifyReservationQueue("reservation-google-sync")).toBe("google_sync");
    expect(classifyReservationQueue("reservation-line-homepage-staging-google-sync")).toBe("google_sync");
    expect(classifyReservationQueue("reservation-line-homepage-production-google-sync")).toBe("google_sync");
  });

  it("recognizes local and environment-specific LINE notification queues", () => {
    expect(classifyReservationQueue("reservation-line-notifications")).toBe("line_notifications");
    expect(classifyReservationQueue("reservation-line-homepage-staging-line-notifications")).toBe("line_notifications");
    expect(classifyReservationQueue("reservation-line-homepage-production-line-notifications")).toBe("line_notifications");
  });

  it("recognizes dead-letter queues for all environments", () => {
    expect(classifyReservationQueue("reservation-google-sync-dlq")).toBe("dead_letter");
    expect(classifyReservationQueue("reservation-line-notifications-dlq")).toBe("dead_letter");
    expect(classifyReservationQueue("reservation-line-homepage-staging-google-sync-dlq")).toBe("dead_letter");
    expect(classifyReservationQueue("reservation-line-homepage-staging-line-notifications-dlq")).toBe("dead_letter");
    expect(classifyReservationQueue("reservation-line-homepage-production-google-sync-dlq")).toBe("dead_letter");
    expect(classifyReservationQueue("reservation-line-homepage-production-line-notifications-dlq")).toBe("dead_letter");
  });

  it("rejects unknown queue names instead of silently acknowledging them", () => {
    expect(classifyReservationQueue("reservation-line-homepage-production-other")).toBeUndefined();
  });
});
