import { describe, expect, it } from "vitest";

import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const columnNames = (d1: ReturnType<typeof createMigratedSqliteD1>, table: string) =>
  (d1.sqlite.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>)
    .map((row) => row.name);

describe("0055 drop customer email columns", () => {
  it("drops customers.email and notification_jobs email_fallback_* while keeping email_inflight_at", () => {
    const d1 = createMigratedSqliteD1();
    try {
      expect(columnNames(d1, "customers")).not.toContain("email");
      const jobs = columnNames(d1, "notification_jobs");
      expect(jobs.filter((name) => name.startsWith("email_fallback"))).toEqual([]);
      expect(jobs).toContain("email_inflight_at");
    } finally {
      d1.sqlite.close();
    }
  });
});
