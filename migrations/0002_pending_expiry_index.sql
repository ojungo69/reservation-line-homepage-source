CREATE INDEX IF NOT EXISTS idx_reservations_pending_expiry ON reservations(status, pending_expires_at, created_at)
  WHERE pending_expires_at IS NOT NULL;
