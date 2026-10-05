import { beforeEach, describe, expect, it, vi } from "vitest";

const showErrorToast = vi.hoisted(() => vi.fn());
vi.mock("./error-messages", () => ({ showErrorToast }));

import { queryClient } from "./query-client";

describe("queryClient", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("uses the admin app's shared query defaults", () => {
    expect(queryClient.getDefaultOptions().queries).toMatchObject({
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    });
  });

  it("globally reports a mutation error when the mutation has no handler", async () => {
    const error = new Error("save failed");
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        throw error;
      },
    });

    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(showErrorToast).toHaveBeenCalledWith(error);
  });

  it("does not double-toast when a mutation supplies its own error handler", async () => {
    const error = new Error("save failed");
    const onError = vi.fn();
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        throw error;
      },
      onError,
    });

    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(
      error,
      undefined,
      undefined,
      expect.any(Object),
    );
    expect(showErrorToast).not.toHaveBeenCalled();
  });
});
