import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiOutcomeUnknownError } from "./api-client";
import {
  actionErrorMessage,
  errorMessage,
  showErrorToast,
} from "./error-messages";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

describe("error message lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps known codes and preserves unknown direct lookups", () => {
    expect(errorMessage("slot_unavailable")).toBe(
      "選択した時間帯は既に埋まっています",
    );
    expect(errorMessage("future_error")).toBe("future_error");
  });

  it("prefers an ApiError reason and maps it", () => {
    expect(
      actionErrorMessage(
        new ApiError(409, { reason: "customer_time_conflict" }),
      ),
    ).toBe("同じ時間帯に既に予約があります");
  });

  it("uses the ApiError error field when reason is absent", () => {
    expect(
      actionErrorMessage(
        new ApiError(400, { error: "invalid_request" }),
      ),
    ).toBe("入力内容に誤りがあります");
  });

  it.each([
    new ApiError(500, { reason: "future_error" }),
    new ApiError(500, null),
  ])("uses a safe action fallback for unmapped API errors", (error) => {
    expect(actionErrorMessage(error)).toBe("操作に失敗しました");
  });

  it("does not expose non-API network error text", () => {
    expect(actionErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "通信に失敗しました",
    );
  });

  it("preserves the uncertainty of a lost write response in both error displays", () => {
    const error = new ApiOutcomeUnknownError(new TypeError("Failed to fetch"));
    const message = "処理結果を確認できません。重複操作を避けるため、最新の状態を確認してから操作してください";
    expect(actionErrorMessage(error)).toBe(message);
    showErrorToast(error, "保存できませんでした");
    expect(toast.error).toHaveBeenCalledWith(message);
  });

  it("toasts a mapped ApiError reason", () => {
    showErrorToast(
      new ApiError(403, { reason: "forbidden" }),
      "fallback",
    );
    expect(toast.error).toHaveBeenCalledWith("権限がありません");
  });

  it("toasts a mapped ApiError error field", () => {
    showErrorToast(
      new ApiError(404, { error: "not_found" }),
      "fallback",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "対象が見つかりません",
    );
  });

  it("toasts the supplied fallback for unknown or bodyless ApiErrors", () => {
    showErrorToast(
      new ApiError(500, { reason: "future_error" }),
      "保存できませんでした",
    );
    showErrorToast(new ApiError(500, null), "もう一度お試しください");
    expect(toast.error.mock.calls).toEqual([
      ["保存できませんでした"],
      ["もう一度お試しください"],
    ]);
  });

  it("uses the default fallback for a non-API error", () => {
    showErrorToast(new Error("network"));
    expect(toast.error).toHaveBeenCalledWith("操作に失敗しました");
  });
});
