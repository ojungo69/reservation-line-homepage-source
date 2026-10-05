import { describe, expect, it } from "vitest";

import { __testing__ } from "../src/google/import-sync";
import { __testing__ as burstTesting } from "../src/google/conflict-burst-detector";
import { __testing__ as driftTesting } from "../src/google/drift-threshold-alert";

const { MAX_DEDUPE_KEY_LENGTH, stableHash, compactDedupeKey } = __testing__;
const { sha256Hex16 } = driftTesting;
const {
  CONFLICT_BURST_WINDOW_SECONDS,
  sha256Hex16: burstSha256Hex16
} = burstTesting;

// Regression guards for the dedupe_key hashing surface. None of these
// assertions prove cryptographic uniqueness (that's mathematically impossible
// for any truncated hash) — they only prove the implementations produce
// distinct outputs across the realistic scale this codebase operates at.
//
// If a future writer shortens the hash window (`stableHash` to <64 bits or
// `sha256Hex16` to <128 bits), one of these tests will fire on the smaller
// surface long before a production collision could land.

// ---------------------------------------------------------------------------
// Birthday paradox math helpers
// ---------------------------------------------------------------------------

/**
 * Computes the approximate collision probability for `n` items drawn
 * from a hash space of `2^bits` using the birthday-paradox formula:
 *   P(collision) ≈ 1 − exp(−n² / (2 × 2^bits))
 *
 * Returns a number in [0, 1].
 */
const birthdayCollisionProbability = (n: number, bits: number): number => {
  // For bits > 53 we cannot use plain JS numbers — use logarithmic form.
  // ln(P) ≈ −n² / (2 × 2^bits)  →  P ≈ exp(−n² / 2^(bits+1))
  const logP = -(n * n) / Math.pow(2, bits + 1);
  return 1 - Math.exp(logP);
};

describe("birthday paradox collision probability bounds", () => {
  it("FNV-64 (64 bits): collision probability at 10K inputs is negligibly small", () => {
    const p = birthdayCollisionProbability(10_000, 64);
    // 10K draws from 2^64 → P ≈ 2.7e-12, effectively zero.
    expect(p).toBeLessThan(1e-9);
  });

  it("FNV-64 (64 bits): collision probability at 100K inputs is still safe", () => {
    const p = birthdayCollisionProbability(100_000, 64);
    // 100K draws from 2^64 → P ≈ 2.7e-10, still negligible.
    expect(p).toBeLessThan(1e-6);
  });

  it("FNV-64 (64 bits): collision probability at 1M inputs remains sub-1e-7", () => {
    const p = birthdayCollisionProbability(1_000_000, 64);
    // 1M draws from 2^64 → P ≈ 2.7e-8.
    expect(p).toBeLessThan(1e-6);
  });

  it("FNV-64 (64 bits): birthday bound (~4.3 billion) would push probability near 50%", () => {
    // sqrt(2^64) ≈ 4.3e9 — at this scale collision probability approaches 50%.
    const p = birthdayCollisionProbability(4_300_000_000, 64);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.7);
  });

  it("SHA-256/16B (128 bits): collision probability at 100K inputs is astronomically small", () => {
    const p = birthdayCollisionProbability(100_000, 128);
    // 100K draws from 2^128 → P ≈ 1.5e-29, unmeasurable.
    expect(p).toBeLessThan(1e-20);
  });

  it("SHA-256/16B (128 bits): safe even at 10 billion inputs", () => {
    const p = birthdayCollisionProbability(10_000_000_000, 128);
    // 10B draws from 2^128 → P ≈ 1.5e-20, still safe.
    expect(p).toBeLessThan(1e-10);
  });
});

describe("compactDedupeKey FNV-64 collision math", () => {
  it("returns the raw key unchanged when length <= MAX_DEDUPE_KEY_LENGTH", () => {
    const short = "a".repeat(MAX_DEDUPE_KEY_LENGTH);
    expect(compactDedupeKey(short, "ignored")).toBe(short);
    const ultraShort = "google_calendar:sync:full_reconcile:2027-01-15";
    expect(compactDedupeKey(ultraShort, "ignored")).toBe(ultraShort);
  });

  it("compacts to '<prefix>:<16hex>' when the raw key exceeds MAX_DEDUPE_KEY_LENGTH", () => {
    const long = "x".repeat(MAX_DEDUPE_KEY_LENGTH + 1);
    const compacted = compactDedupeKey(long, "prefix");
    expect(compacted.startsWith("prefix:")).toBe(true);
    expect(compacted.slice("prefix:".length)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces distinct 16-hex hashes for 10,000 sequential synthetic keys (FNV-64 uniformity guard)", () => {
    const hashes = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      // Inputs vary across the full 64-bit input space pattern by combining
      // the index with a fixed prefix; a regression in stableHash that
      // collapses entropy (e.g. dropping high bits) would surface as
      // duplicate outputs within this loop.
      const hashed = stableHash(`google_calendar:sync:full_reconcile:row-${index}:tail-${index * 31}`);
      hashes.add(hashed);
    }
    expect(hashes.size).toBe(10_000);
  });

  it("produces distinct hashes for 100,000 synthetic keys — stress test at 10x scale", () => {
    const hashes = new Set<string>();
    for (let index = 0; index < 100_000; index += 1) {
      const hashed = stableHash(`stress:${index}:discriminator:${index ^ 0x5a5a5a5a}`);
      hashes.add(hashed);
    }
    expect(hashes.size).toBe(100_000);
  });

  it("compactDedupeKey is deterministic — same input always produces the same compact output", () => {
    const long = `prefix:${"y".repeat(MAX_DEDUPE_KEY_LENGTH + 50)}`;
    const first = compactDedupeKey(long, "tag");
    const second = compactDedupeKey(long, "tag");
    expect(first).toBe(second);
  });

  it("compactDedupeKey respects the prefix argument (different prefixes give different outputs even for the same raw key)", () => {
    const long = "z".repeat(MAX_DEDUPE_KEY_LENGTH + 1);
    const compactedA = compactDedupeKey(long, "alpha");
    const compactedB = compactDedupeKey(long, "beta");
    // The hash suffix is the same (same rawKey), but the prefix is the
    // discriminator.
    expect(compactedA).not.toBe(compactedB);
    expect(compactedA.split(":")[1]).toBe(compactedB.split(":")[1]);
  });

  it("notification_jobs key pattern: unique across stores × templates × 10K reservation ids", () => {
    const stores = ["kyoto", "nagoya", "osaka", "wakayama"];
    const templates = ["reservation_confirmed", "reservation_cancelled", "change_request_received"];
    const keys = new Set<string>();
    for (const storeId of stores) {
      for (const template of templates) {
        for (let i = 0; i < 10_000; i += 1) {
          const rawKey = `notification:${template}:store:${storeId}:reservation:res-${i}:v1`;
          const compacted = compactDedupeKey(rawKey, `notif:${template}`);
          keys.add(compacted);
        }
      }
    }
    // 4 stores × 3 templates × 10K = 120K keys — all fit under 256 chars
    // so they go through as raw keys (no hash needed). Still proves uniqueness
    // of the string structure.
    expect(keys.size).toBe(120_000);
  });

  it("calendar_sync_jobs key pattern: unique across owner types × actions × event ids", () => {
    // Mirrors the production patterns from import-sync.ts:
    //   external_block:<blockId>:google:upsert:restore:<eventId>
    //   reservation:<reservationId>:google:upsert:revert:<eventId>:etag:<etag>
    const keys = new Set<string>();
    for (let blockId = 0; blockId < 5_000; blockId += 1) {
      const raw = `external_block:eb-${blockId}:google:upsert:restore:evt-${blockId}`;
      keys.add(compactDedupeKey(raw, "calendar-sync:external-block-restore"));
    }
    for (let resId = 0; resId < 5_000; resId += 1) {
      const raw = `reservation:res-${resId}:google:upsert:revert:evt-${resId}:etag:etag-${resId}`;
      keys.add(compactDedupeKey(raw, "calendar-sync:reservation-revert"));
    }
    expect(keys.size).toBe(10_000);
  });

  it("edge case: same store_id but different timestamps produce distinct keys", () => {
    const store = "kyoto";
    const timestamps = [
      "2026-05-01T09:00",
      "2026-05-01T09:15",
      "2026-05-01T10:00",
      "2026-05-02T09:00",
      "2026-06-01T09:00"
    ];
    const keys = new Set(
      timestamps.map((ts) =>
        compactDedupeKey(`${store}:cron_incremental:${ts}`, "google-import:cron")
      )
    );
    expect(keys.size).toBe(timestamps.length);
  });

  it("edge case: same timestamp but different store_ids produce distinct keys", () => {
    const timestamp = "2026-05-01T09:00";
    const stores = ["kyoto", "nagoya", "osaka", "wakayama", "tokyo"];
    const keys = new Set(
      stores.map((store) =>
        compactDedupeKey(`cal-${store}@gmail.com:cron_incremental:${timestamp}`, "google-import:cron")
      )
    );
    expect(keys.size).toBe(stores.length);
  });

  it("edge case: nearly identical inputs with one-character difference produce distinct hashes", () => {
    const base = "x".repeat(MAX_DEDUPE_KEY_LENGTH + 10);
    const variant1 = base + "a";
    const variant2 = base + "b";
    const hash1 = stableHash(variant1);
    const hash2 = stableHash(variant2);
    expect(hash1).not.toBe(hash2);
  });
});

describe("google_drift_alert SHA-256/16-byte dedupe collision math", () => {
  it("sha256Hex16 returns exactly 32 hex characters (128 bits)", async () => {
    const hashed = await sha256Hex16("calendar_id_1");
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sha256Hex16 is deterministic — same input always produces the same 32-hex output", async () => {
    const inputs = ["calendar-a@example.invalid", "U" + "a".repeat(32), "store_kyoto"];
    for (const input of inputs) {
      const a = await sha256Hex16(input);
      const b = await sha256Hex16(input);
      expect(a).toBe(b);
    }
  });

  it("produces unique drift dedupe_keys for 90 days x 4 stores x 4 calendars x 10 recipients (14,400 tuples)", async () => {
    // Mirrors the dedupe_key shape from src/google/import-sync.ts:enqueueDriftAlertNotifications:
    //   google_drift_alert:v1:<utcDate>:store:<storeId>:cal:<sha256-16B>:recipient:<sha256-16B>
    // Scale: 90 day window x 4 store fixture x 4 calendars x 10 recipients =
    // 14,400 distinct tuples. A FNV-64 truncation would surface a collision
    // around the birthday-paradox bound (~5e9), so 14,400 must be unique with
    // overwhelming probability for the 128-bit truncated SHA.
    const stores = ["kyoto", "nagoya", "osaka", "wakayama"];
    const calendars = stores.map((s) => `calendar-${s}@example.invalid`);
    const recipients = Array.from({ length: 10 }, (_, i) => "U" + String(i).padStart(32, "0"));

    // Pre-compute calendar + recipient hashes once. Without memoization the
    // nested loop runs sha256Hex16 90 x 4 x 4 x 10 = 14,400 times against
    // only 14 distinct inputs (4 calendars + 10 recipients), which slows the
    // test by an order of magnitude with no added coverage.
    const calHashByCalendarId = new Map<string, string>();
    for (const calendarId of calendars) {
      calHashByCalendarId.set(calendarId, await sha256Hex16(calendarId));
    }
    const recHashByRecipientId = new Map<string, string>();
    for (const recipientId of recipients) {
      recHashByRecipientId.set(recipientId, await sha256Hex16(recipientId));
    }

    const keys = new Set<string>();
    for (let dayOffset = 0; dayOffset < 90; dayOffset += 1) {
      const baseMs = Date.UTC(2026, 4, 19) + dayOffset * 24 * 60 * 60 * 1000;
      const utcDate = new Date(baseMs).toISOString().slice(0, 10);
      for (const storeId of stores) {
        for (const calendarId of calendars) {
          const calHash = calHashByCalendarId.get(calendarId);
          for (const recipientId of recipients) {
            const recHash = recHashByRecipientId.get(recipientId);
            const key = `google_drift_alert:v1:${utcDate}:store:${storeId}:cal:${calHash}:recipient:${recHash}`;
            keys.add(key);
          }
        }
      }
    }
    expect(keys.size).toBe(14_400);
  });

  it("recipient hash hides the raw LINE userId (no substring leak)", async () => {
    const recipient = "Uowner_secret_handle_12345";
    const hashed = await sha256Hex16(recipient);
    expect(hashed).not.toContain("owner");
    expect(hashed).not.toContain("secret");
    expect(hashed).not.toContain(recipient);
  });

  it("calendar hash differs across the production 4-store calendar set (no accidental aliasing)", async () => {
    const calendars = [
      "calendar-a@example.invalid",
      "calendar-c@example.invalid",
      "calendar-b@example.invalid",
      "calendar-d@example.invalid"
    ];
    const hashes = await Promise.all(calendars.map(sha256Hex16));
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(calendars.length);
  });

  it("sha256Hex16 produces 10,000 unique outputs for synthetic LINE userIds", async () => {
    // Stress test: 10K distinct recipients through the truncated SHA-256
    // path used for drift_alert recipient hashing. Birthday-paradox bound
    // for 128 bits is ~1.8e19, so 10K must be collision-free.
    // Note: sha256Hex16 is async (crypto.subtle.digest), so we batch in
    // chunks of 500 via Promise.all to stay within the test timeout while
    // still exercising meaningful scale.
    const BATCH_SIZE = 500;
    const TOTAL = 10_000;
    const hashes = new Set<string>();
    for (let offset = 0; offset < TOTAL; offset += BATCH_SIZE) {
      const batch = Array.from({ length: Math.min(BATCH_SIZE, TOTAL - offset) }, (_, i) => {
        const idx = offset + i;
        return sha256Hex16(`U${String(idx).padStart(32, "0")}`);
      });
      const results = await Promise.all(batch);
      for (const h of results) {
        hashes.add(h);
      }
    }
    expect(hashes.size).toBe(TOTAL);
  });
});

describe("google_conflict_burst_alert dedupe collision math", () => {
  it("conflict burst sha256Hex16 returns exactly 32 hex characters", async () => {
    const hashed = await burstSha256Hex16("test_calendar@gmail.com");
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
  });

  it("conflict burst sha256Hex16 matches import-sync sha256Hex16 — same algorithm", async () => {
    // Both modules define their own sha256Hex16. Verify they produce
    // identical output for the same input (no copy-paste divergence).
    const input = "calendar-a@example.invalid";
    const fromImportSync = await sha256Hex16(input);
    const fromBurstDetector = await burstSha256Hex16(input);
    expect(fromImportSync).toBe(fromBurstDetector);
  });

  it("produces unique burst dedupe_keys for 288 windows x 4 stores x 4 calendars x 10 recipients (46,080 tuples)", async () => {
    // Mirrors the dedupe_key shape from conflict-burst-detector.ts:
    //   google_conflict_burst_alert:v1:<windowBucket>:store:<storeId>:cal:<sha256-16B>:recipient:<sha256-16B>
    // Scale: 288 5-minute windows in 24 hours x 4 stores x 4 calendars x
    // 10 recipients = 46,080 distinct tuples.
    const stores = ["kyoto", "nagoya", "osaka", "wakayama"];
    const calendars = stores.map((s) => `calendar-${s}@example.invalid`);
    const recipients = Array.from({ length: 10 }, (_, i) => "U" + String(i).padStart(32, "0"));

    const calHashByCalendarId = new Map<string, string>();
    for (const calendarId of calendars) {
      calHashByCalendarId.set(calendarId, await burstSha256Hex16(calendarId));
    }
    const recHashByRecipientId = new Map<string, string>();
    for (const recipientId of recipients) {
      recHashByRecipientId.set(recipientId, await burstSha256Hex16(recipientId));
    }

    // Base timestamp: 2026-05-19T00:00:00Z
    const baseMsForBuckets = Date.UTC(2026, 4, 19, 0, 0, 0);
    const windowMs = CONFLICT_BURST_WINDOW_SECONDS * 1000;
    const windowsPerDay = 288; // 24h / 5min = 288

    const keys = new Set<string>();
    for (let windowIdx = 0; windowIdx < windowsPerDay; windowIdx += 1) {
      const nowMs = baseMsForBuckets + windowIdx * windowMs;
      const windowBucket = Math.floor(nowMs / windowMs);
      for (const storeId of stores) {
        for (const calendarId of calendars) {
          const calHash = calHashByCalendarId.get(calendarId);
          for (const recipientId of recipients) {
            const recHash = recHashByRecipientId.get(recipientId);
            const key = `google_conflict_burst_alert:v1:${windowBucket}:store:${storeId}:cal:${calHash}:recipient:${recHash}`;
            keys.add(key);
          }
        }
      }
    }
    expect(keys.size).toBe(46_080);
  });

  it("edge case: same window bucket + same store but different calendar produces distinct keys", async () => {
    const windowBucket = 123456;
    const storeId = "kyoto";
    const calendars = [
      "calendar-a@example.invalid",
      "calendar-c@example.invalid",
      "calendar-b@example.invalid"
    ];
    const recipientHash = await burstSha256Hex16("Urecipient");
    const keys = new Set<string>();
    for (const calendarId of calendars) {
      const calHash = await burstSha256Hex16(calendarId);
      keys.add(`google_conflict_burst_alert:v1:${windowBucket}:store:${storeId}:cal:${calHash}:recipient:${recipientHash}`);
    }
    expect(keys.size).toBe(calendars.length);
  });

  it("edge case: same calendar + same recipient but different window buckets produce distinct keys", async () => {
    const storeId = "kyoto";
    const calHash = await burstSha256Hex16("calendar-a@example.invalid");
    const recHash = await burstSha256Hex16("Urecipient001");
    const buckets = [100000, 100001, 100002, 100003, 100004];
    const keys = new Set(
      buckets.map((bucket) =>
        `google_conflict_burst_alert:v1:${bucket}:store:${storeId}:cal:${calHash}:recipient:${recHash}`
      )
    );
    expect(keys.size).toBe(buckets.length);
  });

  it("edge case: same window + same calendar but different stores produce distinct keys", async () => {
    const windowBucket = 999999;
    const stores = ["kyoto", "nagoya", "osaka", "wakayama"];
    const calHash = await burstSha256Hex16("calendar-a@example.invalid");
    const recHash = await burstSha256Hex16("Urecipient001");
    const keys = new Set(
      stores.map((storeId) =>
        `google_conflict_burst_alert:v1:${windowBucket}:store:${storeId}:cal:${calHash}:recipient:${recHash}`
      )
    );
    expect(keys.size).toBe(stores.length);
  });

  it("edge case: same everything but different recipients produce distinct keys", async () => {
    const windowBucket = 500000;
    const storeId = "osaka";
    const calHash = await burstSha256Hex16("calendar-b@example.invalid");
    const recipients = Array.from({ length: 20 }, (_, i) => `Urecip_${String(i).padStart(10, "0")}`);
    const keys = new Set<string>();
    for (const recipientId of recipients) {
      const recHash = await burstSha256Hex16(recipientId);
      keys.add(`google_conflict_burst_alert:v1:${windowBucket}:store:${storeId}:cal:${calHash}:recipient:${recHash}`);
    }
    expect(keys.size).toBe(recipients.length);
  });
});

describe("cross-pattern collision isolation", () => {
  it("drift_alert and conflict_burst_alert keys never collide even with identical dimensions", async () => {
    // Both patterns use the same sha256Hex16 for calendarId and recipientId,
    // but the prefix + bucket format differs. Verify no key from one
    // pattern appears in the other's set.
    const storeId = "kyoto";
    const calHash = await sha256Hex16("calendar-a@example.invalid");
    const recHash = await sha256Hex16("Urecipient001");

    const driftKeys = new Set<string>();
    const burstKeys = new Set<string>();

    // 30 days of drift alerts (1 per day)
    for (let day = 0; day < 30; day += 1) {
      const baseMs = Date.UTC(2026, 4, 1) + day * 24 * 60 * 60 * 1000;
      const utcDate = new Date(baseMs).toISOString().slice(0, 10);
      driftKeys.add(`google_drift_alert:v1:${utcDate}:store:${storeId}:cal:${calHash}:recipient:${recHash}`);
    }

    // 288 burst windows per day
    const baseMsForBuckets = Date.UTC(2026, 4, 1);
    const windowMs = CONFLICT_BURST_WINDOW_SECONDS * 1000;
    for (let w = 0; w < 288; w += 1) {
      const nowMs = baseMsForBuckets + w * windowMs;
      const bucket = Math.floor(nowMs / windowMs);
      burstKeys.add(`google_conflict_burst_alert:v1:${bucket}:store:${storeId}:cal:${calHash}:recipient:${recHash}`);
    }

    // No key from drift set appears in burst set
    for (const driftKey of driftKeys) {
      expect(burstKeys.has(driftKey)).toBe(false);
    }
    // No key from burst set appears in drift set
    for (const burstKey of burstKeys) {
      expect(driftKeys.has(burstKey)).toBe(false);
    }
  });

  it("calendar_sync_jobs keys and notification_jobs keys never collide due to distinct prefixes", () => {
    // calendar_sync_jobs uses patterns like "external_block:<id>:google:..."
    // notification_jobs uses patterns like "notification:<template>:store:<id>:..."
    // Even if the trailing segments happen to match, the prefix guarantees
    // namespace isolation.
    const syncKeys = new Set<string>();
    const notifKeys = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      syncKeys.add(
        compactDedupeKey(
          `external_block:eb-${i}:google:upsert:restore:evt-${i}`,
          "calendar-sync:external-block-restore"
        )
      );
      notifKeys.add(
        compactDedupeKey(
          `notification:reservation_confirmed:store:kyoto:reservation:res-${i}:v1`,
          "notif:reservation_confirmed"
        )
      );
    }
    for (const syncKey of syncKeys) {
      expect(notifKeys.has(syncKey)).toBe(false);
    }
  });
});
