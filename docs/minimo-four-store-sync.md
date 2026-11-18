# Minimo synchronization

This optional integration is disabled by default. It imports confirmed Minimo bookings as anonymous busy blocks and updates availability from the reservation system. It does not create or cancel customer reservations on Minimo. Installing the code does not enable synchronization.

## Configuration

`MINIMO_SYNC_MODE` accepts `off`, `preview`, or `apply`; missing values mean `off`. Invalid enabled configuration fails before provider requests. Preview may retain encrypted sessions, leases and operational state, but cannot change imported blocks, slot locks, Google jobs or Minimo availability.

`MINIMO_ACCOUNTS_JSON` is a secret array of one to four connections. The current implementation supports store IDs `kyoto`, `osaka`, `nagoya`, and `wakayama`; these are also the development fixture IDs. Each connection supplies `storeId`, `salonId`, `password`, `staff`, optional `intervalMinutes` (outbound, default 30) and optional `inboundIntervalMinutes` (default 10). Both intervals must be integers from 10 to 1440 minutes. Each staff entry supplies `rimaUserId`, an active same-store `resourceId`, and `maxDurationMinutes` covering every bookable Minimo menu (5–720 minutes, divisible by five). Duplicate stores, salon accounts or resources are rejected. Existing imports cannot silently move to another configured account or resource.

`MINIMO_SESSION_KEY` is a separate secret containing a base64-encoded random 32-byte AES-GCM key. Session encryption authenticates the store and connection. Cached sessions expire after six hours; rotating the key requires fresh authentication. Never put credentials, cookies, real account mappings or customer payloads into Git, examples or logs.

Keep `MINIMO_SYNC_MODE=off` during installation. Use the operator's own secret/deployment procedure from [OPERATIONS](OPERATIONS.md). The public repository contains no production account configuration or secret synchronization scripts.

## Import and availability behavior

The inbound phase completes a bounded active-reservation catalogue before using absence. Confirmed statuses 1/2 must match a daily snapshot's reservation ID, staff and start time, with an exact validated duration. It creates or updates `external_blocks(source='minimo')`, five-minute slot locks and the existing Google export jobs atomically. Customer records are not created. Conflicts retain occupied time.

Missing retained reservations are read by ID. Only explicit detail cancellation 11/12 releases their blocks and locks; disappearance, 404, unknown status or inconsistent snapshots do not. Cancelled tombstones require fresh detail before reactivation. Ended appointments are not newly imported; ongoing appointments and future bookings beyond the outbound window remain discoverable.

Outbound considers confirmed local reservations, unexpired approval holds, external blocks, business hours and closures. Minimo-origin busy prevents reopening but does not create a feedback loop of additional closures. Each start time is evaluated over the configured maximum menu duration. A longer bookable menu or observed appointment holds availability writes until configuration is reviewed. A mapped staff member's daily reservation with a status other than confirmed 1/2 or cancelled 11/12, or with no status, holds that day's availability writes for review, because it may still occupy the slot.

Only slots previously closed and still owned by this integration can reopen. Manually closed slots and unmapped staff are preserved. The writer reads remote and local inputs again, records a pending marker before POST, then verifies the complete daily read-back and local inputs. Uncertain or divergent writes retain pending/blocked state for operator review instead of automatic retry.

## Cadence and failure handling

The existing ten-minute maintenance cron runs all due inbound accounts before outbound. The normal inbound target is approximately 10–20 minutes; disabled runtime, restrictions, conflicts and large workloads can exceed it. A per-store inbound segment has 35 seconds. After a complete catalogue, an opaque reservation-ID cursor resumes remaining work; incomplete catalogue pagination restarts from page one. An outbound sweep resumes by date, then waits the configured interval after completing the sweep. The default 30-minute interval is not a guarantee that every change reaches Minimo within 30 minutes.

The runner has a 180-second budget, one global lease, store leases and transaction fences. Requests share at least one second between their start times. HTTP deadlines include pacing, login, one bounded reauthentication after a plain 401 on a read, response streaming and read-back. A challenge 401 does not reauthenticate. A schedule POST that receives 401 is not resent: the day stays pending for review, and the authentication failure stops every account. Identity is verified after fresh authentication, cached-session use and reauthentication.

403, challenge, exhausted authentication, invalid session, unexpected redirect, malformed/oversized response and account mismatch persist a hold that stops every configured account until operator review. A challenge is recognized from the `cf-mitigated: challenge` header, which also wins over a 429. A challenge page whose 401 response has no such header is recognized only after one reauthentication. 429 stops further requests and retains the maximum of Retry-After, the store interval and exponential backoff. Mode, password, mapping and key changes cannot discard restriction evidence or shorten cooldown. No CAPTCHA solving or access-control evasion is included.

Inbound and outbound success/error state are separate. Preview never advances applied-success timestamps. Switching modes resets progress; outbound requires a recent successful inbound pass in that mode. Errors survive partial sweeps and remain visible to cron health.

## Operator status and recovery

Both endpoints require an authenticated `system_admin` and return non-cacheable responses. Staff and owner roles are denied. No dedicated management screen is included.

- `GET /api/admin/sync/minimo` reads recorded state without contacting Minimo. It returns phase timestamps, progress, cooldown, safe reason codes and opaque state tokens. `truncated: true` means more than 400 unresolved dates remain.
- `POST /api/admin/sync/minimo/recover` requires `confirm: true` and the current token. It serializes with scheduled work and rechecks the actor, state and leases in the recovery transaction.

After investigating a restriction, `{"action":"resume","storeId":"kyoto","expectedToken":"<store token>","confirm":true}` releases that store's hold without HTTP. Cooldown and other stores' holds remain effective.

For an uncertain day, `{"action":"reconcile","storeId":"kyoto","date":"2030-01-01","expectedToken":"<day token>","confirm":true}` reserves the next attempt and reads the schedule only in apply mode after cooldown. A login POST can occur; no availability POST is sent. Exact snapshot equality verifies the day. Adding `"discardOwnership":true` explicitly accepts the current remote schedule and relinquishes reopening rights, retaining existing closed slots and imported bookings. Stale tokens, revoked access, inactive mappings and lost leases fail without a successful recovery mutation.

## Schema, verification and rollout boundary

New Minimo migrations are `0061_minimo_four_store_sync.sql`, `0062_minimo_recovery_state.sql`, and `0063_minimo_phase_state.sql`. They follow the separate application's `0059_google_calendar_sync_query_version.sql` and `0060_all_day_closure_block_link.sql` prerequisites. Existing migrations through 0058 and both prerequisite files are unchanged. The block-table rebuild preserves Google references and explicit closure links, slot locks, indexes and store-integrity triggers. Later migrations add mode/phase health and retain provider cooldown and ownership.

Apply 0061 as one atomic migration through `wrangler d1 migrations apply`, never as separate statements. It saves only existing non-null closure links, suspends the five known link/cancellation triggers, temporarily clears those links, rebuilds the parent table, restores the exact links and recreates the same five triggers. The closure table, its RESTRICT FK and partial unique index remain intact; legacy null links are not inferred. Migration itself must not cancel blocks, release locks or produce jobs/audits. Populated SQLite/native-D1 and actual local Wrangler failure-injection checks verify rollback and paired cancellation after success. D1's API denies `integrity_check`; the local SQLite suites and a read-only check of Wrangler's actual persisted DB provide the full integrity check. Verify populated upgrades in the target environment before applying them remotely.

Local tests use synthetic HTTP and SQLite/D1, including native workerd transport and transaction checks. Passing them does not prove current provider compatibility, continuous four-store operation, or an official integration agreement. See the [scope](../specs/014-minimo-four-store-sync/spec.md) and [validation](../specs/014-minimo-four-store-sync/validation.md).

The [official supported-integration FAQ](https://help.chatplus.jp/support-minimo/article/346) lists supported services and excludes other services from support. The [salon-tool terms](https://minimodel.jp/policy/salontool) address server load and suspension; neither establishes an approved request quota or suspension guarantee for this custom integration. Checked 2026-11-17. This code uses an unofficial internal API whose schema can change. No atomic conditional-write contract has been confirmed: read/recheck/write/read-back cannot eliminate simultaneous manual-edit races.

Production rollout requires a separate operator decision and current account/mapping/menu checks. Preserve DB/reference backups, apply reviewed migrations, retain mode off while deploying, inspect preview, then authorize one store before expanding. Stopping with mode off preserves imported busy blocks. Do not drop imports or delete ownership to perform a rollback; database recovery is a separate operation.
