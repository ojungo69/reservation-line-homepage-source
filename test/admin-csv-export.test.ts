import { describe, expect, it } from "vitest";

import {
  escapeCsvCell,
  reservationCsvLine,
  reservationsCsvFilename
} from "../src/admin/csv";
import { maskPhoneTail, type AdminReservationCsvRow } from "../src/admin/operations";

const sampleRow = (overrides: Partial<AdminReservationCsvRow> = {}): AdminReservationCsvRow => ({
  id: "rsv_1",
  status: "confirmed",
  source: "phone_admin",
  storeName: "京都本店",
  serviceName: "全身脱毛",
  startAt: "2026-06-01T01:00:00.000Z",
  endAt: "2026-06-01T02:00:00.000Z",
  customerId: "cus_1",
  customerDisplayName: "山田 太郎",
  customerDisplayNameKana: "ヤマダ タロウ",
  phoneTailMasked: "***-****-1234",
  lineFriendStatus: "friend",
  googleEventId: "google_event_1",
  cancellationFeeUnpaidAt: null,
  ...overrides
});

describe("escapeCsvCell", () => {
  it("returns plain values unchanged", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("日本語の名前")).toBe("日本語の名前");
  });

  it("doubles internal quotes and wraps in quotes when needed", () => {
    expect(escapeCsvCell('foo "bar"')).toBe('"foo ""bar"""');
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell("col\tval")).toBe('"col\tval"');
  });

  it("guards ASCII formula prefixes against Excel formula injection", () => {
    expect(escapeCsvCell("=cmd()")).toBe("'=cmd()");
    expect(escapeCsvCell("+cmd()")).toBe("'+cmd()");
    expect(escapeCsvCell("-cmd()")).toBe("'-cmd()");
    expect(escapeCsvCell("@cmd()")).toBe("'@cmd()");
    expect(escapeCsvCell("\t=cmd()")).toMatch(/^"'\t=cmd\(\)"$/);
    expect(escapeCsvCell("\r=cmd()")).toMatch(/^"'\r=cmd\(\)"$/);
    expect(escapeCsvCell("  =cmd()")).toBe("'  =cmd()");
  });

  it("intentionally does NOT prefix full-width formula glyphs (ASCII-only formula spec)", () => {
    // Excel formula tokens are ASCII; treating "＝" as risky would
    // gratuitously prefix Japanese strings like "＝記号です".
    expect(escapeCsvCell("＝記号です")).toBe("＝記号です");
    expect(escapeCsvCell("＋たす")).toBe("＋たす");
  });

  it("renders null/undefined as empty string", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });
});

describe("maskPhoneTail", () => {
  it("masks an 11-digit phone to last four", () => {
    expect(maskPhoneTail("08012345678")).toBe("***-****-5678");
  });

  it("returns **** for null", () => {
    expect(maskPhoneTail(null)).toBe("****");
  });

  it("returns **** for short or non-digit input", () => {
    expect(maskPhoneTail("abc")).toBe("****");
    expect(maskPhoneTail("12")).toBe("****");
  });
});

describe("reservationCsvLine", () => {
  it("emits 12 columns in the documented order", () => {
    const line = reservationCsvLine(sampleRow());
    expect(line.split(",")).toHaveLength(12);
  });

  it("escapes commas in customer name", () => {
    const line = reservationCsvLine(sampleRow({ customerDisplayName: "山田, 太郎" }));
    expect(line).toContain('"山田, 太郎"');
    expect(line.split(",").length).toBeGreaterThan(12); // commas inside quoted cell still split naively
  });
});

describe("reservationsCsvFilename", () => {
  it("uses from_to_unix.csv pattern", () => {
    expect(reservationsCsvFilename("2026-05-01", "2026-05-31", 1700000000)).toBe(
      "reservations_2026-05-01_2026-05-31_1700000000.csv"
    );
  });
});
