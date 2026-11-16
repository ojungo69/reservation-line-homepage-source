import { readFileSync } from "node:fs";
import { join } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderCustomerReservationsPage } from "../src/customer/reservations-page";

const APPLICATION_NOTICE =
  "お申し込みから24時間以内（それより前にご予約の時間が終わる場合は、その時点まで）に店舗で確認できない場合、お申し込みは自動的に取り消されます。承認されなかったお申し込みや期限切れのお申し込みは、「予約の確認」の一覧には表示されません。ご不明な点は、公式LINEのトークからお問い合わせください。";

let dom: JSDOM;

const setup = async (reservations: unknown[], fetch = vi.fn(async () => ({
  status: 200,
  json: async () => ({ ok: true, reservations })
}))) => {
  dom = new JSDOM(renderCustomerReservationsPage({ liffId: "test-liff" }), {
    runScripts: "outside-only",
    url: "https://example.com/customer/reservations"
  });
  // Exercise the page's real bootstrap; only LINE and the HTTP boundary are fake.
  Object.assign(dom.window, {
    Headers,
    fetch,
    liff: {
      init: async () => undefined,
      isLoggedIn: () => true,
      getIDToken: () => "fictional-id-token",
      getAccessToken: () => "fictional-access-token",
      getDecodedIDToken: () => ({ nonce: "fictional-nonce" })
    }
  });
  dom.window.eval(readFileSync(join(process.cwd(), "public/customer/reservations.js"), "utf8"));
  await vi.waitFor(() => {
    expect(dom.window.document.querySelector("#reservations")?.hasAttribute("aria-busy")).toBe(false);
  });
  return dom.window.document;
};

describe("customer reservations page (JSDOM)", () => {
  afterEach(() => dom?.window.close());

  it("explains automatic expiry and omitted applications when the reservation list is empty", async () => {
    const document = await setup([]);
    const list = document.getElementById("reservations");

    expect(list?.textContent).toContain("現在ご利用可能な予約はありません。");
    expect(list?.textContent).toContain(APPLICATION_NOTICE);
    expect(list?.querySelector("article")).toBeNull();
    expect(document.getElementById("status-banner")?.textContent).toBe("");
  });

  it("shows only the start time while preserving menu snapshots and reservation badges", async () => {
    const document = await setup([
      {
        id: "reservation-confirmed",
        storeName: "サンプル店",
        serviceName: "カット｜サンプルカット 60分",
        startAt: "2026-06-01T01:00:00.000Z",
        // The stored end includes cleanup time, which customers cannot use as a finish time.
        endAt: "2026-06-01T02:15:00.000Z",
        status: "confirmed"
      },
      {
        id: "reservation-pending",
        storeName: "サンプル店",
        serviceName: "カット｜サンプルカット 60分 / メンズ｜サンプルケア 30分",
        startAt: "2026-06-02T02:30:00.000Z",
        endAt: "2026-06-02T04:15:00.000Z",
        status: "pending_approval"
      }
    ]);
    const cards = document.querySelectorAll("#reservations article");

    expect(Array.from(cards, (card) => card.querySelector("p.meta")?.textContent)).toEqual([
      "開始: 2026/06/01 10:00",
      "開始: 2026/06/02 11:30"
    ]);
    expect(Array.from(cards, (card) => card.querySelector("h2")?.textContent)).toEqual([
      "サンプル店 / サンプルカット 60分",
      "サンプル店 / サンプルカット 60分 / メンズ｜サンプルケア 30分"
    ]);
    expect(Array.from(cards, (card) => card.querySelector(".badge")?.textContent)).toEqual([
      "確定",
      "承認待ち"
    ]);
    expect(cards.item(1).querySelector(".badge")?.classList.contains("pending")).toBe(true);
    expect(document.getElementById("reservations")?.textContent).toContain(
      "ご予約の変更・キャンセルをご希望の場合は、お手数ですが当店公式LINEのトークからご連絡くださいませ。"
    );
  });

  it.each(["HTTP 500", "network failure"])("ends loading and can retry after %s", async (failure) => {
    let finishRetry!: (response: { status: number; json: () => Promise<unknown> }) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(async () => {
        if (failure === "network failure") throw new dom.window.Error("offline");
        return { status: 500, json: async () => ({ ok: false, reason: "internal_error" }) };
      })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    const document = await setup([], fetch);
    const list = document.getElementById("reservations");
    const retry = document.querySelector<HTMLButtonElement>("button");

    expect(document.getElementById("status-banner")?.textContent).toBe("通信に失敗しました");
    expect(list?.textContent).not.toContain("読み込み中");
    expect(retry?.textContent).toBe("再試行");
    expect(retry?.hidden).toBe(false);

    retry!.click();
    retry!.click();
    expect(retry?.disabled).toBe(true);
    expect(list?.getAttribute("aria-busy")).toBe("true");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    finishRetry({ status: 200, json: async () => ({ ok: true, reservations: [{
      id: "reservation-recovered", storeName: "架空店", serviceName: "サンプル施術",
      startAt: "2026-11-17T01:00:00Z", endAt: "2026-11-17T02:00:00Z", status: "confirmed"
    }] }) });
    await vi.waitFor(() => expect(list?.querySelector("article h2")?.textContent).toBe("架空店 / サンプル施術"));
    expect(list?.hasAttribute("aria-busy")).toBe(false);
    expect(retry?.hidden).toBe(true);
    expect(document.getElementById("status-banner")?.textContent).toBe("");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

});
