# Minimo synchronization contract

Status: local source port; production activation deferred. This preserves the existing implementation's contract and does not expand its rollout authority.

## Required behavior

1. Isolate one to four supported store connections using independent authentication and explicit staff/resource mappings. Reject duplicate accounts, stores or resources before HTTP.
2. Import confirmed statuses 1/2 as anonymous managed blocks with exact validated times, atomic five-minute locks and Google export jobs. Use store plus external reservation ID for idempotency. Create no customer records.
3. Discover appointments through complete bounded active-list pagination. Confirm missing retained IDs by detail; only explicit status 11/12 cancels. Unknown/404/inconsistent records retain locks. Confirmed catalogue records must agree with the daily snapshot. Skip ended appointments; include running and future appointments outside the outbound window. Require current detail before reactivating cancelled tombstones.
4. Preserve prior blocks, Google references, indexes and store-integrity triggers during migration. Ordinary block cancellation and Google conflict recovery cannot cancel Minimo-managed records, including races within a write batch.
5. Close availability based on local bookings, unexpired approval holds, external blocks, hours and closures over the maximum bookable duration. Minimo-origin busy prevents reopening without adding feedback closures. Preserve unmapped staff and manual closures; reopen only verified owned slots.
6. Recheck remote/local inputs before a schedule POST, save pending state first and confirm by read-back. Uncertain or diverged writes require review and are not retried automatically. The protocol provides no confirmed atomic compare-and-set guarantee.
7. Use fixed-origin HTTP, manual redirects, bounded response bodies, shared pacing and lease-aware deadlines. Verify current salon identity after authentication, cached-session use and reauthentication. Encrypt sessions with authenticated store/connection context; discard customer fields and sanitize error reasons.
8. Use the ten-minute cron for inbound before outbound, with a normal inbound target of approximately 10–20 minutes and an independent outbound interval (default 30 minutes after sweep completion). Bound the run and persist resumable progress/errors. No immediate or maximum-latency guarantee applies to large backlogs or provider restrictions.
9. Default to off with no HTTP or business writes. Preview can update operational state but not blocks, locks, Google jobs or provider availability. Separate mode progress and applied/preview success. Inbound success cannot clear unresolved outbound failures.
10. Persist denial/challenge/authentication/protocol holds across mode/config changes and stop all stores until operator review. Retain the maximum of provider Retry-After, store interval and backoff. Recovery cannot shorten cooldown.
11. Expose status and explicit recovery only to system administrators. Require current state tokens, confirmation, global/store leases and transactional actor/state checks. Resume performs no HTTP; reconcile only reads the provider and never posts availability. Explicit ownership relinquishment retains closures and imported bookings.
12. Keep production enabling, real account credentials/mappings, external booking writes and live availability canaries outside this local source port. Real-account and canary evidence belongs to the operator's private records and must be refreshed before a separately authorized rollout.

## Acceptance

Synthetic four-store replays/moves/cancellations produce no cross-store data, duplicate imports or partial locks. Missing data and races preserve occupancy. Preview produces no business writes or schedule POSTs. Tests cover stale leases, identity changes, 401/403/429, malformed/challenge responses, stalled bodies, uncertain writes, bounded convergence, recovery authorization and populated migration preservation. Native D1/workerd tests check transaction and transport behavior separately from external-service claims.

The implementation remains unofficial. Successful requests or tests do not establish provider permission, request quota, long-term compatibility, zero account-suspension risk, or safety against concurrent human edits.
