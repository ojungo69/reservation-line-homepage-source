import { describe, expect, it, vi } from "vitest";

import { mapConcurrent } from "../src/concurrency";

describe("independent work", () => {
  it("caps in-flight work at four and returns results in input order", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const work = mapConcurrent([0, 1, 2, 3, 4, 5, 6], async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { releases[item] = resolve; });
      active -= 1;
      return item * 10;
    });
    expect(active).toBe(4);
    // Complete later items first while the first three remain pending.
    for (const item of [3, 4, 5]) {
      releases[item]();
      await vi.waitFor(() => expect(releases[item + 1]).toBeTypeOf("function"));
    }
    releases[6]();
    releases[2]();
    releases[1]();
    releases[0]();
    expect(await work).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(4);
  });

  it("stops new work after failure and drains started work before rejecting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failure = new Error("first failure");
    const started: number[] = [];
    let settled = false;
    const work = mapConcurrent([0, 1, 2, 3, 4, 5], async (item) => {
      started.push(item);
      if (item === 0) throw failure;
      await gate;
      return item;
    });
    const result = work.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1, 2, 3]);
    release();
    expect(await result).toBe(failure);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("retains an undefined rejection and catches synchronous mapper throws", async () => {
    await expect(mapConcurrent([1], () => { throw undefined; })).rejects.toBeUndefined();
    expect(await mapConcurrent([], async () => 1)).toEqual([]);
  });
});
