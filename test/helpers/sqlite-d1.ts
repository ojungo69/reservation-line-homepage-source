import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

type BoundValue = string | number | null;

class SqliteD1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: BoundValue[] = []
  ) {}

  bind(...values: BoundValue[]) {
    return new SqliteD1PreparedStatement(this.db, this.sql, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    const statement = this.db.prepare(this.sql);
    const row = statement.get(...this.values);
    return (row ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const statement = this.db.prepare(this.sql);
    const rows = statement.all(...this.values);
    return {
      success: true,
      results: rows as T[],
      meta: {}
    } as D1Result<T>;
  }

  async run(): Promise<D1Result> {
    const result = this.runSync();
    return {
      success: true,
      meta: {
        changes: result.changes
      }
    } as D1Result;
  }

  runSync() {
    const statement: StatementSync = this.db.prepare(this.sql);
    const result = statement.run(...this.values);
    return {
      changes: Number(result.changes)
    };
  }

  // Faithful to real D1 batch(): SELECTs return populated `results`, writes
  // return `meta.changes`. (run() can't yield rows; all() can't yield changes.)
  batchResultSync<T = unknown>(): D1Result<T> {
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      const statement = this.db.prepare(this.sql);
      return {
        success: true,
        results: statement.all(...this.values) as T[],
        meta: {}
      } as D1Result<T>;
    }
    return {
      success: true,
      results: [] as T[],
      meta: { changes: this.runSync().changes }
    } as D1Result<T>;
  }
}

export class SqliteD1Database {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string) {
    return new SqliteD1PreparedStatement(this.sqlite, sql) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteD1PreparedStatement).batchResultSync()
      );
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export const createMigratedSqliteD1 = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const migrationsDir = join(process.cwd(), "migrations");
  for (const migrationFile of readdirSync(migrationsDir).filter((fileName) => fileName.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(migrationsDir, migrationFile), "utf8"));
  }
  sqlite.exec(readFileSync(join(process.cwd(), "seeds/dev.sql"), "utf8"));
  return new SqliteD1Database(sqlite);
};
