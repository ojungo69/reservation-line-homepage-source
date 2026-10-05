// Shared lookup for the per-store Google Calendar mapping. Both the channel-watch
// and import-sync flows need the same `stores` query, so it lives here to keep the
// SQL (and the row shape it depends on) in a single place.

export type StoreCalendarRow = {
  store_id: string;
  calendar_id: string;
};

export const fetchStoreCalendars = async (db: D1Database): Promise<StoreCalendarRow[]> => {
  const rows = await db
    .prepare(
      `
        SELECT id AS store_id, google_calendar_id AS calendar_id
        FROM stores
        WHERE google_calendar_id IS NOT NULL
        ORDER BY id ASC
      `
    )
    .all<StoreCalendarRow>();
  return rows.results ?? [];
};
