import { describe, expect, it } from "vitest";
import type { Store, SyncStatusSystemAdmin } from "@/types/api";
import { buildGoogleSyncViewModel } from "./google-sync-view-model";

const settingsStores = [
  {
    id: "settings-store",
    name: "設定店舗",
    googleCalendarId: "calendar-shared",
  },
  {
    id: "selected-store",
    name: "選択店舗",
    googleCalendarId: "calendar-selected",
  },
  {
    id: "no-calendar-store",
    name: "カレンダー未設定",
    googleCalendarId: null,
  },
] as Store[];

const syncStatus = {
  channels: [
    { id: "channel-selected", storeId: "selected-store", calendarId: "calendar-shared" },
    { id: "channel-extra", storeId: "channel-extra-store", calendarId: "calendar-extra" },
    { id: "channel-other", storeId: "other-store", calendarId: "calendar-other" },
  ],
  dlq: {
    jobs: [
      { id: "dlq-selected", storeId: "selected-store" },
      { id: "dlq-extra", storeId: "dlq-extra-store" },
      { id: "dlq-unowned" },
      { id: "dlq-other", storeId: "other-store" },
    ],
  },
  googleEvents: [
    { id: "event-selected", storeId: "selected-store" },
    { id: "event-channel-extra", storeId: "channel-extra-store" },
    { id: "event-extra", storeId: "event-extra-store" },
    { id: "event-other", storeId: "other-store" },
  ],
  outboundWrites: [
    { id: "write-settings", calendarId: "calendar-selected" },
    { id: "write-refined", calendarId: "calendar-shared" },
    { id: "write-other", calendarId: "calendar-other" },
    { id: "write-unmapped", calendarId: "calendar-unmapped" },
  ],
  conflicts: [
    { id: "conflict-selected", storeId: "selected-store" },
    { id: "conflict-other", storeId: "other-store" },
  ],
} as SyncStatusSystemAdmin;

describe("buildGoogleSyncViewModel", () => {
  it("keeps every original row array for the all-store view", () => {
    const result = buildGoogleSyncViewModel(syncStatus, settingsStores, null);

    expect(result.channels).toBe(syncStatus.channels);
    expect(result.dlqJobs).toBe(syncStatus.dlq.jobs);
    expect(result.googleEvents).toBe(syncStatus.googleEvents);
    expect(result.outboundWrites).toBe(syncStatus.outboundWrites);
    expect(result.conflicts).toBe(syncStatus.conflicts);
  });

  it("adds each unknown store once after settings stores", () => {
    const result = buildGoogleSyncViewModel(syncStatus, settingsStores, null);

    expect(result.storeOptions.map(({ id }) => id)).toEqual([
      "settings-store",
      "selected-store",
      "no-calendar-store",
      "channel-extra-store",
      "other-store",
      "event-extra-store",
      "dlq-extra-store",
    ]);
    expect(result.storeOptions.at(-1)).toEqual({
      id: "dlq-extra-store",
      label: "dlq-extr…",
    });
  });

  it("filters owned rows while retaining unowned operational rows", () => {
    const result = buildGoogleSyncViewModel(syncStatus, settingsStores, "selected-store");

    expect(result.channels.map(({ id }) => id)).toEqual(["channel-selected"]);
    expect(result.dlqJobs.map(({ id }) => id)).toEqual(["dlq-selected", "dlq-unowned"]);
    expect(result.googleEvents.map(({ id }) => id)).toEqual(["event-selected"]);
    expect(result.outboundWrites.map(({ id }) => id)).toEqual([
      "write-settings",
      "write-refined",
      "write-unmapped",
    ]);
    expect(result.conflicts.map(({ id }) => id)).toEqual(["conflict-selected"]);
  });
});
