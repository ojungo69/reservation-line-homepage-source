import type { AdminUser } from "./access";
import { staffCanAccessCustomer } from "./customers";
import {
  escapeLikePattern,
  exceedsLikePatternBudget,
  isJstDayKey,
  jstDayRange,
  jstDayRangeFromKey,
  LINE_IDENTITY_RECENCY_ORDER_BY,
  phoneExactSearchVariants,
  RESERVATION_LINE_FRIEND_STATUS_SUBQUERY,
  VISITED_AT_JST_ORDER_KEY
} from "./shared";
import { RESERVATION_INTERVAL_MINUTES } from "../reservations/slot-times";

export type AdminReservationListRange = "today" | "tomorrow" | "date";
export type ServiceNameSource = "snapshot" | "current" | "unrecorded";

const reservationMenuNameSql = `COALESCE((
  SELECT GROUP_CONCAT(name_snapshot, ' / ') FROM (
    SELECT name_snapshot FROM reservation_services
    WHERE reservation_id = reservations.id ORDER BY display_order ASC
  )
), services.name)`;
const reservationMenuSourceSql = `CASE
  WHEN EXISTS (SELECT 1 FROM reservation_services WHERE reservation_id = reservations.id) THEN 'snapshot'
  WHEN services.name IS NOT NULL THEN 'current' ELSE 'unrecorded' END`;

export type AdminReservationListFailure = {
  ok: false;
  reason: "invalid_date";
};

export type AdminReservationListItem = {
  id: string;
  status: string;
  source: string;
  createdAt: string | null;
  storeId: string;
  storeName: string;
  serviceId: string;
  serviceName: string;
  serviceNameSource: ServiceNameSource;
  resourceId: string;
  resourceName: string;
  startAt: string;
  endAt: string;
  customerId: string;
  customerDisplayName: string;
  lineFriendStatus: string | null;
  // 非null = 「キャンセル料未納」フラグが立っている (no_show 時刻)。管理画面で
  // 赤バッジ表示に使う。owner+ が入金後に解除 (null) できる。
  cancellationFeeUnpaidAt: string | null;
  // 管理画面の出所表示用。NULL = Web/LINE 予約 or 旧データ（source が出所を表す）。
  reservationOrigin: string | null;
};

// CSV-only row carries extra columns that are not exposed on the JSON list
// shape: kana, masked phone tail, and the Google event id. Raw phone_normalized
// MUST NOT be exposed via this type; mapReservationCsvRow performs the mask
// before returning a row, and the caller writes only the masked field to CSV.
export type AdminReservationCsvRow = {
  id: string;
  status: string;
  source: string;
  storeName: string;
  serviceName: string;
  startAt: string;
  endAt: string;
  // Reservation search JSON exposes the customer ID so admin UI can link
  // rows to the customer detail panel. NOT emitted to the CSV export
  // (reservationCsvLine writes an explicit fixed column list).
  customerId: string;
  customerDisplayName: string;
  customerDisplayNameKana: string | null;
  phoneTailMasked: string;
  lineFriendStatus: string | null;
  googleEventId: string | null;
  // Surfaced for the admin reservations table badge. NOT emitted to the CSV
  // export (reservationCsvLine writes an explicit fixed column list).
  cancellationFeeUnpaidAt: string | null;
};

export const VALID_RESERVATION_STATUSES: ReadonlySet<string> = new Set([
  "pending_approval",
  "confirmed",
  "rejected",
  "expired",
  "cancelled_by_customer",
  "cancelled_by_admin",
  "completed",
  "no_show",
  "checked_in"
]);

export type AdminReservationPeriodFailure = {
  ok: false;
  reason: "invalid_date" | "range_too_large" | "invalid_range" | "invalid_keyword";
};

const PERIOD_MAX_DAYS = 92;
const DAY_MS = 24 * 60 * 60 * 1000;

type AdminReservationDetailAuditEntry = {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
  metadataJson: string | null;
};

// Owner-facing summary of the duplicate-reservation acknowledgement recorded at booking
// time (audit action 'public_reservation_duplicate_consent'). Surfaced as a derived
// field so owners can see "this customer was warned and agreed" WITHOUT opening the
// generic audit metadata, which stays system_admin-only. PII-minimal (ids + timestamps).
export type AdminReservationDuplicateConsent = {
  stage: "hard" | "soft";
  warningVersion: string;
  consentedAt: string;
  existingReservations: Array<{ reservationId: string; storeId: string; startAt: string }>;
};

const DUPLICATE_CONSENT_ACTION = "public_reservation_duplicate_consent";

type DuplicateConsentHistoryRow = {
  reservation_id: string;
  metadata_json: string | null;
};

// Parse the duplicate-consent evidence row (if any) out of a set of audit rows. Reads the
// RAW metadata_json (not the role-redacted projection) so the derived field is available
// to owners; the caller only invokes this when audit rows were fetched (i.e. not staff).
// Accepts only the two fields it actually reads so call sites need no full-row casts.
// Returns null on absence or any parse/shape failure (fail-soft: a malformed legacy row
// must never break the detail endpoint).
const parseDuplicateConsent = (
  auditRows: ReadonlyArray<{ action: string; metadata_json: string | null }>
): AdminReservationDuplicateConsent | null => {
  const row = auditRows.find((entry) => entry.action === DUPLICATE_CONSENT_ACTION);
  if (!row?.metadata_json) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const stage = parsed.stage === "hard" || parsed.stage === "soft" ? parsed.stage : null;
    const warningVersion = typeof parsed.warningVersion === "string" ? parsed.warningVersion : null;
    const consentedAt = typeof parsed.consentedAt === "string" ? parsed.consentedAt : null;
    if (!stage || !warningVersion || !consentedAt) {
      return null;
    }
    const existingReservations = Array.isArray(parsed.existingReservations)
      ? parsed.existingReservations.flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const value = item as Record<string, unknown>;
          if (
            typeof value.reservationId !== "string" ||
            typeof value.storeId !== "string" ||
            typeof value.startAt !== "string"
          ) {
            return [];
          }
          return [{ reservationId: value.reservationId, storeId: value.storeId, startAt: value.startAt }];
        })
      : [];
    return { stage, warningVersion, consentedAt, existingReservations };
  } catch {
    return null;
  }
};

type AdminReservationDetailNotificationEntry = {
  id: string;
  templateKey: string;
  recipientType: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
};

type AdminReservationDetailCalendarSyncEntry = {
  id: string;
  googleAction: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
};

export type AdminReservationDetail = AdminReservationListItem & {
  serviceIds: string[];
  customerDisplayNameKana: string | null;
  phoneNormalized: string | null;
  googleSyncState: string | null;
  googleEventId: string | null;
  version: number;
  // Customer-level free-text notes (customers.memo / allergy_notes). Detail-only:
  // intentionally NOT on reservationSelect / list / search / CSV — those shared
  // paths must not pull 1000–2000 char PII or risk result_too_large.
  customerMemo: string | null;
  customerAllergyNotes: string | null;
  // 同じ顧客の直近の施術メモ。visits はこの予約の来店行しか含まないので、施術前に
  // 過去のカルテを読む導線がこれしかない。Detail-only なのは customerMemo と同じ理由。
  // storeId / storeName は他店舗のカルテを見分けるため。owner 以上はこの一覧に全店舗ぶんが
  // 並ぶので、どこで受けた施術かが分からないと、別店舗の内容を自店舗の履歴として読む。
  // staff は自店舗ぶんしか引かないので、この 2 つは常に予約の店舗と一致する。
  customerPastNotes: Array<{
    visitedAt: string;
    treatmentNotes: string;
    // customer_visits.store_id は NOT NULL の FK (ON DELETE RESTRICT) なので、
    // LEFT JOIN は必ず解決する。
    storeId: string;
    storeName: string;
  }>;
  // 上の 3 件より前にもメモがあるか。件数からは判定できない (ちょうど 3 件の顧客と打ち切られた
  // 顧客がどちらも 3 になる)。
  customerPastNotesTruncated: boolean;
  visits: Array<{
    id: string;
    visitedAt: string;
    visitSource: string;
    status: string;
    treatmentNotes: string | null;
  }>;
  audit: AdminReservationDetailAuditEntry[];
  notifications: AdminReservationDetailNotificationEntry[];
  calendarSync: AdminReservationDetailCalendarSyncEntry[];
  // Owner-visible duplicate-reservation acknowledgement (null when none was required).
  // Derived from the audit row; available to owner + system_admin (staff get no audit).
  duplicateConsent: AdminReservationDuplicateConsent | null;
};

/** Empty string → null for optional free-text fields on detail responses. */
const emptyToNull = (value: string | null | undefined): string | null => {
  if (value == null || value === "") return null;
  return value;
};

// 来店履歴の「記入者」。`recorded_by` に入るのは自動完了 cron の 'system' か
// `admin_users.id` で、そのままでは誰か分からない。名前まで解決できるのは
// staff_members に紐付いた管理ユーザーだけ (本番実測で 532 行中 4 行) なので、
// 紐付きが無い場合は role の日本語ラベルまで落とす。メールは出さない。
const ADMIN_ROLE_LABELS: Record<string, string> = {
  owner: "オーナー",
  staff: "スタッフ",
  system_admin: "システム管理者"
};

export const CUSTOMER_VISITS_PAGE_SIZE = 50;
const CUSTOMER_RESERVATIONS_PAGE_SIZE = 50;
const CUSTOMER_CONSENTS_PAGE_SIZE = 50;

type CustomerVisitRow = {
  id: string;
  reservation_id: string | null;
  store_id: string;
  store_name: string;
  service_name: string | null;
  service_name_source: ServiceNameSource;
  visited_at: string;
  visit_source: string;
  status: string;
  treatment_notes: string | null;
  recorded_by: string;
  recorded_by_role: string | null;
  recorded_by_name: string | null;
};

/**
 * 来店履歴の 1 ページ。顧客詳細の初回表示と「さらに読み込む」の両方がこれを使う —
 * 別々に書くと店舗スコープの条件がいつか片方だけずれる (staff が他店舗の来店を
 * 読める、が最悪の形)。`storeFilter` は staff のときだけ非 null。
 */
const selectCustomerVisitsPage = (
  db: D1Database,
  customerId: string,
  storeFilter: string | null,
  offset: number
) =>
  db
    .prepare(
      `
        SELECT customer_visits.id,
               reservations.id AS reservation_id,
               customer_visits.store_id,
               stores.name AS store_name,
               ${reservationMenuNameSql} AS service_name,
               ${reservationMenuSourceSql} AS service_name_source,
               customer_visits.visited_at,
               customer_visits.visit_source,
               customer_visits.status,
               customer_visits.treatment_notes,
               customer_visits.recorded_by,
               admin_users.role AS recorded_by_role,
               staff_members.display_name AS recorded_by_name
        FROM customer_visits
        JOIN stores ON stores.id = customer_visits.store_id
        LEFT JOIN reservations ON reservations.id = customer_visits.reservation_id
          AND reservations.customer_id = customer_visits.customer_id
          AND reservations.store_id = customer_visits.store_id
        LEFT JOIN services ON services.id = reservations.service_id
        LEFT JOIN admin_users ON admin_users.id = customer_visits.recorded_by
        LEFT JOIN staff_members ON staff_members.id = admin_users.staff_member_id
        WHERE customer_visits.customer_id = ?${storeFilter ? " AND customer_visits.store_id = ?" : ""}
        ORDER BY ${VISITED_AT_JST_ORDER_KEY} DESC,
                 customer_visits.created_at DESC,
                 customer_visits.id DESC
        LIMIT ${CUSTOMER_VISITS_PAGE_SIZE} OFFSET ?
      `
    )
    .bind(...(storeFilter ? [customerId, storeFilter, offset] : [customerId, offset]))
    .all<CustomerVisitRow>();

type CustomerConsentRow = {
  id: string;
  consent_type: string;
  version: string;
  consented_at: string;
};

// Merge keeps consent.customer_id as the capture identity. Expand source rows
// only for a canonical customer; an owner's tombstone view stays direct-only.
const selectCustomerConsentsPage = (
  db: D1Database,
  customerId: string,
  storeFilter: string | null,
  offset: number
) =>
  db
    .prepare(
      `
        WITH RECURSIVE consent_customers(id, expand_sources) AS (
          SELECT id, merged_into_id IS NULL FROM customers WHERE id = ?
          UNION
          SELECT source.id, family.expand_sources
          FROM customers AS source
          JOIN consent_customers AS family ON source.merged_into_id = family.id
          WHERE family.expand_sources = 1
        )
        SELECT consent_records.id,
               consent_records.consent_type,
               consent_records.version,
               consent_records.consented_at
        FROM consent_records
        ${
          storeFilter
            ? "JOIN reservations ON reservations.id = consent_records.reservation_id AND reservations.customer_id = ?"
            : ""
        }
        WHERE consent_records.customer_id IN (SELECT id FROM consent_customers)${storeFilter ? " AND reservations.store_id = ?" : ""}
        ORDER BY consent_records.consented_at DESC, consent_records.id DESC
        LIMIT ${CUSTOMER_CONSENTS_PAGE_SIZE} OFFSET ?
      `
    )
    .bind(...(storeFilter ? [customerId, customerId, storeFilter, offset] : [customerId, offset]))
    .all<CustomerConsentRow>();

const mapConsentRow = (row: CustomerConsentRow) => ({
  id: row.id,
  type: row.consent_type,
  version: row.version,
  consentedAt: row.consented_at
});

/**
 * 来店記録を**作った**人のラベル。施術メモの書き手ではない。
 *
 * 施術メモの更新 (`customer.visit_notes_update`) は `treatment_notes` だけを書き換えて
 * `recorded_by` を触らないので、自動完了で作られた来店にスタッフがメモを足しても
 * ここは「自動完了」のままになる。画面のラベルを「記入」ではなく「登録」にしてあるのは
 * そのため。メモの書き手を出すなら audit_logs の最新の actor を引く必要がある。
 */
const resolveRecordedByLabel = (row: {
  recorded_by: string;
  recorded_by_role: string | null;
  recorded_by_name: string | null;
}): string => {
  if (row.recorded_by === "system") return "自動完了";
  if (row.recorded_by_name) return row.recorded_by_name;
  // 生の role をそのまま出さない。role は CHECK で 3 値に限られるので上の表で必ず
  // 引けるが、外れた値を英語のまま画面に出すと来店バッジに `valid` が出ていたのと
  // 同じことになる。
  if (row.recorded_by_role) return ADMIN_ROLE_LABELS[row.recorded_by_role] ?? "不明";
  // 退職などで admin_users から消えた記入者。行そのものは残るので空欄にしない。
  return "不明";
};

const mapVisitRow = (visit: CustomerVisitRow) => ({
  id: visit.id,
  reservationId: visit.reservation_id,
  storeId: visit.store_id,
  storeName: visit.store_name,
  serviceName: visit.service_name,
  serviceNameSource: visit.service_name_source,
  visitedAt: visit.visited_at,
  visitSource: visit.visit_source,
  status: visit.status,
  treatmentNotes: visit.treatment_notes,
  recordedBy: resolveRecordedByLabel(visit)
});

export type AdminCustomerDetail = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalized: string | null;
  blockStatus: string;
  memo: string | null;
  referrerName: string | null;
  birthDate: string | null;
  gender: string | null;
  allergyNotes: string | null;
  archivedAt: string | null;
  lineIdentities: Array<{
    id: string;
    officialFriendStatus: string;
    followedAt: string | null;
    unfollowedAt: string | null;
    lastFriendCheckedAt: string | null;
  }>;
  // Valid visits for this customer, NOT limited to the `visits` page below —
  // that array is capped and includes voided rows, so its length is not the
  // customer's visit count.
  validVisitCount: number;
  lastVisitAt: string | null;
  nextReservation: AdminReservationListItem | null;
  visits: Array<{
    id: string;
    reservationId: string | null;
    storeId: string;
    storeName: string;
    serviceName: string | null;
    serviceNameSource: ServiceNameSource;
    visitedAt: string;
    visitSource: string;
    status: string;
    treatmentNotes: string | null;
    // 記入者の表示名。id をそのまま出しても誰か分からないので、サーバ側で
    // 名前まで解決して返す (解決の規則は resolveRecordedByLabel を参照)。
    recordedBy: string;
  }>;
  reservations: Array<AdminReservationListItem>;
  reservationsNextOffset: number | null;
  consentHistory: Array<{
    id: string;
    type: string;
    version: string;
    consentedAt: string;
  }>;
  consentHistoryNextOffset: number | null;
  // Owner/system_admin only (empty for staff): the customer's duplicate-reservation
  // acknowledgements over time, so an owner can spot a customer who repeatedly books
  // duplicates to dodge the change-request flow.
  duplicateConsentHistory: Array<{
    reservationId: string;
    consentedAt: string;
    stage: "hard" | "soft";
    warningVersion: string;
    existingCount: number;
  }>;
};

export type AdminExternalBlockListItem = {
  id: string;
  storeId: string;
  storeName: string;
  resourceId: string;
  resourceName: string;
  source: string;
  titleSnapshot: string | null;
  startAt: string;
  endAt: string;
  status: string;
  googleEventId: string | null;
  createdBy: string | null;
  updatedAt: string;
};

export type AdminSettingsSnapshot = {
  stores: Array<{
    id: string;
    name: string;
    timezone: string;
    googleCalendarId: string | null;
    googleControlledEditMode: boolean;
    maxActiveReservationsPerCustomer: number;
    bookingWindowDays: number;
    customerNotice: string | null;
  }>;
  resources: Array<{
    id: string;
    storeId: string;
    name: string;
    resourceType: string;
    active: boolean;
  }>;
  services: Array<{
    id: string;
    storeId: string;
    name: string;
    priceLabel: string | null;
    priceAmount: number | null;
    comboPriceAmount: number | null;
    comboWithPrefix: string | null;
    durationMinutes: number;
    active: boolean;
    mensMenu: boolean;
  }>;
  businessHours: Array<{
    id: string;
    storeId: string;
    weekday: number;
    opensAt: string;
    closesAt: string;
    active: boolean;
  }>;
  reminderOffsets: Array<{
    storeId: string;
    offsetMinutes: number | null;
  }>;
  closures: Array<{
    id: string;
    storeId: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
    source: string;
  }>;
  staff: Array<{
    id: string;
    storeId: string;
    displayName: string;
    role: string;
    active: boolean;
    version: number;
  }>;
};

export type AdminAuditLogItem = {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadataJson: string | null;
  // 予約却下 (admin_reservation_reject) の行のみ metadata から抽出した却下理由。
  // raw metadataJson と違い owner にも開示する (staff はこの API 自体 403)。
  rejectionReason: string | null;
  createdAt: string;
};

type ReservationRow = {
  id: string;
  status: string;
  source: string;
  created_at: string | null;
  store_id: string;
  store_name: string;
  service_id: string;
  service_name: string;
  service_name_source: ServiceNameSource;
  resource_id: string;
  resource_name: string;
  start_at: string;
  end_at: string;
  customer_id: string;
  customer_display_name: string;
  customer_display_name_kana: string | null;
  phone_normalized: string | null;
  line_friend_status: string | null;
  google_sync_state: string;
  google_event_id: string | null;
  version: number;
  checked_in_at: string | null;
  cancellation_fee_unpaid_at: string | null;
  reservation_origin: string | null;
};

type CustomerRow = {
  id: string;
  display_name: string;
  display_name_kana: string | null;
  phone_normalized: string | null;
  block_status: string;
  memo: string | null;
  referrer_name: string | null;
  birth_date: string | null;
  gender: string | null;
  allergy_notes: string | null;
  archived_at: string | null;
};

type AuditLogRow = {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json: string | null;
  created_at: string;
};

type NotificationJobRow = {
  id: string;
  template_key: string;
  recipient_type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type CalendarSyncJobRow = {
  id: string;
  google_action: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const deriveStatus = (row: { status: string; checked_in_at?: string | null }): string =>
  row.status === "confirmed" && row.checked_in_at ? "checked_in" : row.status;

const mapReservationRow = (row: ReservationRow): AdminReservationListItem => ({
  id: row.id,
  status: deriveStatus(row),
  source: row.source,
  createdAt: row.created_at,
  storeId: row.store_id,
  storeName: row.store_name,
  serviceId: row.service_id,
  serviceName: row.service_name,
  serviceNameSource: row.service_name_source,
  resourceId: row.resource_id,
  resourceName: row.resource_name,
  startAt: row.start_at,
  endAt: row.end_at,
  customerId: row.customer_id,
  customerDisplayName: row.customer_display_name,
  lineFriendStatus: row.line_friend_status,
  cancellationFeeUnpaidAt: row.cancellation_fee_unpaid_at,
  reservationOrigin: row.reservation_origin
});

// Mask a phone_normalized string to its last four digits. NULL or short input
// returns "****" so the CSV always carries a non-empty marker (signals the
// reservation has no phone on file rather than an export bug).
export const maskPhoneTail = (raw: string | null): string => {
  if (!raw) return "****";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `***-****-${digits.slice(-4)}`;
};

const mapReservationCsvRow = (row: ReservationRow, isStaff: boolean): AdminReservationCsvRow => ({
  id: row.id,
  status: deriveStatus(row),
  source: row.source,
  storeName: row.store_name,
  serviceName: row.service_name,
  startAt: row.start_at,
  endAt: row.end_at,
  customerId: row.customer_id,
  customerDisplayName: row.customer_display_name,
  customerDisplayNameKana: row.customer_display_name_kana,
  phoneTailMasked: maskPhoneTail(row.phone_normalized),
  lineFriendStatus: row.line_friend_status,
  // Staff must not see Google Calendar event IDs — mirrors the per-role
  // redaction in getAdminReservationDetail (googleEventId: isStaff ? null).
  // Both /reservations/search (JSON) and /reservations/export.csv flow through
  // here, so this is the single redaction point for the period surface.
  googleEventId: isStaff ? null : row.google_event_id,
  cancellationFeeUnpaidAt: row.cancellation_fee_unpaid_at
});

const reservationSelect = `
  SELECT
    reservations.id,
    reservations.status,
    reservations.source,
    strftime('%Y-%m-%dT%H:%M:%fZ', reservations.created_at) AS created_at,
    reservations.store_id,
    stores.name AS store_name,
    ${reservationMenuNameSql} AS service_name,
    ${reservationMenuSourceSql} AS service_name_source,
    reservations.service_id,
    reservations.resource_id,
    store_resources.name AS resource_name,
    reservations.start_at,
    reservations.end_at,
    customers.id AS customer_id,
    customers.display_name AS customer_display_name,
    customers.display_name_kana AS customer_display_name_kana,
    customers.phone_normalized AS phone_normalized,
    ${RESERVATION_LINE_FRIEND_STATUS_SUBQUERY} AS line_friend_status,
    reservations.google_sync_state,
    reservations.google_event_id,
    reservations.version,
    reservations.checked_in_at,
    reservations.cancellation_fee_unpaid_at,
    reservations.reservation_origin
  FROM reservations
  JOIN stores ON stores.id = reservations.store_id
  JOIN services ON services.id = reservations.service_id
  JOIN store_resources ON store_resources.id = reservations.resource_id
  JOIN customers ON customers.id = reservations.customer_id
`;

const selectCustomerReservationsPage = (db: D1Database, customerId: string, storeFilter: string | null, offset: number) =>
  db.prepare(`${reservationSelect}
    WHERE reservations.customer_id = ?${storeFilter ? " AND reservations.store_id = ?" : ""}
    ORDER BY reservations.start_at DESC, reservations.id DESC
    LIMIT ${CUSTOMER_RESERVATIONS_PAGE_SIZE} OFFSET ?`)
    .bind(...(storeFilter ? [customerId, storeFilter, offset] : [customerId, offset]))
    .all<ReservationRow>();

type ReservationListDateParams = {
  range: AdminReservationListRange;
  date?: string;
};
const parseDateRange = (
  params: ReservationListDateParams
): { ok: true; dayKey: string | null } | AdminReservationListFailure => {
  if (params.range === "date") {
    if (typeof params.date !== "string" || !isJstDayKey(params.date)) return { ok: false, reason: "invalid_date" };
    if (!jstDayRangeFromKey(params.date)) return { ok: false, reason: "invalid_date" };
    return { ok: true, dayKey: params.date };
  }
  if (params.date !== undefined) return { ok: false, reason: "invalid_date" };
  return { ok: true, dayKey: null };
};

const resolveDay = (
  range: AdminReservationListRange,
  dayKey: string | null,
  nowMs: number
): { startAt: string; endAt: string } => {
  if (range === "tomorrow") return jstDayRange(nowMs, 1);
  if (range === "date" && dayKey) return jstDayRangeFromKey(dayKey)!;
  return jstDayRange(nowMs, 0);
};

export async function listAdminReservations(input: {
  db: D1Database;
  range: AdminReservationListRange;
  admin: AdminUser;
  date?: string;
  now?: () => number;
  storeId?: string | null;
}): Promise<
  | {
      ok: true;
      range: AdminReservationListRange;
      startAt: string;
      endAt: string;
      reservations: AdminReservationListItem[];
    }
  | AdminReservationListFailure
> {
  const nowMs = (input.now ?? Date.now)();
  const dateResult = parseDateRange(input);
  if (!dateResult.ok) return dateResult;

  const isStaff = input.admin.role === "staff";

  // staff は自店舗 scope のみ。2026-07-14 に当日 clamp を撤廃 — スケジュール画面で
  // staff も前日/翌日/週を閲覧できるようにするため、要求された日付をそのまま解決する
  // (旧: staff は常に当日へ clamp し staff_date_locked notice を返していた)。
  const day = resolveDay(input.range, dateResult.dayKey, nowMs);
  if (isStaff && !input.admin.store_id) {
    return { ok: true, range: input.range, startAt: day.startAt, endAt: day.endAt, reservations: [] };
  }
  const storeId = isStaff ? input.admin.store_id : (input.storeId ?? null);
  const storeFilter = storeId ? `AND reservations.store_id = ?` : "";
  const binds: string[] = [day.startAt, day.endAt];
  if (storeId) binds.push(storeId);

  const result = await input.db
    .prepare(
      `
        ${reservationSelect}
        WHERE reservations.start_at >= ?
          AND reservations.start_at < ?
          ${storeFilter}
        ORDER BY reservations.start_at ASC, stores.name ASC
        LIMIT 200
      `
    )
    .bind(...binds)
    .all<ReservationRow>();

  return {
    ok: true,
    range: input.range,
    startAt: day.startAt,
    endAt: day.endAt,
    reservations: (result.results ?? []).map(mapReservationRow)
  };
}

// Days between two YYYY-MM-DD JST keys, treating both as full JST days.
// Returns +1 for from==to (single-day range), +92 for a 92-day inclusive
// span (from..to). Negative when to < from.
const jstDaySpan = (from: string, to: string): number => {
  const fromRange = jstDayRangeFromKey(from);
  const toRange = jstDayRangeFromKey(to);
  if (!fromRange || !toRange) return Number.NaN;
  const diffMs = Date.parse(toRange.startAt) - Date.parse(fromRange.startAt);
  return Math.round(diffMs / DAY_MS) + 1;
};

export type AdminReservationPeriodOutcome =
  | {
      ok: true;
      rows: AdminReservationCsvRow[];
      truncated: boolean;
    }
  | AdminReservationPeriodFailure;

// Inputs are expected to be pre-validated:
//   - statuses: each entry is in VALID_RESERVATION_STATUSES (caller dedupes
//     and caps to 8 entries; an empty Set means "all statuses").
//   - keyword: pre-normalized; the LIKE pattern derived here must fit
//     LIKE_PATTERN_BYTE_BUDGET bytes (UTF-8) per D1 safety margin.
//   - storeId / serviceId: opaque IDs the caller already format-checked.
// Returns AdminReservationCsvRow[] for both search (sliced by caller) and
// CSV export. truncated is true exactly when the underlying query returned
// the full `limit` rows (i.e. there could be more).

function buildKeywordFilterClause(
  keyword: string,
  // Staff see only the last-4 masked phone (mapReservationCsvRow / row mapper
  // parity with searchAdminCustomers). A phone_normalized LIKE '%digits%'
  // match lets store-scoped staff binary-search the masked middle digits by
  // probing partial substrings and watching which reservation appears — the
  // same recovery-oracle shape closed for customer search in
  // searchAdminCustomers (src/admin/customers.ts). Staff get an EXACT match
  // instead: it still serves the real workflow (look up by the FULL number)
  // while a partial (3-7 digit) probe matches nothing.
  isStaff: boolean
): { ok: true; condition: string; params: unknown[] } | { ok: false; reason: "invalid_keyword" } {
  const pattern = `%${escapeLikePattern(keyword)}%`;
  if (exceedsLikePatternBudget(pattern)) {
    return { ok: false, reason: "invalid_keyword" };
  }
  // customers.phone_normalized stores `\s/-/(/.)`-stripped digits (see
  // normalizePhone in shared.ts). Operators commonly enter "080-1234-5678"
  // or "080 1234 5678" in the keyword box; matching the raw pattern against
  // the normalized column would always fail. Compute a digit-only variant
  // and substitute it for the phone arm so phone search works regardless
  // of formatting. Keep the raw pattern for name/kana matching since those
  // arms operate on text columns.
  const phoneDigits = keyword.replace(/\D/g, "");
  const params: unknown[] = [pattern, pattern];
  let phoneClause = "";
  if (isStaff) {
    // Exact match against both stored variants (+81 ↔ 0): phone_normalized
    // preserves a leading '+', so a digits-only bind would miss
    // internationally-stored numbers. Non-full-number keywords get no phone
    // arm at all — a partial probe matches nothing (oracle stays closed).
    const variants = phoneExactSearchVariants(keyword);
    if (variants.length > 0) {
      phoneClause = `OR customers.phone_normalized IN (${variants.map(() => "?").join(", ")})`;
      params.push(...variants);
    }
  } else if (phoneDigits.length > 0) {
    phoneClause = String.raw`OR COALESCE(customers.phone_normalized, '') LIKE ? ESCAPE '\'`;
    params.push(`%${escapeLikePattern(phoneDigits)}%`);
  }
  const condition = String.raw`(LOWER(customers.display_name) LIKE LOWER(?) ESCAPE '\'
      OR LOWER(COALESCE(customers.display_name_kana, '')) LIKE LOWER(?) ESCAPE '\'
      ${phoneClause})`;
  return { ok: true, condition, params };
}

function expandVirtualStatusFilter(
  statuses: ReadonlySet<string>
): { condition: string | null; bindings: unknown[] } {
  const hasCheckedIn = statuses.has("checked_in");
  const hasConfirmed = statuses.has("confirmed");
  const dbStatuses = new Set(statuses);
  dbStatuses.delete("checked_in");
  if (hasCheckedIn && !hasConfirmed) dbStatuses.delete("confirmed");

  const clauses: string[] = [];
  const bindings: unknown[] = [];

  if (dbStatuses.size > 0) {
    const placeholders = Array.from(dbStatuses, () => "?").join(",");
    const confirmedOnlyGuard = hasConfirmed && !hasCheckedIn
      ? " AND (reservations.status != 'confirmed' OR reservations.checked_in_at IS NULL)"
      : "";
    clauses.push(`(reservations.status IN (${placeholders})${confirmedOnlyGuard})`);
    for (const s of dbStatuses) bindings.push(s);
  }
  if (hasCheckedIn) {
    clauses.push("(reservations.status = 'confirmed' AND reservations.checked_in_at IS NOT NULL)");
  }

  return clauses.length > 0
    ? { condition: `(${clauses.join(" OR ")})`, bindings }
    : { condition: null, bindings: [] };
}

function buildReservationFilterClauses(input: {
  storeId?: string;
  statuses?: ReadonlySet<string>;
  serviceId?: string;
  keyword?: string;
  isStaff: boolean;
}): { ok: true; conditions: string[]; params: unknown[] } | { ok: false; reason: "invalid_keyword" } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.storeId !== undefined) {
    conditions.push("reservations.store_id = ?");
    params.push(input.storeId);
  }

  if (input.statuses && input.statuses.size > 0) {
    const { condition, bindings } = expandVirtualStatusFilter(input.statuses);
    if (condition) {
      conditions.push(condition);
      params.push(...bindings);
    }
  }

  if (input.serviceId !== undefined) {
    // Legacy reservations may carry only the single-service `reservations.service_id`
    // column with no `reservation_services` junction rows (the SELECT already
    // falls back to `services.name` for that case). Match either source so the
    // filter returns historical rows alongside multi-menu ones.
    conditions.push(
      "(reservations.service_id = ? OR EXISTS (SELECT 1 FROM reservation_services rs WHERE rs.reservation_id = reservations.id AND rs.service_id = ?))"
    );
    params.push(input.serviceId, input.serviceId);
  }

  if (input.keyword !== undefined && input.keyword.length > 0) {
    const keywordClause = buildKeywordFilterClause(input.keyword, input.isStaff);
    if (!keywordClause.ok) return { ok: false, reason: keywordClause.reason };
    conditions.push(keywordClause.condition);
    params.push(...keywordClause.params);
  }

  return { ok: true, conditions, params };
}

export async function listAdminReservationsForPeriod(input: {
  db: D1Database;
  from: string;
  to: string;
  storeId?: string;
  statuses?: ReadonlySet<string>;
  serviceId?: string;
  keyword?: string;
  limit: number;
  // Whether the requesting admin is a store staff member. Staff must not see
  // Google Calendar event IDs (parity with getAdminReservationDetail); the row
  // mapper nulls googleEventId when true.
  isStaff: boolean;
  // Optional zero-based page offset. The paged CSV streamer uses this to
  // pull rows in 10K-row chunks instead of materializing 25K rows in a
  // single D1 query (which hits the `result_too_large` cap). Default 0
  // keeps the existing single-shot callers unchanged.
  offset?: number;
}): Promise<AdminReservationPeriodOutcome> {
  if (!isJstDayKey(input.from) || !isJstDayKey(input.to)) {
    return { ok: false, reason: "invalid_date" };
  }
  const fromRange = jstDayRangeFromKey(input.from);
  const toRange = jstDayRangeFromKey(input.to);
  if (!fromRange || !toRange) {
    return { ok: false, reason: "invalid_date" };
  }
  if (Date.parse(toRange.startAt) < Date.parse(fromRange.startAt)) {
    return { ok: false, reason: "invalid_range" };
  }
  const span = jstDaySpan(input.from, input.to);
  if (span > PERIOD_MAX_DAYS) {
    return { ok: false, reason: "range_too_large" };
  }

  const filters = buildReservationFilterClauses({
    storeId: input.storeId,
    statuses: input.statuses,
    serviceId: input.serviceId,
    keyword: input.keyword,
    isStaff: input.isStaff
  });
  if (!filters.ok) {
    return { ok: false, reason: filters.reason };
  }

  const conditions: string[] = [
    "reservations.start_at >= ?",
    "reservations.start_at < ?",
    ...filters.conditions
  ];
  const params: unknown[] = [fromRange.startAt, toRange.endAt, ...filters.params];

  // Stable tiebreaker on `reservations.id` so OFFSET pagination cannot skip
  // or duplicate rows when ties exist on (start_at, stores.name).
  const sql = `
    ${reservationSelect}
    WHERE ${conditions.join("\n      AND ")}
    ORDER BY reservations.start_at ASC, stores.name ASC, reservations.id ASC
    LIMIT ?
    OFFSET ?
  `;
  const limitClamped = Math.max(1, Math.floor(input.limit));
  const offsetClamped = Math.max(0, Math.floor(input.offset ?? 0));
  params.push(limitClamped, offsetClamped);

  const result = await input.db
    .prepare(sql)
    .bind(...params)
    .all<ReservationRow>();
  const rows = (result.results ?? []).map((row) => mapReservationCsvRow(row, input.isStaff));
  return {
    ok: true,
    rows,
    truncated: rows.length >= limitClamped
  };
}

// Staff store-scope gate for the reservation detail, decided BEFORE any PII leaves
// D1: reservationSelect joins customer name / kana / raw phone / LINE status, so the
// scope check runs first, from a store_id-only probe. A staff without a store binding
// is rejected before any query at all (fail closed). Mirrors getAdminCustomerDetail.
const checkStaffReservationScope = async (
  db: D1Database,
  reservationId: string,
  admin: AdminUser
): Promise<"ok" | "not_found" | "forbidden"> => {
  if (!admin.store_id) {
    return "forbidden";
  }
  const scopeRow = await db
    .prepare(`SELECT store_id FROM reservations WHERE id = ? LIMIT 1`)
    .bind(reservationId)
    .first<{ store_id: string }>();
  if (!scopeRow) {
    return "not_found";
  }
  return scopeRow.store_id === admin.store_id ? "ok" : "forbidden";
};

/**
 * staff には返さない診断系の一覧 (監査ログ・通知ジョブ・カレンダー同期ジョブ・重複同意の証跡)。
 * どれも「staff なら空、そうでなければ引く」の同じ形なので、分岐をここ 1 つに集める。
 * 件数は書かない — 呼び出し箇所が増減するたびに嘘になるため。
 *
 * 真偽値ではなく admin を受けるのは、真偽値だと極性を取り違えても型が通ってしまい、
 * 「staff にだけ見せる」の意味で渡した呼び出しが静かに逆の結果を返すため。
 */
const ownerOnlyRows = <T>(
  admin: { role: string },
  run: () => Promise<{ results: T[] }>
): Promise<{ results: T[] }> => (admin.role === "staff" ? Promise.resolve({ results: [] }) : run());

/**
 * 予約詳細の「過去の施術メモ (カルテ)」。呼び出し元から切り出してあるのは、店舗スコープの
 * 分岐が getAdminReservationDetail 本体の認知的複雑度に載ってしまうため。
 *
 * visits は WHERE reservation_id = ? なので、まだ完了していない予約を開くと1件も出ない —
 * 施術前にカルテを読みたい場面がまさにそれなので、同じ顧客の直近の有効な来店からメモだけを
 * 引く。この予約自身の来店行は visits で出るため除く。staff は自店舗ぶんだけ
 * (getAdminCustomerDetail の来店履歴クエリと同じ store scope)、owner 以上は全店舗ぶん。
 * 顧客タブの来店履歴より条件が狭い (valid のみ・3 件) のは仕様で、揃える必要はない。
 */
const selectCustomerPastNotes = (
  db: D1Database,
  args: { customerId: string; reservationId: string; startAt: string; admin: AdminUser }
) => {
  const storeId = args.admin.role === "staff" ? args.admin.store_id : null;
  // visited_at < 予約の開始時刻: 「過去の」と名乗る以上、その予約より後に記録されたメモを
  // 混ぜてはいけない (終了済みの予約を開くと未来のカルテが並ぶ)。
  // 手動来店の visited_at は JST の 'YYYY-MM-DD' 日付キー、予約由来は UTC の ISO 文字列で
  // 書式が違う。素の文字列比較だと、予約が JST 09:00 より前に始まる回だけ start_at の UTC
  // 日付が前日になり、同じ JST 日に手入力したメモが落ちて挙動が開始時刻で変わる。日付キーの
  // 行だけ JST 日 (date(start_at, '+9 hours')) と比べ、同日ぶんは含める。
  // 並び順の第1キーも JST に寄せる。生の文字列のまま比べると、JST 08:30 の予約から起きた行
  // ('2026-04-01T23:30:00.000Z') が同じ JST 日の日付キー ('2026-04-02') より後ろに回る。
  // 日ではなく時刻まで残すこと (date() ではなく datetime()): 同じ JST 日に予約由来の来店が
  // 2 件あると、日に丸めた瞬間に両者が同値になり、来店順ではなく完了処理をした順で並ぶ。
  // 帰結として、時刻を持たない日付キーの行は同じ JST 日のなかで常に最下位 (0 時扱い) になる。
  // 手入力に時刻が無い以上どこかに置くしかなく、これは意図した位置。
  // 第2キー created_at: 日付キーどうしは visited_at が完全に同値なので記録順で割る
  // (SELECT には出さない)。第3キー id は crypto.randomUUID() で記録順と無関係なため単独では使えない。
  // ponytail: created_at は書き込み側がどこも渡さず CURRENT_TIMESTAMP 任せ = 秒精度なので、
  // 同じ秒に入った 2 件は結局 id 順。実運用で並ばないのでここは詰めない。
  // LIMIT 4: 表示は 3 件で、4 件目は「これより前にもある」と言ってよいかの判定にだけ使う。
  // trim の第2引数: SQLite の 1 引数 trim() は半角スペースしか落とさない。改行だけのメモは
  // API 経由では入らない (書き込み側が JS で trim して null にする) が、紙カルテ取り込みなど
  // 過去データを想定してタブ・改行、そして全角スペース (U+3000 = 12288) も落とす。日本語の
  // 手入力データで空白だけの行を作るならこれが一番出やすい。
  return db
    .prepare(
      `
      SELECT customer_visits.visited_at,
             customer_visits.treatment_notes,
             customer_visits.store_id,
             stores.name AS store_name
      FROM customer_visits
      LEFT JOIN stores ON stores.id = customer_visits.store_id
      WHERE customer_id = ?1
        AND status = 'valid'
        AND treatment_notes IS NOT NULL
        AND trim(treatment_notes, char(32, 9, 10, 13, 12288)) <> ''
        AND reservation_id IS NOT ?2
        AND CASE
              WHEN length(visited_at) = 10 THEN visited_at <= date(?3, '+9 hours')
              ELSE visited_at < ?3
            END
        ${storeId === null ? "" : "AND store_id = ?4"}
      ORDER BY ${VISITED_AT_JST_ORDER_KEY} DESC,
               customer_visits.created_at DESC,
               customer_visits.id DESC
      LIMIT 4
    `
    )
    .bind(
      ...(storeId === null
        ? [args.customerId, args.reservationId, args.startAt]
        : [args.customerId, args.reservationId, args.startAt, storeId])
    )
    .all<{ visited_at: string; treatment_notes: string; store_id: string; store_name: string }>();
};

export async function getAdminReservationDetail(input: {
  db: D1Database;
  reservationId: string;
  admin: AdminUser;
}): Promise<{ ok: true; reservation: AdminReservationDetail } | { ok: false; reason: "not_found" | "forbidden" }> {
  const isStaff = input.admin.role === "staff";
  const isSystemAdmin = input.admin.role === "system_admin";

  if (isStaff) {
    const scope = await checkStaffReservationScope(input.db, input.reservationId, input.admin);
    if (scope !== "ok") {
      return { ok: false, reason: scope };
    }
  }

  const row = await input.db
    .prepare(
      `
        ${reservationSelect}
        WHERE reservations.id = ?${isStaff ? " AND reservations.store_id = ?" : ""}
        LIMIT 1
      `
    )
    .bind(
      ...(isStaff ? [input.reservationId, input.admin.store_id] : [input.reservationId])
    )
    .first<ReservationRow>();

  if (!row) {
    // For staff this also covers the (rare) race where the reservation moved store
    // between the probe and this read — the re-applied store_id condition keeps the
    // gate fail-closed instead of trusting the earlier check (TOCTOU).
    return {
      ok: false,
      reason: "not_found"
    };
  }

  const [visits, auditRows, notificationRows, calendarSyncRows, dupConsentRows, serviceRows, customerNotes, pastNotes] =
    await Promise.all([
      input.db
        .prepare(
          `
          SELECT id, visited_at, visit_source, status, treatment_notes
          FROM customer_visits
          WHERE reservation_id = ?
          ORDER BY visited_at DESC
          LIMIT 20
        `
        )
        .bind(input.reservationId)
        .all<{ id: string; visited_at: string; visit_source: string; status: string; treatment_notes: string | null }>(),
      ownerOnlyRows(input.admin, () =>
        input.db
          .prepare(
            `
            SELECT id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at
            FROM audit_logs
            WHERE target_type = 'reservation' AND target_id = ?
            ORDER BY created_at DESC
            LIMIT 20
          `
          )
          .bind(input.reservationId)
          .all<AuditLogRow>()
      ),
      ownerOnlyRows(input.admin, () =>
        input.db
          .prepare(
            `
            SELECT id, template_key, recipient_type, status, attempts, last_error, created_at, updated_at
            FROM notification_jobs
            WHERE reservation_id = ?
            ORDER BY created_at DESC
            LIMIT 20
          `
          )
          .bind(input.reservationId)
          .all<NotificationJobRow>()
      ),
      ownerOnlyRows(input.admin, () =>
        input.db
          .prepare(
            `
            SELECT id, google_action, status, attempts, last_error, created_at, updated_at
            FROM calendar_sync_jobs
            WHERE owner_type = 'reservation' AND owner_id = ?
            ORDER BY created_at DESC
            LIMIT 20
          `
          )
          .bind(input.reservationId)
          .all<CalendarSyncJobRow>()
      ),
      // Duplicate-consent evidence is fetched by a DEDICATED action-filtered query (not the
      // generic LIMIT-20 audit list above) so it never falls out of view once a reservation
      // accumulates more than 20 newer audit rows (approvals, reschedules, Google sync…).
      ownerOnlyRows(input.admin, () =>
        input.db
          .prepare(
            `
            SELECT metadata_json
            FROM audit_logs
            WHERE target_type = 'reservation'
              AND target_id = ?
              AND action = '${DUPLICATE_CONSENT_ACTION}'
            ORDER BY created_at DESC
            LIMIT 1
          `
          )
          .bind(input.reservationId)
          .all<{ metadata_json: string | null }>()
      ),
      input.db
        .prepare(
          `
          SELECT service_id
          FROM reservation_services
          WHERE reservation_id = ?
          ORDER BY display_order
        `
        )
        .bind(input.reservationId)
        .all<{ service_id: string }>(),
      // Detail-only customer notes query. Deliberately separate from reservationSelect so
      // list/search/CSV/customer-history never pull memo / allergy_notes (PII + size).
      input.db
        .prepare(
          `
          SELECT memo, allergy_notes
          FROM customers
          WHERE id = ?
          LIMIT 1
        `
        )
        .bind(row.customer_id)
        .first<{ memo: string | null; allergy_notes: string | null }>(),
      selectCustomerPastNotes(input.db, {
        customerId: row.customer_id,
        reservationId: input.reservationId,
        startAt: row.start_at,
        admin: input.admin
      })
    ]);

  const pastNoteRows = pastNotes.results ?? [];

  const audit: AdminReservationDetailAuditEntry[] = (auditRows.results ?? []).map((entry) => ({
    id: entry.id,
    actorType: entry.actor_type,
    actorId: entry.actor_id,
    action: entry.action,
    targetType: entry.target_type,
    targetId: entry.target_id,
    createdAt: entry.created_at,
    metadataJson: isSystemAdmin ? entry.metadata_json : null
  }));

  const notifications: AdminReservationDetailNotificationEntry[] = (notificationRows.results ?? []).map(
    (entry) => {
      const mapped: AdminReservationDetailNotificationEntry = {
        id: entry.id,
        templateKey: entry.template_key,
        recipientType: entry.recipient_type,
        status: entry.status,
        attempts: entry.attempts,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at
      };
      if (isSystemAdmin) {
        mapped.lastError = entry.last_error;
      }
      return mapped;
    }
  );

  const calendarSync: AdminReservationDetailCalendarSyncEntry[] = (calendarSyncRows.results ?? []).map(
    (entry) => {
      const mapped: AdminReservationDetailCalendarSyncEntry = {
        id: entry.id,
        googleAction: entry.google_action,
        status: entry.status,
        attempts: entry.attempts,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at
      };
      if (isSystemAdmin) {
        mapped.lastError = entry.last_error;
      }
      return mapped;
    }
  );

  return {
    ok: true,
    reservation: {
      ...mapReservationRow(row),
      serviceIds:
        (serviceRows.results ?? []).length > 0
          ? (serviceRows.results ?? []).map((service) => service.service_id)
          : [row.service_id],
      customerDisplayNameKana: row.customer_display_name_kana,
      // Staff see only the last-4 masked phone (matches the CSV export + customer
      // list views); the raw phone_normalized is owner/system-admin only. A null
      // phone stays null (not "****") so the UI doesn't imply a hidden number exists.
      phoneNormalized: isStaff && row.phone_normalized ? maskPhoneTail(row.phone_normalized) : row.phone_normalized,
      googleSyncState: isStaff ? null : row.google_sync_state,
      googleEventId: isStaff ? null : row.google_event_id,
      version: row.version,
      customerMemo: emptyToNull(customerNotes?.memo),
      customerAllergyNotes: emptyToNull(customerNotes?.allergy_notes),
      customerPastNotes: pastNoteRows.slice(0, 3).map((note) => ({
        visitedAt: note.visited_at,
        treatmentNotes: note.treatment_notes,
        storeId: note.store_id,
        storeName: note.store_name
      })),
      customerPastNotesTruncated: pastNoteRows.length > 3,
      visits: (visits.results ?? []).map((visit) => ({
        id: visit.id,
        visitedAt: visit.visited_at,
        visitSource: visit.visit_source,
        status: visit.status,
        treatmentNotes: visit.treatment_notes
      })),
      audit,
      notifications,
      calendarSync,
      // Owner/system_admin only: staff get an empty dedicated result, so this is null for
      // them. The rows are already action-filtered, so tag them for parseDuplicateConsent.
      duplicateConsent: parseDuplicateConsent(
        (dupConsentRows.results ?? []).map((entry) => ({ action: DUPLICATE_CONSENT_ACTION, metadata_json: entry.metadata_json }))
      )
    }
  };
}

export async function getAdminCustomerDetail(input: {
  db: D1Database;
  customerId: string;
  admin: { role: string; store_id: string | null };
}): Promise<{ ok: true; customer: AdminCustomerDetail } | { ok: false; reason: "not_found" | "forbidden" }> {
  // Staff may only see a customer that is canonical (not a merge tombstone) and is
  // in their own-store scope. Gate BEFORE fetching any PII, and fail closed when the
  // staff has no store binding. Owner / system_admin bypass this (they see every
  // customer, incl. archived/merged, as before).
  //
  // Archived customers ARE visible to staff (includeArchived): staff can archive and
  // restore their own-store customers, and the restore button lives in this panel —
  // hiding the archived record here would make archive irreversible for them. Read
  // only: every write path (memo / profile / visit notes) still requires
  // archived_at IS NULL for every role.
  const isStaff = input.admin.role === "staff";
  if (isStaff) {
    if (
      !input.admin.store_id ||
      !(await staffCanAccessCustomer(input.db, input.customerId, input.admin.store_id, {
        includeArchived: true
      }))
    ) {
      return { ok: false, reason: "forbidden" };
    }
  }
  // For staff, scope the visit/reservation history to their own store so a
  // cross-store customer's other-store visits / reservations / treatment notes are
  // never returned. store_id is non-null here for staff (the gate above passed).
  const storeFilter = isStaff ? input.admin.store_id : null;
  const customerStoreCondition = storeFilter ? " AND store_id = ?" : "";
  const customerStoreParams = storeFilter ? [input.customerId, storeFilter] : [input.customerId];

  const customer = await input.db
    .prepare(
      `
        SELECT id, display_name, display_name_kana, phone_normalized, block_status,
               memo, referrer_name, birth_date, gender, allergy_notes, archived_at
        FROM customers
        WHERE id = ?${isStaff ? " AND merged_into_id IS NULL" : ""}
        LIMIT 1
      `
    )
    .bind(input.customerId)
    .first<CustomerRow>();

  if (!customer) {
    return {
      ok: false,
      reason: "not_found"
    };
  }

  const [
    lineIdentities,
    visits,
    validVisitCount,
    reservations,
    consents,
    duplicateConsentRows,
    lastVisit,
    nextReservation
  ] = await Promise.all([
    input.db
      .prepare(
        `
          -- Same recency rule as RESERVATION_LINE_FRIEND_STATUS_SUBQUERY (shared
          -- LINE_IDENTITY_RECENCY_ORDER_BY) so this customer panel and the
          -- reservation panel pick the SAME identity at index [0], including on
          -- equal updated_at ties. Aliased as li to reuse that ORDER BY.
          SELECT li.id, li.official_friend_status, li.followed_at, li.unfollowed_at, li.last_friend_checked_at
          FROM line_identities li
          WHERE li.customer_id = ?
          ${LINE_IDENTITY_RECENCY_ORDER_BY}
          LIMIT 20
        `
      )
      .bind(input.customerId)
      .all<{
        id: string;
        official_friend_status: string;
        followed_at: string | null;
        unfollowed_at: string | null;
        last_friend_checked_at: string | null;
      }>(),
    selectCustomerVisitsPage(input.db, input.customerId, storeFilter, 0),
    // The visits array above is capped at 50 ROWS, and voided rows occupy slots
    // because the panel greys them out instead of hiding them. Counting valid
    // rows inside that page would under-report a customer with more than 50
    // visits, so the heading gets its own uncapped count. Same store filter as
    // the page query: a staff member must not learn about other stores' visits.
    input.db
      .prepare(
        `
          SELECT COUNT(*) AS n
          FROM customer_visits
          WHERE customer_id = ? AND status = 'valid'${customerStoreCondition}
        `
      )
      .bind(...customerStoreParams)
      .first<{ n: number }>(),
    selectCustomerReservationsPage(input.db, input.customerId, storeFilter, 0),
    selectCustomerConsentsPage(input.db, input.customerId, storeFilter, 0),
    // Duplicate-consent history — owner/system_admin only (audit is hidden from staff).
    // Joined through reservations so it is scoped to THIS customer by customer_id.
    ownerOnlyRows(input.admin, () =>
      input.db
        .prepare(
          `
            SELECT audit_logs.target_id AS reservation_id,
                   audit_logs.metadata_json AS metadata_json
            FROM audit_logs
            JOIN reservations ON reservations.id = audit_logs.target_id
            WHERE audit_logs.action = '${DUPLICATE_CONSENT_ACTION}'
              AND audit_logs.target_type = 'reservation'
              AND reservations.customer_id = ?
            ORDER BY audit_logs.created_at DESC
            LIMIT 50
          `
        )
        .bind(input.customerId)
        .all<DuplicateConsentHistoryRow>()
    ),
    input.db.prepare(`SELECT visited_at FROM customer_visits
      WHERE customer_id = ? AND status = 'valid'${customerStoreCondition}
      ORDER BY ${VISITED_AT_JST_ORDER_KEY} DESC, customer_visits.created_at DESC, customer_visits.id DESC LIMIT 1`)
      .bind(...customerStoreParams)
      .first<{ visited_at: string }>(),
    input.db.prepare(`${reservationSelect}
      WHERE reservations.customer_id = ? AND reservations.status IN ('pending_approval', 'confirmed')
        AND julianday(reservations.start_at) >= julianday(?)${storeFilter ? " AND reservations.store_id = ?" : ""}
      ORDER BY reservations.start_at ASC, reservations.id ASC LIMIT 1`)
      .bind(...(storeFilter ? [input.customerId, new Date().toISOString(), storeFilter] : [input.customerId, new Date().toISOString()]))
      .first<ReservationRow>()
  ]);

  return {
    ok: true,
    customer: {
      id: customer.id,
      displayName: customer.display_name,
      displayNameKana: customer.display_name_kana,
      // Staff see only the last-4 masked phone (matches the customer list +
      // reservation detail); the raw phone_normalized is owner/system-admin only. A
      // null phone stays null (not "****") so the UI doesn't imply a hidden number.
      phoneNormalized: isStaff && customer.phone_normalized ? maskPhoneTail(customer.phone_normalized) : customer.phone_normalized,
      blockStatus: customer.block_status,
      memo: customer.memo,
      referrerName: customer.referrer_name,
      birthDate: customer.birth_date,
      gender: customer.gender,
      allergyNotes: customer.allergy_notes,
      archivedAt: customer.archived_at,
      lineIdentities: (lineIdentities.results ?? []).map((identity) => ({
        id: identity.id,
        officialFriendStatus: identity.official_friend_status,
        followedAt: identity.followed_at,
        unfollowedAt: identity.unfollowed_at,
        lastFriendCheckedAt: identity.last_friend_checked_at
      })),
      validVisitCount: validVisitCount?.n ?? 0,
      lastVisitAt: lastVisit?.visited_at ?? null,
      nextReservation: nextReservation ? mapReservationRow(nextReservation) : null,
      visits: (visits.results ?? []).map(mapVisitRow),
      reservations: (reservations.results ?? []).map(mapReservationRow),
      reservationsNextOffset: (reservations.results ?? []).length === CUSTOMER_RESERVATIONS_PAGE_SIZE ? CUSTOMER_RESERVATIONS_PAGE_SIZE : null,
      consentHistory: (consents.results ?? []).map(mapConsentRow),
      consentHistoryNextOffset:
        (consents.results ?? []).length === CUSTOMER_CONSENTS_PAGE_SIZE
          ? CUSTOMER_CONSENTS_PAGE_SIZE
          : null,
      duplicateConsentHistory: (duplicateConsentRows.results ?? []).flatMap((auditRow) => {
        const parsed = parseDuplicateConsent([
          { action: DUPLICATE_CONSENT_ACTION, metadata_json: auditRow.metadata_json }
        ]);
        if (!parsed) return [];
        return [
          {
            reservationId: auditRow.reservation_id,
            consentedAt: parsed.consentedAt,
            stage: parsed.stage,
            warningVersion: parsed.warningVersion,
            existingCount: parsed.existingReservations.length
          }
        ];
      })
    }
  };
}

export async function listAdminExternalBlocks(input: {
  db: D1Database;
  admin: AdminUser;
}) {
  if (input.admin.role === "staff" && !input.admin.store_id) {
    return { ok: true as const, externalBlocks: [] as AdminExternalBlockListItem[] };
  }

  const storeFilter = input.admin.role === "staff" ? input.admin.store_id : null;
  const whereClause = storeFilter ? "WHERE external_blocks.store_id = ?" : "";

  const stmt = input.db.prepare(
    `
      SELECT
        external_blocks.id,
        external_blocks.store_id,
        stores.name AS store_name,
        external_blocks.resource_id,
        store_resources.name AS resource_name,
        external_blocks.source,
        external_blocks.title_snapshot,
        external_blocks.start_at,
        external_blocks.end_at,
        external_blocks.status,
        external_blocks.google_event_id,
        external_blocks.created_by,
        external_blocks.updated_at
      FROM external_blocks
      JOIN stores ON stores.id = external_blocks.store_id
      JOIN store_resources ON store_resources.id = external_blocks.resource_id
      ${whereClause}
      ORDER BY external_blocks.start_at DESC
      LIMIT 200
    `
  );

  const result = await (storeFilter ? stmt.bind(storeFilter) : stmt).all<{
      id: string;
      store_id: string;
      store_name: string;
      resource_id: string;
      resource_name: string;
      source: string;
      title_snapshot: string | null;
      start_at: string;
      end_at: string;
      status: string;
      google_event_id: string | null;
      created_by: string | null;
      updated_at: string;
    }>();

  return {
    ok: true as const,
    externalBlocks: (result.results ?? []).map((block): AdminExternalBlockListItem => ({
      id: block.id,
      storeId: block.store_id,
      storeName: block.store_name,
      resourceId: block.resource_id,
      resourceName: block.resource_name,
      source: block.source,
      titleSnapshot: block.title_snapshot,
      startAt: block.start_at,
      endAt: block.end_at,
      status: block.status,
      googleEventId: block.google_event_id,
      createdBy: block.created_by,
      updatedAt: block.updated_at
    }))
  };
}

export async function getAdminSettingsSnapshot(input: {
  db: D1Database;
  storeId?: string | null;
}): Promise<{
  ok: true;
  settings: AdminSettingsSnapshot;
  allStores: AdminSettingsSnapshot["stores"];
}> {
  // issue #536: LIMIT after store scope (global LIMIT then filter drops a store's rows).
  const filterStoreId = input.storeId ?? null;
  const closuresQuery = filterStoreId
    ? input.db
        .prepare(
          `
            SELECT id, store_id, starts_at, ends_at, reason, source
            FROM store_closures
            WHERE store_id = ?
            ORDER BY starts_at DESC
            LIMIT 200
          `
        )
        .bind(filterStoreId)
        .all<{
          id: string;
          store_id: string;
          starts_at: string;
          ends_at: string;
          reason: string | null;
          source: string;
        }>()
    : input.db
        .prepare(
          `
            SELECT id, store_id, starts_at, ends_at, reason, source
            FROM (
              SELECT
                id,
                store_id,
                starts_at,
                ends_at,
                reason,
                source,
                ROW_NUMBER() OVER (
                  PARTITION BY store_id
                  ORDER BY starts_at DESC
                ) AS rn
              FROM store_closures
            )
            WHERE rn <= 200
            ORDER BY starts_at DESC
          `
        )
        .all<{
          id: string;
          store_id: string;
          starts_at: string;
          ends_at: string;
          reason: string | null;
          source: string;
        }>();

  const [stores, resources, services, businessHours, reminderOffsets, closures, staff] = await Promise.all([
    input.db
      .prepare(
        `
          SELECT
            stores.id,
            stores.name,
            stores.timezone,
            stores.google_calendar_id,
            store_settings.google_controlled_edit_mode,
            store_settings.max_active_reservations_per_customer,
            store_settings.booking_window_days,
            store_settings.customer_notice
          FROM stores
          LEFT JOIN store_settings ON store_settings.store_id = stores.id
          ORDER BY stores.name ASC
        `
      )
      .all<{
        id: string;
        name: string;
        timezone: string;
        google_calendar_id: string | null;
        google_controlled_edit_mode: number | null;
        max_active_reservations_per_customer: number | null;
        booking_window_days: number | null;
        customer_notice: string | null;
      }>(),
    input.db
      .prepare(
        `
          SELECT id, store_id, name, resource_type, active
          FROM store_resources
          ORDER BY store_id ASC, name ASC
        `
      )
      .all<{ id: string; store_id: string; name: string; resource_type: string; active: number }>(),
    input.db
      .prepare(
        `
          SELECT id, store_id, name, price_label, price_amount, combo_price_amount, combo_with_prefix,
                 duration_minutes, active, mens_menu
          FROM services
          ORDER BY store_id ASC, name ASC
        `
      )
      .all<{ id: string; store_id: string; name: string; price_label: string | null; price_amount: number | null; combo_price_amount: number | null; combo_with_prefix: string | null; duration_minutes: number; active: number; mens_menu: number }>(),
    input.db
      .prepare(
        `
          SELECT id, store_id, weekday, opens_at, closes_at, active
          FROM store_business_hours
          ORDER BY store_id ASC, weekday ASC, opens_at ASC
        `
      )
      .all<{ id: string; store_id: string; weekday: number; opens_at: string; closes_at: string; active: number }>(),
    input.db
      .prepare(
        `
          SELECT store_id, reservation_reminder_offset_minutes
          FROM store_settings
          ORDER BY store_id ASC
        `
      )
      .all<{ store_id: string; reservation_reminder_offset_minutes: number | null }>(),
    closuresQuery,
    input.db
      .prepare(
        `
          SELECT id, store_id, display_name, role, active, version
          FROM staff_members
          -- Exclude the store-login sentinel rows (staff_login_<store>): they are
          -- not real employees and must not appear in / be editable from the
          -- Staff management UI. Managed only via the /store-logins endpoints
          -- (codex PR #308 review, Fix C). GLOB is case-sensitive and needs no
          -- LIKE escaping for the literal underscores.
          WHERE id NOT GLOB 'staff_login_*'
          ORDER BY store_id ASC, display_name ASC
        `
      )
      .all<{
        id: string;
        store_id: string;
        display_name: string;
        role: string;
        active: number;
        version: number;
      }>()
  ]);

  const allStores = (stores.results ?? []).map((store) => ({
    id: store.id,
    name: store.name,
    timezone: store.timezone,
    googleCalendarId: store.google_calendar_id,
    googleControlledEditMode: store.google_controlled_edit_mode === 1,
    maxActiveReservationsPerCustomer: store.max_active_reservations_per_customer ?? 1,
    bookingWindowDays: store.booking_window_days ?? 30,
    customerNotice: store.customer_notice ?? null
  }));

  const matchesStore = (sid: string): boolean => !filterStoreId || sid === filterStoreId;

  return {
    ok: true,
    settings: {
      stores: filterStoreId ? allStores.filter((s) => matchesStore(s.id)) : allStores,
      resources: (resources.results ?? []).map((resource) => ({
        id: resource.id,
        storeId: resource.store_id,
        name: resource.name,
        resourceType: resource.resource_type,
        active: resource.active === 1
      })).filter((r) => matchesStore(r.storeId)),
      services: (services.results ?? []).map((service) => ({
        id: service.id,
        storeId: service.store_id,
        name: service.name,
        priceLabel: service.price_label,
        priceAmount: service.price_amount,
        comboPriceAmount: service.combo_price_amount,
        comboWithPrefix: service.combo_with_prefix,
        durationMinutes: service.duration_minutes,
        active: service.active === 1,
        mensMenu: service.mens_menu === 1
      })).filter((s) => matchesStore(s.storeId)),
      businessHours: (businessHours.results ?? []).map((hour) => ({
        id: hour.id,
        storeId: hour.store_id,
        weekday: hour.weekday,
        opensAt: hour.opens_at,
        closesAt: hour.closes_at,
        active: hour.active === 1
      })).filter((h) => matchesStore(h.storeId)),
      reminderOffsets: (reminderOffsets.results ?? []).map((row) => ({
        storeId: row.store_id,
        offsetMinutes: row.reservation_reminder_offset_minutes
      })).filter((r) => matchesStore(r.storeId)),
      closures: (closures.results ?? []).map((closure) => ({
        id: closure.id,
        storeId: closure.store_id,
        startsAt: closure.starts_at,
        endsAt: closure.ends_at,
        reason: closure.reason,
        source: closure.source
      })).filter((c) => matchesStore(c.storeId)),
      staff: (staff.results ?? []).map((member) => ({
        id: member.id,
        storeId: member.store_id,
        displayName: member.display_name,
        role: member.role,
        active: member.active === 1,
        version: member.version
      })).filter((m) => matchesStore(m.storeId))
    },
    allStores
  };
}

export const ADMIN_AUDIT_ACTOR_TYPES = ["customer", "staff", "system", "google_calendar"] as const;
export type AdminAuditActorType = (typeof ADMIN_AUDIT_ACTOR_TYPES)[number];

export type AdminAuditFilter = {
  // ISO-8601 instant strings. createdAtFrom is inclusive (>=) and
  // createdAtToExclusive is exclusive (<). Callers convert calendar dates to
  // these instants on their end so this layer stays time-zone agnostic.
  createdAtFrom?: string;
  createdAtToExclusive?: string;
  actorType?: AdminAuditActorType;
  // Free-text keyword. Matched as a case-insensitive LIKE substring on action,
  // target_type, target_id, and (when the caller has visibility) metadata_json.
  // SQL LIKE meta characters (%, _) and the escape character (\) are escaped
  // so user input is treated as a literal substring.
  keyword?: string;
  // Caps the page size returned. Defaults to 200 to match the existing today
  // tab behaviour; the audit tab can request smaller pages.
  limit?: number;
};

export async function listAdminAuditLogs(input: {
  db: D1Database;
  admin: AdminUser;
  filter?: AdminAuditFilter;
}): Promise<{ ok: true; auditLogs: AdminAuditLogItem[] } | { ok: false; reason: "forbidden" }> {
  if (input.admin.role === "staff") {
    return {
      ok: false,
      reason: "forbidden"
    };
  }

  const filter = input.filter ?? {};
  const isSystemAdmin = input.admin.role === "system_admin";
  const conditions: string[] = [];
  const binds: Array<string | number> = [];

  // Normalize both sides with datetime() so the cutoff compare works across
  // the codebase's two coexisting created_at formats: SQLite CURRENT_TIMESTAMP
  // ('YYYY-MM-DD HH:MM:SS') from production INSERTs, and ISO with T+Z
  // ('YYYY-MM-DDTHH:MM:SS.000Z') from tests + some newer writers. A raw
  // string compare would mis-order them because 'T' (0x54) > ' ' (0x20).
  if (filter.createdAtFrom) {
    conditions.push("datetime(created_at) >= datetime(?)");
    binds.push(filter.createdAtFrom);
  }
  if (filter.createdAtToExclusive) {
    conditions.push("datetime(created_at) < datetime(?)");
    binds.push(filter.createdAtToExclusive);
  }
  if (filter.actorType) {
    conditions.push("actor_type = ?");
    binds.push(filter.actorType);
  }
  if (filter.keyword) {
    const like = `%${escapeLikePattern(filter.keyword)}%`;
    // Store admins cannot see metadata_json (redacted to null below), so the
    // search must not match against a column they can't read — otherwise a
    // keyword could leak whether metadata contained that text.
    const keywordClause = isSystemAdmin
      ? String.raw`(action LIKE ? ESCAPE '\' OR target_type LIKE ? ESCAPE '\' OR target_id LIKE ? ESCAPE '\' OR (metadata_json IS NOT NULL AND metadata_json LIKE ? ESCAPE '\'))`
      : String.raw`(action LIKE ? ESCAPE '\' OR target_type LIKE ? ESCAPE '\' OR target_id LIKE ? ESCAPE '\')`;
    conditions.push(keywordClause);
    binds.push(like, like, like);
    if (isSystemAdmin) {
      binds.push(like);
    }
  }

  const requestedLimit = Number.isFinite(filter.limit) ? Math.floor(filter.limit as number) : 200;
  // Hard cap to prevent caller-driven memory blow-ups; matches the historic
  // 200-row implicit ceiling.
  const limit = Math.max(1, Math.min(200, requestedLimit));
  binds.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
        SELECT id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at
        FROM audit_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ?
      `;

  const result = await input.db
    .prepare(sql)
    .bind(...binds)
    .all<{
      id: string;
      actor_type: string;
      actor_id: string | null;
      action: string;
      target_type: string;
      target_id: string;
      metadata_json: string | null;
      created_at: string;
    }>();

  return {
    ok: true,
    auditLogs: (result.results ?? []).map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadataJson: isSystemAdmin ? row.metadata_json : null,
      rejectionReason: extractRejectionReason(row),
      createdAt: row.created_at
    }))
  };
}

/**
 * 予約却下行に限り metadata_json から却下理由を抽出する。raw metadata の開示範囲
 * (system_admin のみ) は変えず、理由だけを owner にも見せるための projection。
 * fail-soft: 壊れた legacy metadata (不正 JSON / 非文字列 / 500字超) は null に落とし、
 * 1行の不整合で活動ログ全体を 500 にしない。
 */
function extractRejectionReason(row: {
  action: string;
  target_type: string;
  metadata_json: string | null;
}): string | null {
  if (row.action !== "admin_reservation_reject" || row.target_type !== "reservation") {
    return null;
  }
  if (row.metadata_json === null) {
    return null;
  }
  try {
    const metadata: unknown = JSON.parse(row.metadata_json);
    if (metadata === null || typeof metadata !== "object") {
      return null;
    }
    const reason = (metadata as Record<string, unknown>).reason;
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 500) {
      return null;
    }
    return reason;
  } catch {
    return null;
  }
}

export type AvailableSlot = {
  resourceId: string;
  resourceName: string;
  startAt: string;
  available: boolean;
};

// Slot grid stepping (minutes) and the lock granularity each booking occupies.
const SLOT_STEP_MINUTES = 15;
const LOCK_GRANULARITY_MINUTES = 5;
const DEFAULT_SLOT_DURATION_MINUTES = 15;
const LOCK_GRANULARITY_MS = LOCK_GRANULARITY_MINUTES * 60_000;

const parseMinutesOfDay = (hm: string): number => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

type BusinessHourRange = {
  opensAt: number;
  closesAt: number;
};

const normalizeBusinessHours = (
  hours: Array<{ opens_at: string; closes_at: string }>
): BusinessHourRange[] =>
  hours
    .map((hours) => ({
      opensAt: parseMinutesOfDay(hours.opens_at),
      closesAt: parseMinutesOfDay(hours.closes_at),
    }))
    .filter(
      (hours) =>
        Number.isFinite(hours.opensAt) &&
        Number.isFinite(hours.closesAt) &&
        hours.opensAt < hours.closesAt
    )
    .sort((a, b) => a.opensAt - b.opensAt);

/** True when any 5-minute step a booking would occupy is already locked. */
const isBookingWindowLocked = (
  lockedSet: Set<string>,
  resourceId: string,
  slotStartMs: number,
  slotsPerBooking: number
): boolean => {
  for (let offset = 0; offset < slotsPerBooking; offset++) {
    const checkTime = new Date(slotStartMs + offset * LOCK_GRANULARITY_MS).toISOString();
    if (lockedSet.has(`${resourceId}:${checkTime}`)) return true;
  }
  return false;
};

/** True when an active external block overlaps the half-open [startIso, endIso). */
const isSlotBlocked = (
  blocks: { resource_id: string; start_at: string; end_at: string }[],
  resourceId: string,
  startIso: string,
  endIso: string
): boolean =>
  blocks.some(
    (block) =>
      block.resource_id === resourceId && block.start_at < endIso && block.end_at > startIso
  );

/** True when any 5-minute step a booking would occupy collides with the
 * customer's own bookings elsewhere (customer_time_locks is resource/store
 * agnostic, so the busy set applies to every resource column equally). */
const isCustomerWindowBusy = (
  customerBusySet: Set<string>,
  slotStartMs: number,
  slotsPerBooking: number
): boolean => {
  if (customerBusySet.size === 0) return false;
  for (let offset = 0; offset < slotsPerBooking; offset++) {
    const checkTime = new Date(slotStartMs + offset * LOCK_GRANULARITY_MS).toISOString();
    if (customerBusySet.has(checkTime)) return true;
  }
  return false;
};

// Shared exclusion clause for both lock tables: drop the target reservation's
// own lock rows so a reschedule picker can offer times overlapping the current
// span (the write path deletes + re-inserts those locks in one batch). Scoped
// to owner_type = 'reservation' so an external_block / admin_hold that happens
// to share the id is never unmasked. Display-only precision: create/reschedule
// remain the enforcement point.
const EXCLUDE_OWN_RESERVATION_SQL = " AND NOT (owner_type = 'reservation' AND owner_id = ?)";

/** slot_locks busy rows for the day, minus the excluded reservation's own rows. */
const querySlotLocks = (
  db: D1Database,
  storeId: string,
  range: { startAt: string; endAt: string },
  excludeReservationId?: string
) => {
  const base =
    "SELECT resource_id, slot_at FROM slot_locks WHERE store_id = ? AND slot_at >= ? AND slot_at < ?";
  if (excludeReservationId) {
    return db
      .prepare(base + EXCLUDE_OWN_RESERVATION_SQL)
      .bind(storeId, range.startAt, range.endAt, excludeReservationId)
      .all<{ resource_id: string; slot_at: string }>();
  }
  return db
    .prepare(base)
    .bind(storeId, range.startAt, range.endAt)
    .all<{ resource_id: string; slot_at: string }>();
};

/** customer_time_locks busy rows for the day; immediate empty set without a customerId. */
const queryCustomerTimeLocks = (
  db: D1Database,
  range: { startAt: string; endAt: string },
  customerId?: string,
  excludeReservationId?: string
): Promise<{ results?: { slot_at: string }[] }> => {
  if (!customerId) {
    return Promise.resolve({ results: [] });
  }
  const base =
    "SELECT slot_at FROM customer_time_locks WHERE customer_id = ? AND slot_at >= ? AND slot_at < ?";
  if (excludeReservationId) {
    return db
      .prepare(base + EXCLUDE_OWN_RESERVATION_SQL)
      .bind(customerId, range.startAt, range.endAt, excludeReservationId)
      .all<{ slot_at: string }>();
  }
  return db.prepare(base).bind(customerId, range.startAt, range.endAt).all<{ slot_at: string }>();
};

export async function getAvailableSlots(input: {
  db: D1Database;
  storeId: string;
  date: string;
  durationMinutes?: number;
  resourceId?: string;
  excludeReservationId?: string;
  customerId?: string;
}): Promise<{ ok: true; slots: AvailableSlot[] } | { ok: false; reason: string }> {
  const range = jstDayRangeFromKey(input.date);
  if (!range) return { ok: false, reason: "invalid_date" };

  const [y, m, d] = input.date.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  // NOTE: expired pending locks stay busy here on purpose. The public picker
  // filters them out because public-submit deletes expired rows before its
  // INSERT; the admin create/reschedule batches do NOT, so offering those
  // slots would fail on the UNIQUE constraint at submit time.
  // NOTE: customer conflicts are matched by customer_id only. Cross-customer
  // collisions via a shared phone_hash are left to the write side's
  // (phone_hash, slot_at) UNIQUE — rare merged/paper-chart edge, fail-closed
  // at submit, deliberately out of this display-precision pass.
  //
  // Reschedule mode (excludeReservationId) derives its resource from the
  // reservation row, and rescheduleAdminReservation moves that reservation
  // regardless of the resource's active flag. Filtering active would blank the
  // picker for a reservation sitting on a now-inactive resource, desyncing read
  // from write. Only create mode — which opens NEW bookings — restricts to
  // active resources.
  const activeResourceClause = input.excludeReservationId ? "" : " AND active = 1";
  const [hoursResult, resourcesResult, locksResult, blocksResult, customerLocksResult] =
    await Promise.all([
      input.db
        .prepare(
          "SELECT opens_at, closes_at, active FROM store_business_hours WHERE store_id = ? AND weekday = ? ORDER BY opens_at ASC"
        )
        .bind(input.storeId, dayOfWeek)
        .all<{ opens_at: string; closes_at: string; active: number }>(),
      input.db
        .prepare(
          input.resourceId
            ? `SELECT id, name FROM store_resources WHERE store_id = ? AND id = ?${activeResourceClause}`
            : `SELECT id, name FROM store_resources WHERE store_id = ? AND active = 1`
        )
        .bind(...(input.resourceId ? [input.storeId, input.resourceId] : [input.storeId]))
        .all<{ id: string; name: string }>(),
      querySlotLocks(input.db, input.storeId, range, input.excludeReservationId),
      input.db
        .prepare(
          "SELECT resource_id, start_at, end_at FROM external_blocks WHERE store_id = ? AND status = 'active' AND start_at < ? AND end_at > ?"
        )
        .bind(input.storeId, range.endAt, range.startAt)
        .all<{ resource_id: string; start_at: string; end_at: string }>(),
      queryCustomerTimeLocks(input.db, range, input.customerId, input.excludeReservationId),
    ]);

  const activeHours = normalizeBusinessHours(
    (hoursResult.results ?? []).filter((hours) => hours.active)
  );
  if (activeHours.length === 0) return { ok: true, slots: [] };

  const lockedSet = new Set(
    (locksResult.results ?? []).map((l) => `${l.resource_id}:${l.slot_at}`)
  );
  const customerBusySet = new Set(
    (customerLocksResult.results ?? []).map((l) => l.slot_at)
  );
  const blocks = blocksResult.results ?? [];
  const resources = resourcesResult.results ?? [];
  // Callers pass the raw treatment time; the buffer is added here so this layout agrees
  // with what createAdminReservation will actually accept and lock. Without it the last
  // slot of every day is offered but rejected as outside_business_hours, and the lock
  // check misses the booking's final buffer slot.
  const duration =
    (input.durationMinutes ?? DEFAULT_SLOT_DURATION_MINUTES) + RESERVATION_INTERVAL_MINUTES;
  const slotsPerBooking = Math.max(1, Math.ceil(duration / LOCK_GRANULARITY_MINUTES));
  const dayStartMs = new Date(range.startAt).getTime();

  const slots = new Map<string, AvailableSlot>();
  for (const resource of resources) {
    for (const hours of activeHours) {
      for (let minute = hours.opensAt; minute + duration <= hours.closesAt; minute += SLOT_STEP_MINUTES) {
        const slotStartMs = dayStartMs + minute * 60_000;
        const startIso = new Date(slotStartMs).toISOString();
        const endIso = new Date(slotStartMs + duration * 60_000).toISOString();
        const available =
          !isBookingWindowLocked(lockedSet, resource.id, slotStartMs, slotsPerBooking) &&
          !isSlotBlocked(blocks, resource.id, startIso, endIso) &&
          !isCustomerWindowBusy(customerBusySet, slotStartMs, slotsPerBooking);
        slots.set(`${resource.id}:${startIso}`, {
          resourceId: resource.id,
          resourceName: resource.name,
          startAt: startIso,
          available,
        });
      }
    }
  }

  return {
    ok: true,
    slots: [...slots.values()].sort((a, b) => a.startAt.localeCompare(b.startAt))
  };
}

// Shared gate for paged histories; each row query retains its own store filter.
const resolveCustomerHistoryAccess = async (input: {
  db: D1Database;
  customerId: string;
  admin: { role: string; store_id: string | null };
}) => {
  const isStaff = input.admin.role === "staff";
  if (isStaff) {
    if (
      !input.admin.store_id ||
      !(await staffCanAccessCustomer(input.db, input.customerId, input.admin.store_id, {
        includeArchived: true
      }))
    ) {
      return { ok: false, reason: "forbidden" } as const;
    }
  }
  const storeFilter = isStaff ? input.admin.store_id : null;

  // 顧客が居ないことと「その顧客に来店が無い」ことは区別する。詳細と同じく、staff から
  // 見た統合済みの行 (merged_into_id) は存在しない扱い。
  const customer = await input.db
    .prepare(
      `SELECT id FROM customers WHERE id = ?${isStaff ? " AND merged_into_id IS NULL" : ""} LIMIT 1`
    )
    .bind(input.customerId)
    .first<{ id: string }>();
  if (!customer) {
    return { ok: false, reason: "not_found" } as const;
  }

  return { ok: true, storeFilter } as const;
};

type CustomerHistoryFailure = {
  ok: false;
  reason: "not_found" | "forbidden" | "invalid_request";
};

/**
 * 来店履歴の続き (2 ページ目以降)。顧客詳細は先頭 50 件しか返さないので、それより
 * 古い施術メモを読むための経路。予約詳細パネルの「これより前のぶんは顧客タブの
 * 来店履歴でご確認いただけます」という案内の行き先がここになる (issue #650)。
 *
 * 認可は顧客詳細とまったく同じ条件を通す。staff は自店舗の来店しか読めない。
 */
export async function listAdminCustomerVisits(input: {
  db: D1Database;
  customerId: string;
  offset: number;
  admin: { role: string; store_id: string | null };
}): Promise<
  | { ok: true; visits: AdminCustomerDetail["visits"]; nextOffset: number | null }
  | CustomerHistoryFailure
> {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    return { ok: false, reason: "invalid_request" };
  }

  const access = await resolveCustomerHistoryAccess(input);
  if (!access.ok) return access;

  const page = await selectCustomerVisitsPage(input.db, input.customerId, access.storeFilter, input.offset);
  const rows = page.results ?? [];
  return {
    ok: true,
    visits: rows.map(mapVisitRow),
    // 端数のページが返ったらそこで終わり。ちょうど 50 件だった場合だけ、次を引く
    // 余地が残る (次が空になることはある)。
    nextOffset: rows.length === CUSTOMER_VISITS_PAGE_SIZE ? input.offset + rows.length : null
  };
}

export async function listAdminCustomerReservations(input: {
  db: D1Database;
  customerId: string;
  offset: number;
  admin: { role: string; store_id: string | null };
}): Promise<
  | { ok: true; reservations: AdminReservationListItem[]; nextOffset: number | null }
  | CustomerHistoryFailure
> {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) return { ok: false, reason: "invalid_request" };
  const access = await resolveCustomerHistoryAccess(input);
  if (!access.ok) return access;
  const page = await selectCustomerReservationsPage(input.db, input.customerId, access.storeFilter, input.offset);
  const rows = page.results ?? [];
  return { ok: true, reservations: rows.map(mapReservationRow), nextOffset: rows.length === CUSTOMER_RESERVATIONS_PAGE_SIZE ? input.offset + rows.length : null };
}

export async function listAdminCustomerConsents(input: {
  db: D1Database;
  customerId: string;
  offset: number;
  admin: { role: string; store_id: string | null };
}): Promise<
  | { ok: true; consents: AdminCustomerDetail["consentHistory"]; nextOffset: number | null }
  | CustomerHistoryFailure
> {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
    return { ok: false, reason: "invalid_request" };
  }

  const access = await resolveCustomerHistoryAccess(input);
  if (!access.ok) return access;

  const page = await selectCustomerConsentsPage(
    input.db,
    input.customerId,
    access.storeFilter,
    input.offset
  );
  const rows = page.results ?? [];
  return {
    ok: true,
    consents: rows.map(mapConsentRow),
    nextOffset: rows.length === CUSTOMER_CONSENTS_PAGE_SIZE ? input.offset + rows.length : null
  };
}
