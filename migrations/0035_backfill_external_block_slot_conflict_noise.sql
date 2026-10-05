-- 0035: backfill — auto-dismiss the external_block_slot_conflict noise that
-- accumulated as 'open' before the generation-time change.
--
-- Staff Google-calendar housekeeping events (掃除/休憩/勤怠) overlapping reservation
-- slots are recurring noise (4〜13/day), not actionable conflicts. As of the same
-- release, NEW such overlaps (external_block_id IS NULL) are recorded
-- resolution_status='ignored' at generation time. This one-time backfill flips the
-- rows already accumulated as 'open' so the 要対応 list / owner sync summary / daily
-- ops summary / conflict burst alert are clean immediately on deploy, matching the
-- going-forward behavior (otherwise the owner would have to clear the backlog by hand
-- again, as they last did on 2026-06-15).
--
-- external_block_id IS NULL restricts the flip to the noise case (a NEW unknown event
-- the import could not place). Rows WITH an external_block_id are an already-imported
-- block MOVED into a conflicting time — a real D1↔Google divergence — and are left
-- 'open' (actionable), matching the generation-time predicate. Idempotent: re-running
-- matches nothing (the rows are no longer 'open'). Status-only change; no row is deleted.
UPDATE google_calendar_conflicts
SET resolution_status = 'ignored',
    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    resolved_by = 'system:auto_external_block_overlap'
WHERE conflict_type = 'external_block_slot_conflict'
  AND resolution_status = 'open'
  AND external_block_id IS NULL;
