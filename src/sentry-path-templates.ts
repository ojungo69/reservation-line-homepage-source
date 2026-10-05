// ── Path-template table for dynamic admin/reservation routes ────────
// Extracted from src/index.ts so the HTTP error handler in src/app.ts can
// reuse `normalizePathnameTemplate` for the Sentry route tag WITHOUT importing
// src/index.ts — that would form a circular import (index.ts → app.ts →
// index.ts, since index.ts imports `createApp` from app.ts). Keeping the table
// in its own module also lets the integrity test introspect `adminApiRoutes`
// and this table independently of the worker entrypoint.
//
// Sourced exhaustively from the Hono route registrations in
// src/routes/admin-api.ts. The
// `ADMIN_PATH_TEMPLATES table integrity` test in
// test/sentry-traces-sampler-path-normalize.test.ts drives a concrete sample
// path through normalizePathnameTemplate for every registered route across all
// mounted Hono routers and asserts each lands on its intended template — so a
// new dynamic route that omits a template (UUID leak), or a static sibling
// swallowed by the bare `:id` catch-all (observability drift), fails CI.
//
// Each entry is a compiled RegExp + its template string. Templates use `:id`
// uniformly for any dynamic segment (the original route may name the param
// `:conflictId` / `:storeId` / `:visitId`, but Sentry-side grouping does not
// need that distinction — uniform `:id` keeps the table compact).
//
// Order is significant for the static siblings only. Within each resource
// block:
//   1. Static sibling routes (e.g. `/reservations/pending`) — matched as
//      passthrough so the bare `:id` catch-all below does not swallow them
//      (their last segment is also `[^/]+`, so the catch-all would otherwise
//      match them).
//   2. Dynamic sub-actions (e.g. `/reservations/:id/approve`). These carry a
//      trailing segment, so the anchored `:id` catch-all never matches them
//      regardless of order; they are listed before the catch-all only to keep
//      the table readable and satisfy the ordering integrity test.
//   3. The generic `:id` catch-all for the resource (matched last).

export type PathTemplate = {
  pattern: RegExp;
  template: string;
};

// Single segment ID pattern: one or more non-slash chars.
const ID = "[^/]+";

export const ADMIN_PATH_TEMPLATES: readonly PathTemplate[] = [
  // ── admin/reservations ──
  // Static siblings (src/routes/admin-api.ts registers these BEFORE /:id); pass through unchanged.
  { pattern: /^\/api\/admin\/reservations\/pending$/,                     template: "/api/admin/reservations/pending" },
  { pattern: /^\/api\/admin\/reservations\/search$/,                      template: "/api/admin/reservations/search" },
  { pattern: /^\/api\/admin\/reservations\/available-slots$/,             template: "/api/admin/reservations/available-slots" },
  { pattern: /^\/api\/admin\/reservations\/export\.csv$/,                 template: "/api/admin/reservations/export.csv" },
  { pattern: /^\/api\/admin\/reservations\/auto-complete-overdue$/,       template: "/api/admin/reservations/auto-complete-overdue" },
  { pattern: /^\/api\/admin\/reservations\/unpaid-cancellation-fees$/,    template: "/api/admin/reservations/unpaid-cancellation-fees" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/approve$`),       template: "/api/admin/reservations/:id/approve" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/reject$`),        template: "/api/admin/reservations/:id/reject" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/cancel$`),        template: "/api/admin/reservations/:id/cancel" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/complete$`),      template: "/api/admin/reservations/:id/complete" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/no-show$`),       template: "/api/admin/reservations/:id/no-show" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/correct-no-show$`), template: "/api/admin/reservations/:id/correct-no-show" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/restore-completed$`), template: "/api/admin/reservations/:id/restore-completed" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/reschedule$`),    template: "/api/admin/reservations/:id/reschedule" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}/cancellation-fee$`), template: "/api/admin/reservations/:id/cancellation-fee" },
  { pattern: new RegExp(`^/api/admin/reservations/${ID}$`),               template: "/api/admin/reservations/:id" },

  // ── admin/customers ── (static siblings + dynamic sub-actions before :id)
  { pattern: /^\/api\/admin\/customers\/merge-candidates$/,               template: "/api/admin/customers/merge-candidates" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/block$`),            template: "/api/admin/customers/:id/block" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/unblock$`),          template: "/api/admin/customers/:id/unblock" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/archive$`),          template: "/api/admin/customers/:id/archive" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/unarchive$`),        template: "/api/admin/customers/:id/unarchive" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/memo$`),             template: "/api/admin/customers/:id/memo" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/referrer$`),         template: "/api/admin/customers/:id/referrer" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/reservations$`),     template: "/api/admin/customers/:id/reservations" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/profile$`),          template: "/api/admin/customers/:id/profile" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/merge$`),            template: "/api/admin/customers/:id/merge" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/delete$`),           template: "/api/admin/customers/:id/delete" },
  // visits sub-resource (two-segment): more-specific first (all anchored, no overlap).
  { pattern: new RegExp(`^/api/admin/customers/${ID}/visits/${ID}/notes$`), template: "/api/admin/customers/:id/visits/:id/notes" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/visits/${ID}$`),       template: "/api/admin/customers/:id/visits/:id" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/visits$`),             template: "/api/admin/customers/:id/visits" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}/consents$`),           template: "/api/admin/customers/:id/consents" },
  { pattern: new RegExp(`^/api/admin/customers/${ID}$`),                  template: "/api/admin/customers/:id" },

  // ── admin/settings (services, resources, staff, closures, business-hours) ──
  { pattern: new RegExp(`^/api/admin/settings/services/${ID}$`),          template: "/api/admin/settings/services/:id" },
  { pattern: new RegExp(`^/api/admin/settings/resources/${ID}$`),         template: "/api/admin/settings/resources/:id" },
  { pattern: new RegExp(`^/api/admin/settings/staff/${ID}$`),             template: "/api/admin/settings/staff/:id" },
  { pattern: new RegExp(`^/api/admin/settings/closures/${ID}$`),          template: "/api/admin/settings/closures/:id" },
  { pattern: new RegExp(`^/api/admin/settings/business-hours/${ID}$`),    template: "/api/admin/settings/business-hours/:id" },

  // ── admin/store-logins ──
  { pattern: new RegExp(`^/api/admin/store-logins/${ID}$`),               template: "/api/admin/store-logins/:id" },

  // ── admin/line-friends ──
  { pattern: new RegExp(`^/api/admin/line-friends/${ID}/link$`),          template: "/api/admin/line-friends/:id/link" },

  // ── admin/external-blocks ──
  { pattern: new RegExp(`^/api/admin/external-blocks/${ID}/cancel$`),     template: "/api/admin/external-blocks/:id/cancel" },


  // ── admin/sync (templates use :id uniformly; src/routes/admin-api.ts param name varies) ──
  { pattern: new RegExp(`^/api/admin/sync/conflicts/${ID}/ignore$`),          template: "/api/admin/sync/conflicts/:id/ignore" },
  { pattern: new RegExp(`^/api/admin/sync/conflicts/${ID}/manual-resolve$`),  template: "/api/admin/sync/conflicts/:id/manual-resolve" },
  { pattern: new RegExp(`^/api/admin/sync/conflicts/${ID}/approve-cancel$`),  template: "/api/admin/sync/conflicts/:id/approve-cancel" },
  { pattern: new RegExp(`^/api/admin/sync/conflicts/${ID}/reject-delete$`),   template: "/api/admin/sync/conflicts/:id/reject-delete" },
  { pattern: new RegExp(`^/api/admin/sync/all-day-candidates/${ID}/approve$`), template: "/api/admin/sync/all-day-candidates/:id/approve" },
  { pattern: new RegExp(`^/api/admin/sync/all-day-candidates/${ID}/reject$`),  template: "/api/admin/sync/all-day-candidates/:id/reject" },


  // ── admin PWA assets (registered BEFORE the /admin/* SPA route) ──
  // ID-free and worth their own buckets: a failure here means the service
  // worker or the manifest is unavailable (the "deploy skipped admin:build"
  // signature), which is a different problem from the SPA shell failing. They
  // must precede the /admin/* catch-all below, which would otherwise swallow
  // them the same way it swallows deep links.
  { pattern: /^\/admin\/sw\.js$/,                                        template: "/admin/sw.js" },
  { pattern: /^\/admin\/manifest\.webmanifest$/,                         template: "/admin/manifest.webmanifest" },

  // ── admin SPA browser deep-links (served by `/admin/*` → serveAdminSpa) ──
  // NOT API routes — client-router paths like `/admin/customers/<uuid>` that
  // carry raw customer/reservation IDs. They reach the HTTP error handler when
  // serveAdminSpa throws (e.g. an authenticateAdmin JWKS fetch failure or an
  // ASSETS.fetch error while serving a deep link), so without a template the raw
  // ID would land in the Sentry error event's transaction / request.url /
  // trace.data. Collapse every `/admin/<x>` to one bucket — Sentry only needs
  // "the admin SPA shell", not the specific route. Bare `/admin` is intentionally
  // NOT matched (no ID, and a distinct useful route name). Kept LAST as the
  // broadest `/admin`-prefixed pattern; the `/api/admin/...` API templates above
  // use a different prefix and never collide with it.
  { pattern: /^\/admin\/.+$/,                                            template: "/admin/*" },
];

/** Return the matching route template, or `null` when no template matches.
 *  Strips query string + fragment before matching so callers can pass raw
 *  `urlObject.pathname + search + hash`-style values without missing matches.
 *
 *  Prefer this over `normalizePathnameTemplate` when the result feeds an
 *  unscrubbed sink (e.g. a Sentry tag): a `null` lets the caller drop the
 *  value entirely instead of leaking a raw dynamic segment (UUID/token/PII)
 *  for any path with no matching template. (Admin SPA browser deep-links like
 *  `/admin/customers/<uuid>` are NOT such a case — they collapse to the
 *  `/admin/*` bucket above, so they tag safely rather than dropping.) */
export const matchPathnameTemplate = (pathname: string): string | null => {
  const queryIndex = pathname.search(/[?#]/);
  const matchTarget = queryIndex >= 0 ? pathname.slice(0, queryIndex) : pathname;
  for (const { pattern, template } of ADMIN_PATH_TEMPLATES) {
    if (pattern.test(matchTarget)) {
      return template;
    }
  }
  return null;
};

/** Match a pathname against the template table and return the template if
 *  matched, or the original pathname unchanged when no template matches. */
export const normalizePathnameTemplate = (pathname: string): string =>
  matchPathnameTemplate(pathname) ?? pathname;
