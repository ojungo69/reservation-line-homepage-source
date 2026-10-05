import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AUTO_COMPLETE_GRACE_MS,
  AUTO_COMPLETE_SWEEP_JST_MINUTES
} from "../src/reservations/auto-complete";

// 自動完了の猶予・実行時刻は auto-complete.ts が正本で、日次サマリーの
// 「猶予期限切れで未処理」判定がそれを読む。cron 文字列だけは wrangler.jsonc に
// あって import できないので、ここで定数と突き合わせる。ずれると、処理が
// 正常でも未処理として報告されたり、停止を検知できなくなる。
describe("auto-complete schedule", () => {
  it("keeps the JST sweep constant in step with the wrangler cron", () => {
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const crons = /"crons"\s*:\s*\[([^\]]*)\]/.exec(wrangler);
    expect(crons).not.toBeNull();

    // 定数から UTC の cron 文字列を組み立て、それが実際に登録されていることを見る
    // (どの cron が daily-cleanup かを文字列から推測しない)。
    const utcMinutes = (AUTO_COMPLETE_SWEEP_JST_MINUTES - 9 * 60 + 24 * 60) % (24 * 60);
    const expectedCron = `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} * * *`;
    const registered = crons![1]
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""));

    expect(expectedCron).toBe("5 16 * * *");
    expect(registered).toContain(expectedCron);
  });

  it("keeps the documented grace window at two days", () => {
    expect(AUTO_COMPLETE_GRACE_MS).toBe(2 * 24 * 60 * 60 * 1000);
  });
});
