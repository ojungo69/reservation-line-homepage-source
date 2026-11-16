export const GOOGLE_IMPORT_CLAIM_EXISTS_SQL = `
  SELECT 1
  FROM google_calendar_import_jobs
  WHERE id = ?
    AND status = 'processing'
    AND locked_until = ?
    AND attempt_count = ?
`;

type GoogleImportClaim = {
  jobId: string;
  lockedUntil: string;
  attemptCount: number;
};

export class GoogleImportClaimLostError extends Error {
  constructor() {
    super("google-import-claim-lost");
    this.name = "GoogleImportClaimLostError";
  }
}

// Only this attempt's batch writes are guarded. Native reads/session APIs stay
// intact; single-statement job progress updates retain their own claim predicates.
export const withGoogleImportBatchGuard = (db: D1Database, claim: GoogleImportClaim): D1Database => {
  const bindings = [claim.jobId, claim.lockedUntil, claim.attemptCount];
  const batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const guard = db.prepare(`
      INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id)
      SELECT ?, 'google_import_claim_lost', ?, 'google.import.claim.guard', 'google_calendar_import_job', ?
      WHERE NOT EXISTS (${GOOGLE_IMPORT_CLAIM_EXISTS_SQL})
    `).bind(crypto.randomUUID(), claim.jobId, claim.jobId, ...bindings);
    try {
      return (await db.batch<T>([guard, ...statements])).slice(1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("actor_type")) {
        let current: unknown;
        try {
          current = await db.prepare(GOOGLE_IMPORT_CLAIM_EXISTS_SQL).bind(...bindings).first();
        } catch {
          // A failed lookup cannot prove claim loss; preserve the original failure.
        }
        if (current === null) throw new GoogleImportClaimLostError();
      }
      throw error;
    }
  };
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") return batch;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
};
