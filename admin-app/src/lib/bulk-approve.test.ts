import { describe, expect, it } from "vitest";
import { runBulkApprove } from "./bulk-approve";

describe("runBulkApprove", () => {
  it("全件成功で succeeded に全 id が入り failed は空", async () => {
    const calls: string[] = [];
    const result = await runBulkApprove(
      ["a", "b", "c"],
      async (id) => {
        calls.push(id);
      },
      () => "err",
    );
    expect(result.succeeded).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("途中失敗しても継続し、失敗はメッセージ付きで集計される", async () => {
    const result = await runBulkApprove(
      ["a", "b", "c"],
      async (id) => {
        if (id === "b") throw new Error("boom");
      },
      (error) => (error instanceof Error ? error.message : "unknown"),
    );
    expect(result.succeeded).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ id: "b", message: "boom" }]);
  });

  it("実行は直列 (同時実行は常に1件)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runBulkApprove(
      ["a", "b", "c", "d"],
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
      () => "err",
    );
    expect(maxInFlight).toBe(1);
  });

  it("onProgress が件ごとに (done, total) で呼ばれる (失敗も進捗に数える)", async () => {
    const progress: Array<[number, number]> = [];
    await runBulkApprove(
      ["a", "b"],
      async (id) => {
        if (id === "a") throw new Error("boom");
      },
      () => "err",
      (done, total) => progress.push([done, total]),
    );
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("空配列は何もせず空の結果を返す", async () => {
    const result = await runBulkApprove([], async () => {}, () => "err");
    expect(result).toEqual({ succeeded: [], failed: [] });
  });
});
