import { vi } from "vitest";

/**
 * フックテスト共通の api / toast モック。
 *
 * このモジュールは import した時点で vi.mock を登録する副作用がある。SUT より
 * 先に評価させる必要があるため、各テストの `vi.hoisted` からファクトリを呼ぶ形
 * には出来ない (import の TDZ で落ちる)。副作用の無い QueryClient ユーティリティ
 * は test-utils/query-client に分けてあるので、モックが要らないテストはそちらだけ
 * を import すること。
 */
export const mocks = {
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
  showErrorToast: vi.fn(),
};

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, api: mocks.api };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@/lib/error-messages", () => ({
  showErrorToast: mocks.showErrorToast,
}));
