import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GoogleSyncPage from "./google-sync";
import type { SyncDlqJob, SyncStatusResponse } from "@/types/api";

const mocks = vi.hoisted(() => ({
  syncStatus: null as SyncStatusResponse | null,
  retry: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: () => ({ data: null }) }));
vi.mock("@/hooks/use-sync-status", () => ({
  useSyncStatus: () => ({ syncStatus: mocks.syncStatus, isPending: false, isError: false }),
  useSyncJobRetry: () => ({ mutate: mocks.retry, isPending: false }),
  useSyncJobAcknowledge: () => ({ mutate: mocks.acknowledge, isPending: false }),
  useGoogleEditMode: () => ({ mutate: vi.fn(), isPending: false }),
  useConflictAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

const renderJob = async (overrides: Partial<SyncDlqJob> = {}) => {
  mocks.syncStatus = {
    ok: true, role: "system_admin",
    summary: { openGoogleConflicts: 0, googleSyncJobsNeedingAttention: 0, lineNotificationJobsNeedingAttention: 1, channelsNeedingAttention: 0 },
    channels: [], conflicts: [], googleEvents: [], outboundWrites: [],
    dlq: { source: "d1_attention_jobs", jobs: [{
      id: "notification-1", source: "notification_jobs", status: "dead", attemptCount: 1,
      lastError: "line-monthly-quota-exhausted", updatedAt: "2026-09-01T01:00:00.000Z",
      templateKey: "reservation_confirmed", reservationId: "reservation-1", ...overrides,
    }] },
  };
  render(<GoogleSyncPage />);
  await userEvent.click(screen.getByRole("button", { name: "技術詳細を表示" }));
};

describe("notification acknowledgement in GoogleSyncPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets owners review their business conflicts without technical recovery actions", () => {
    mocks.syncStatus = {
      ok: true, role: "owner",
      summary: { openGoogleConflicts: 1, googleSyncJobsNeedingAttention: 0, lineNotificationJobsNeedingAttention: 0, channelsNeedingAttention: 0 },
      recoveryTasks: [], conflictAggregate: { totalConflicts: 1, totalRequiringAction: 1, perStore: [] },
      actionableConflicts: [{ id: "owned-day", storeId: "store-1", storeName: "確認店舗", customerDisplayName: null, conflictType: "google_all_day_event", summary: "休業候補", createdAt: "2026-09-29T00:00:00Z", startAt: "2026-10-01T15:00:00Z", endAt: "2026-10-02T15:00:00Z", overlappingReservations: [] }]
    };
    render(<GoogleSyncPage />);
    expect(screen.getByText("休業候補")).toBeTruthy();
    expect(screen.getByRole("button", { name: "休業日承認" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "無視" })).toBeNull();
    expect(screen.queryByRole("button", { name: "手動解決" })).toBeNull();
  });

  it("withholds owner decisions when the target time cannot be identified", () => {
    mocks.syncStatus = {
      ok: true, role: "owner",
      summary: { openGoogleConflicts: 1, googleSyncJobsNeedingAttention: 0, lineNotificationJobsNeedingAttention: 0, channelsNeedingAttention: 0 },
      recoveryTasks: [], conflictAggregate: { totalConflicts: 1, totalRequiringAction: 1, perStore: [] },
      actionableConflicts: [{ id: "missing-target", storeId: "store-1", storeName: "確認店舗", customerDisplayName: null, conflictType: "reservation_event_deleted", summary: null, createdAt: "2026-09-29T00:00:00Z", startAt: null, endAt: null, overlappingReservations: [] }]
    };
    render(<GoogleSyncPage />);
    expect(screen.getByText("対象日時を確認できません。管理者に確認してください。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "キャンセル承認" })).toBeNull();
  });

  it("requires a reason and acknowledges quota failure without offering a retry", async () => {
    await renderJob();
    expect(screen.queryByRole("button", { name: "リトライ" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "確認済み" }));
    const dialog = within(screen.getByRole("dialog"));
    const confirm = dialog.getByRole("button", { name: "確認済み" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.getByText(/失敗履歴は保持/)).toBeTruthy();
    await userEvent.type(dialog.getByRole("textbox", { name: "確認メモ" }), "月間枠超過のため再送しません。");
    await userEvent.click(confirm);
    expect(mocks.acknowledge).toHaveBeenCalledWith({
      jobId: "notification-1", source: "notification_jobs", idempotencyKey: expect.any(String), note: "月間枠超過のため再送しません。",
    }, expect.any(Object));
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("does not assume an unclassified historical 429 was a monthly quota failure", async () => {
    await renderJob({ lastError: "line-http-429" });
    expect(screen.getByRole("button", { name: "リトライ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "確認済み" })).toBeTruthy();
  });

  it("keeps retries for transient failures while preventing acknowledgement during retry", async () => {
    await renderJob({ status: "retryable", lastError: "line-http-429" });
    expect(screen.queryByRole("button", { name: "確認済み" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "リトライ" }));
    expect(mocks.retry).toHaveBeenCalled();
  });

  it("allows a terminal non-quota failure to be retried or acknowledged", async () => {
    await renderJob({ status: "failed", lastError: "line-http-503" });
    expect(screen.getByRole("button", { name: "確認済み" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "リトライ" })).toBeTruthy();
  });
});
