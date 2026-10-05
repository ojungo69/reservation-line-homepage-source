const EVENT_HISTORY_COLUMNS = `id, store_id, calendar_id, google_event_id, google_etag, google_updated_at, source_type, status, reason, snapshot_json, captured_at`;

export const buildEventHistoryInsert = (
  db: D1Database,
  params: {
    storeId: string;
    calendarId: string;
    googleEventId: string;
    googleEtag: string | null;
    googleUpdatedAt: string | null;
    sourceType: "reservation" | "external_block" | "unknown";
    status: string;
    snapshotJson: string;
    nowIso: string;
  },
  guard: { sql: string; bindings: unknown[] }
): D1PreparedStatement => {
  const valuePlaceholders = "?, ?, ?, ?, ?, ?, ?, ?, 'upsert', ?, ?";
  const sql = `INSERT INTO google_calendar_event_history (${EVENT_HISTORY_COLUMNS}) SELECT ${valuePlaceholders} WHERE EXISTS (${guard.sql})`;

  const bindings: unknown[] = [
    crypto.randomUUID(),
    params.storeId,
    params.calendarId,
    params.googleEventId,
    params.googleEtag,
    params.googleUpdatedAt,
    params.sourceType,
    params.status,
    params.snapshotJson,
    params.nowIso,
  ];

  bindings.push(...guard.bindings);

  return db.prepare(sql).bind(...bindings);
};
