import { describe, expect, it, vi } from "vitest";
import { fetchLineFollowerIds, fetchLineProfile } from "../src/line/friends-api";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("friends-api: fetchLineFollowerIds", () => {
  it("returns userIds + next and sends bearer token & limit", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ok({ userIds: ["U" + "a".repeat(32)], next: "CURSOR" }));
    const res = await fetchLineFollowerIds({ token: "T", fetcher: fetcher as unknown as typeof fetch });
    expect(res.userIds).toEqual(["U" + "a".repeat(32)]);
    expect(res.next).toBe("CURSOR");
    const [calledUrl, init] = fetcher.mock.calls[0];
    expect(String(calledUrl)).toContain("https://api.line.me/v2/bot/followers/ids");
    expect(String(calledUrl)).toContain("limit=1000");
    expect((init as unknown as RequestInit).headers).toMatchObject({ Authorization: "Bearer T" });
  });

  it("maps empty next to null and drops non-string ids", async () => {
    const fetcher = vi.fn(async () => ok({ userIds: ["U" + "b".repeat(32), 123], next: "" }));
    const res = await fetchLineFollowerIds({ token: "T", fetcher: fetcher as unknown as typeof fetch });
    expect(res.userIds).toEqual(["U" + "b".repeat(32)]);
    expect(res.next).toBeNull();
  });

  it("throws on non-2xx", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 403 }));
    await expect(fetchLineFollowerIds({ token: "T", fetcher: fetcher as unknown as typeof fetch }))
      .rejects.toThrow(/line_followers_ids_failed:403/);
  });
});

describe("friends-api: fetchLineProfile", () => {
  it("returns displayName + pictureUrl on 200", async () => {
    const fetcher = vi.fn(async () => ok({ displayName: "田中花子", pictureUrl: "https://x/y.jpg" }));
    const res = await fetchLineProfile({ token: "T", lineUserId: "U" + "c".repeat(32), fetcher: fetcher as unknown as typeof fetch });
    expect(res).toEqual({ ok: true, displayName: "田中花子", pictureUrl: "https://x/y.jpg" });
  });

  it("marks ONLY 404 as unavailable (no throw)", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 404 }));
    const res = await fetchLineProfile({ token: "T", lineUserId: "U" + "d".repeat(32), fetcher: fetcher as unknown as typeof fetch });
    expect(res).toEqual({ ok: false, unavailable: true });
  });

  it("truncates display name by code points without splitting surrogate pairs (emoji)", async () => {
    const emoji = "😀".repeat(130); // 130 astral code points (each a UTF-16 surrogate pair)
    const fetcher = vi.fn(async () => ok({ displayName: emoji }));
    const res = await fetchLineProfile({ token: "T", lineUserId: "U" + "a".repeat(32), fetcher: fetcher as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.from(res.displayName)).toHaveLength(120); // 120 code points, not 120 UTF-16 units
    // 分割されていれば末尾の code point が lone surrogate になり "😀" で終わらない。
    expect(res.displayName.endsWith("😀")).toBe(true);
    expect(res.displayName).toBe("😀".repeat(120)); // 完全な絵文字120個（壊れなし）
  });

  it("throws on 401/403/429/5xx (transient — keep pending)", async () => {
    for (const status of [401, 403, 429, 500]) {
      const fetcher = vi.fn(async () => new Response("", { status }));
      await expect(fetchLineProfile({ token: "T", lineUserId: "U" + "e".repeat(32), fetcher: fetcher as unknown as typeof fetch }))
        .rejects.toThrow(new RegExp(`line_profile_failed:${status}`));
    }
  });
});
