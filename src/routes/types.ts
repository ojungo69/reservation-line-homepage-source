import type { WorkerBindings } from "../bindings";

export type AppEnvironment = {
  Bindings: Partial<WorkerBindings>;
};

export type QueueKickTarget = {
  google?: boolean;
  line?: boolean;
};

export type ConflictHttpStatus = 200 | 400 | 403 | 404 | 409 | 500;

export type ConflictActionGuardCtx = {
  admin: { id: string; email: string; role: "staff" | "owner" | "system_admin"; staff_member_id: string | null; store_id: string | null };
  db: D1Database;
  body: Record<string, unknown>;
  idempotencyKey: string;
  conflictId: string;
};

export type ConflictActionGuardResult =
  | { ok: true; ctx: ConflictActionGuardCtx }
  | { ok: false; response: Response };

export type ReservationPeriodFilter = {
  from: string;
  to: string;
  storeId?: string;
  serviceId?: string;
  statuses: ReadonlySet<string>;
  keyword?: string;
};

export type ReservationPeriodFilterFailure =
  | { ok: false; reason: "invalid_date" }
  | { ok: false; reason: "invalid_filter" }
  | { ok: false; reason: "invalid_status" }
  | { ok: false; reason: "invalid_keyword" };

export type ReadableD1 = Pick<D1Database, "prepare" | "batch">;

declare module "hono" {
  interface ContextVariableMap {
    readDb: ReadableD1;
  }
}
