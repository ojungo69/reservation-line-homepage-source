import type { AdminReservationCsvRow } from "./operations";
import { labelForLineFriend, labelForStatus } from "./format";

// UTF-8 BOM as a string. Excel needs this prefix to detect the CSV is UTF-8;
// without it Japanese cells render as mojibake when opened directly.
export const CSV_BOM = "﻿";

// Risky cell starts (OWASP CSV Injection guide):
//   - Excel formula characters: =, +, -, @ at the start of the cell
//   - The same tokens preceded by ASCII whitespace ( \s = space/\t/\r/\n/\v/\f)
//     so " =cmd()", "\t=cmd()", "\r=cmd()" are also caught
// Full-width JIS variants (＝＋－＠) are NOT considered risky: Excel only
// interprets ASCII formula tokens. Treating them as risky would prefix safe
// Japanese strings (like "＝記号です") and is intentionally excluded.
const FORMULA_PREFIX_RE = /^\s*[=+\-@]/;
const NEEDS_QUOTING_RE = /[",\r\n\t]/;

// Coerce primitives only; objects/symbols become "" instead of "[object Object]"
// or a TypeError. csv.ts callers always pass string|number|null, so this is just
// defense for future callers.
const stringifyCell = (raw: unknown): string => {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
    return String(raw);
  }
  return "";
};

export const escapeCsvCell = (raw: unknown): string => {
  const str = stringifyCell(raw);
  const guarded = FORMULA_PREFIX_RE.test(str) ? `'${str}` : str;
  if (NEEDS_QUOTING_RE.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
};

export const RESERVATIONS_CSV_HEADERS: ReadonlyArray<string> = [
  "予約ID",
  "開始",
  "終了",
  "店舗",
  "メニュー",
  "顧客名",
  "カナ",
  "電話末尾",
  "状態",
  "LINE",
  "予約経路",
  "Googleイベント連携ID"
];

export const reservationCsvLine = (row: AdminReservationCsvRow): string =>
  [
    row.id,
    row.startAt,
    row.endAt,
    row.storeName,
    row.serviceName,
    row.customerDisplayName,
    row.customerDisplayNameKana ?? "",
    row.phoneTailMasked,
    labelForStatus(row.status),
    labelForLineFriend(row.lineFriendStatus),
    row.source,
    row.googleEventId ?? ""
  ]
    .map(escapeCsvCell)
    .join(",");

export const reservationsCsvFilename = (
  from: string,
  to: string,
  unixSeconds: number
): string => `reservations_${from}_${to}_${unixSeconds}.csv`;

export const ROWS_PER_CHUNK = 500;

// Paged variant: pulls rows from D1 in `pageSize` chunks via the caller's
// fetchPage callback. Each page is encoded and pushed to the
// ReadableStream consumer before the next page is fetched, keeping memory
// bounded at ~`pageSize` rows. Resolves the `result_too_large` 413 that
// the previous single-shot export hit at 25K rows
// (docs/issues/csv-export-result-too-large.md — Option A).
//
// pageSize = 10000 keeps each D1 query well under the per-query response
// size cap (~7 MB at ~280 bytes per CSV row), and `maxPages` caps the
// total at 3 pages = 30K rows in the worst case, matching the historical
// ~25K single-shot export limit with a small safety buffer.
export const PAGED_ROWS_PER_PAGE = 10_000;
export const PAGED_MAX_PAGES = 3;

export type ReservationsCsvFetchPage = (
  offset: number,
  limit: number
) => Promise<{ rows: AdminReservationCsvRow[]; ok: true } | { ok: false; reason: string }>;

export const reservationsCsvStreamPaged = (input: {
  fetchPage: ReservationsCsvFetchPage;
  pageSize?: number;
  maxPages?: number;
}): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const pageSize = input.pageSize ?? PAGED_ROWS_PER_PAGE;
  const maxPages = input.maxPages ?? PAGED_MAX_PAGES;
  let nextOffset = 0;
  let pagesFetched = 0;
  let exhausted = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(CSV_BOM + RESERVATIONS_CSV_HEADERS.map(escapeCsvCell).join(",") + "\n")
      );
    },
    async pull(controller) {
      if (exhausted) {
        controller.close();
        return;
      }
      if (pagesFetched >= maxPages) {
        // Cap reached. End the stream rather than fetching one more page
        // and silently dropping rows.
        exhausted = true;
        controller.close();
        return;
      }
      const result = await input.fetchPage(nextOffset, pageSize);
      pagesFetched += 1;
      if (!result.ok) {
        // Pass the upstream error along by erroring the stream — the HTTP
        // status code 200 is already in flight (headers committed), so we
        // cannot signal a 4xx/5xx here. The downloaded CSV will be cut
        // mid-row and the client connection terminates. The reason string
        // is included on the Error so Cloudflare's invocation log shows
        // it; callers that need a structured event should wire one at
        // the handler layer where the filter context is in scope.
        exhausted = true;
        controller.error(new Error(`reservations_csv_fetch_failed:${result.reason}`));
        return;
      }
      const rows = result.rows;
      if (rows.length === 0) {
        exhausted = true;
        controller.close();
        return;
      }
      // Sub-chunk the page into ROWS_PER_CHUNK-sized batches so a single
      // enqueue() call doesn't materialise the full 10K-row encoded string
      // + Uint8Array in transient memory. Each sub-batch is a separate
      // chunk on the ReadableStream, preserving backpressure semantics.
      for (let cursor = 0; cursor < rows.length; cursor += ROWS_PER_CHUNK) {
        const subBatch = rows.slice(cursor, cursor + ROWS_PER_CHUNK);
        controller.enqueue(encoder.encode(subBatch.map(reservationCsvLine).join("\n") + "\n"));
      }
      nextOffset += rows.length;
      // If the page came back short, no more rows upstream. End now to
      // avoid one redundant empty-page query.
      if (rows.length < pageSize) {
        exhausted = true;
        controller.close();
      }
    }
  });
};
