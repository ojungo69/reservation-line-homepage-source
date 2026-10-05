import { describe, expect, it } from "vitest";
import { buildLineMessages } from "../src/line/notifications";

// Minimal builder for a LINE notification job row. Only the fields the Flex
// confirmation card reads are meaningful; the rest are filled with inert
// defaults so the structural type is satisfied.
const makeRow = (overrides: Record<string, unknown> = {}) => ({
  job_id: "job-1",
  template_key: "reservation_confirmed",
  recipient_type: "customer" as const,
  recipient_id: "cust-1",
  reservation_id: "resv-1",
  attempts: 0,
  line_user_id: "U-line-1",
  store_name: "大阪 ExampleStore B",
  store_timezone: "Asia/Tokyo",
  start_at: "2026-06-10T05:00:00.000Z", // 14:00 JST
  status: "confirmed",
  customer_display_name: "山田",
  payload_json: null,
  ...overrides
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const ENV = { LINE_LIFF_ID: "1234-abcd" };
const TEXT = "予約が確定しました。\n日時: 2026年6月10日(火) 14:00\n店舗: 大阪 ExampleStore B";

describe("buildLineMessages — reservation confirmation Flex card", () => {
  it("renders a Flex bubble for a customer reservation_confirmed push", () => {
    const messages = buildLineMessages(makeRow(), ENV, TEXT);
    expect(messages).toHaveLength(1);
    const msg = messages[0] as { type: string; altText: string; contents: Record<string, any> };
    expect(msg.type).toBe("flex");
    // altText reuses the plain text so nothing is lost on unsupported clients.
    expect(msg.altText).toBe(TEXT);
    expect(msg.contents.type).toBe("bubble");
    expect(msg.contents.header.contents[1].text).toBe("ご予約が確定しました");
  });

  it("includes 日時 / 店舗 / お名前 rows from the row data", () => {
    const messages = buildLineMessages(makeRow(), ENV, TEXT);
    const body = (messages[0] as any).contents.body.contents as Array<any>;
    const labels = body.map((r) => r.contents[0].text);
    const values = body.map((r) => r.contents[1].text);
    expect(labels).toEqual(["日時", "店舗", "お名前"]);
    expect(values[1]).toBe("大阪 ExampleStore B");
    expect(values[2]).toBe("山田 様");
    // The 日時 value is the formatted JST start, not the raw ISO string.
    expect(values[0]).not.toContain("2026-06-10T05:00");
    expect(values[0]).toContain("14:00");
  });

  it("adds the self-service button deep-linking to the LIFF when configured", () => {
    const messages = buildLineMessages(makeRow(), ENV, TEXT);
    const footer = (messages[0] as any).contents.footer;
    expect(footer.contents[0].action).toEqual({
      type: "uri",
      label: "予約を確認する",
      uri: "https://liff.line.me/1234-abcd/customer/reservations"
    });
  });

  it("omits the footer button when LINE_LIFF_ID is not configured", () => {
    const messages = buildLineMessages(makeRow(), {}, TEXT);
    expect((messages[0] as any).type).toBe("flex");
    expect((messages[0] as any).contents.footer).toBeUndefined();
  });

  it("omits the お名前 row when the customer name is unknown", () => {
    const messages = buildLineMessages(makeRow({ customer_display_name: null }), ENV, TEXT);
    const body = (messages[0] as any).contents.body.contents as Array<any>;
    expect(body.map((r) => r.contents[0].text)).toEqual(["日時", "店舗"]);
  });

  it("truncates an over-long altText to the conservative 400-char cap", () => {
    const longText = "あ".repeat(500);
    const messages = buildLineMessages(makeRow(), ENV, longText);
    const altText = (messages[0] as any).altText as string;
    expect(altText).toHaveLength(400);
    expect(altText.endsWith("…")).toBe(true);
  });

  it("truncates emoji-bearing values on code-point boundaries (no split surrogate)", () => {
    // 45 supplementary-plane emoji (each 2 UTF-16 units) exceeds the 40 name cap.
    const messages = buildLineMessages(makeRow({ customer_display_name: "🎀".repeat(45) }), ENV, TEXT);
    const body = (messages[0] as any).contents.body.contents as Array<any>;
    const nameValue = body[2].contents[1].text as string;
    // No lone surrogate halves: every code point re-splits to a full 2-unit char.
    for (const ch of Array.from(nameValue)) {
      const code = ch.codePointAt(0)!;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
    expect(nameValue.endsWith("… 様")).toBe(true);
  });

  it("falls back to a plain text message when core data is missing", () => {
    const messages = buildLineMessages(makeRow({ start_at: null }), ENV, TEXT);
    expect(messages).toEqual([{ type: "text", text: TEXT }]);
  });

  it("keeps non-confirmation templates as plain text", () => {
    const messages = buildLineMessages(makeRow({ template_key: "reservation_reminder" }), ENV, TEXT);
    expect(messages).toEqual([{ type: "text", text: TEXT }]);
  });

  it("keeps owner-recipient confirmations as plain text", () => {
    const messages = buildLineMessages(makeRow({ recipient_type: "owner" }), ENV, TEXT);
    expect(messages).toEqual([{ type: "text", text: TEXT }]);
  });
});
