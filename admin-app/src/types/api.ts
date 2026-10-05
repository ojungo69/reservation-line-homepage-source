export type Reservation = {
  id: string;
  status: string;
  source: string;
  createdAt?: string | null;
  reservationOrigin?: string | null;
  storeId: string;
  storeName: string;
  serviceId: string;
  serviceName: string;
  serviceNameSource?: "snapshot" | "current" | "unrecorded";
  resourceId: string;
  resourceName: string;
  startAt: string;
  endAt: string;
  customerId: string;
  customerDisplayName: string;
  lineFriendStatus: string | null;
  cancellationFeeUnpaidAt: string | null;
};

export type ReservationDetail = Reservation & {
  // 全メニュー ID（reservation_services の display_order 順。junction 行が無い
  // 旧予約は [serviceId] にフォールバックした値が返る）。rollback 中の旧 backend
  // 応答には存在しないため optional — 利用側は [serviceId] への fallback 必須。
  serviceIds?: string[];
  customerDisplayNameKana: string | null;
  phoneNormalized: string | null;
  googleSyncState: string | null;
  googleEventId: string | null;
  version: number;
  reservationOrigin: string | null;
  // 顧客単位メモ（customers.memo / allergy_notes）。詳細 API 専用 — 一覧・検索・
  // CSV には含まれない。編集は顧客タブの既存導線（ここでは表示のみ）。
  customerMemo: string | null;
  customerAllergyNotes: string | null;
  // 同じ顧客の直近の施術メモ（最大3件・新しい順）。visits はこの予約の来店行だけなので、
  // 未完了の予約を開いたときに過去のカルテを読めるのはこの配列だけ。
  // 省略可なのは上の serviceIds と同じ理由 — 新しい SPA が古い worker の応答を受け取る
  // 移行中はこの項目が無い。描画側の `?.` を「不要な防御」と読ませないため型でも示す。
  // storeId / storeName は他店舗のカルテを見分けるため（owner 以上はこの一覧に全店舗ぶんが
  // 並ぶ）。staff は自店舗ぶんしか返ってこないので常に予約の店舗と一致する。
  customerPastNotes?: Array<{
    visitedAt: string;
    treatmentNotes: string;
    storeId?: string | null;
    storeName?: string | null;
  }>;
  // 上の3件より前にもメモがあるか。件数からは判定できない（ちょうど3件しかない顧客と
  // 打ち切られた顧客が同じ 3 になる）ので、worker 側が4件目の有無で決めた結果を受け取る。
  customerPastNotesTruncated?: boolean;
  visits: Array<{
    id: string;
    visitedAt: string;
    visitSource: string;
    status: string;
    treatmentNotes: string | null;
  }>;
  audit: Array<{
    id: string;
    action: string;
    actorType: string;
    actorId: string;
    actorName: string | null;
    createdAt: string;
  }>;
  notifications: Array<{
    id: string;
    channel: string;
    status: string;
    createdAt: string;
  }>;
  calendarSync: Array<{
    id: string;
    googleAction: string;
    status: string;
    createdAt: string;
  }>;
  // Owner/system_admin only: present when the customer acknowledged the
  // duplicate-reservation warning at booking time. null when no warning was required.
  duplicateConsent: {
    stage: "hard" | "soft";
    warningVersion: string;
    consentedAt: string;
    existingReservations: Array<{ reservationId: string; storeId: string; startAt: string }>;
  } | null;
};

export type ExternalBlock = {
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

export type Resource = {
  id: string;
  storeId: string;
  name: string;
  resourceType: string;
  active: boolean;
};

export type Service = {
  id: string;
  storeId: string;
  name: string;
  durationMinutes: number;
  priceLabel: string | null;
  priceAmount: number | null;
  comboPriceAmount: number | null;
  comboWithPrefix: string | null;
  active: boolean;
  /** メンズ向けメニュー。京都店では顧客向けの予約枠が曜日・時間帯で絞られる。 */
  mensMenu: boolean;
};

export type Store = {
  id: string;
  name: string;
  timezone: string;
  googleCalendarId: string | null;
  googleControlledEditMode: boolean;
  maxActiveReservationsPerCustomer: number;
  bookingWindowDays: number;
  customerNotice: string | null;
};

export type BusinessHour = {
  id: string;
  storeId: string;
  weekday: number;
  opensAt: string;
  closesAt: string;
  active: boolean;
};

export type StaffMember = {
  id: string;
  storeId: string;
  displayName: string;
  role: string;
  active: boolean;
  version: number;
};

export type SettingsResponse = {
  ok: true;
  settings: {
    stores: Store[];
    resources: Resource[];
    services: Service[];
    businessHours: BusinessHour[];
    closures: Closure[];
    staff: StaffMember[];
    reminderOffsets?: ReminderOffset[];
  };
};

export type LineQuotaStatus = {
  used: number;
  limit: number | null;
  remaining: number | null;
  softCap: number;
  asOf: string;
};

export type LineQuotaResponse = {
  ok: true;
  quota: LineQuotaStatus | null;
};

export type ReservationsResponse = {
  ok: true;
  range: string;
  startAt: string;
  endAt: string;
  reservations: Reservation[];
};

export type PendingReservationsResponse = {
  ok: true;
  reservations: Array<{
    id: string;
    status: "pending_approval";
    storeId: string;
    storeName: string;
    serviceNames: string;
    startAt: string;
    endAt: string;
    customerDisplayName: string;
    lineFriendStatus: string;
    version: number;
    // 旧Workerとの混在中は未提供。手動予約の期限なしは null。
    createdAt?: string | null;
    pendingExpiresAt?: string | null;
  }>;
};

// キャンセル料未納の一覧。承認待ち一覧と同じ「期間指定なし・固定件数」のキュー型で、
// 未納になった日が古い順に並ぶ。金額は持たない (未納フラグと日時だけの注記機能)。
export type UnpaidCancellationFeesResponse = {
  ok: true;
  reservations: Array<{
    id: string;
    status: string;
    storeId: string;
    storeName: string;
    serviceNames: string;
    startAt: string;
    endAt: string;
    customerDisplayName: string;
    cancellationFeeUnpaidAt: string;
  }>;
  /** 固定上限で切り捨てが起きたか。true のときは一覧が全件ではない。 */
  truncated: boolean;
};

export type ReservationDetailResponse = {
  ok: true;
  reservation: ReservationDetail;
};

export type ExternalBlocksResponse = {
  ok: true;
  externalBlocks: ExternalBlock[];
};

export type ReservationAction =
  | "approve"
  | "reject"
  | "cancel"
  | "complete"
  | "no-show"
  // 終端状態の訂正 (owner+ のみ)。backend は expectedVersion を必須にする。
  | "correct-no-show"
  | "restore-completed";

export type AvailableSlot = {
  resourceId: string;
  resourceName: string;
  startAt: string;
  available: boolean;
};

export type AvailableSlotsResponse =
  | { ok: true; slots: AvailableSlot[] }
  | { ok: false; reason?: string };

export type ReservationSearchItem = {
  id: string;
  status: string;
  source: string;
  storeName: string;
  serviceName: string;
  startAt: string;
  endAt: string;
  customerId: string;
  customerDisplayName: string;
  customerDisplayNameKana: string | null;
  phoneTailMasked: string;
  lineFriendStatus: string | null;
  googleEventId: string | null;
  cancellationFeeUnpaidAt: string | null;
};

export type ReservationSearchResponse = {
  ok: true;
  from: string;
  to: string;
  reservations: ReservationSearchItem[];
  truncated: boolean;
  totalCount: number | null;
};

export type CustomerListItem = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalizedMasked: string;
  blockStatus: string;
  visitCount: number;
  lastVisitAt: string | null;
  nextReservationAt: string | null;
  memo: string | null;
  archivedAt?: string | null;
};

export type CustomerListResponse = {
  customers: CustomerListItem[];
  total: number;
};

export type CustomerSearchItem = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalized: string | null;
  blockStatus: string;
  memo: string | null;
};

export type CustomerSearchResponse = {
  ok: true;
  customers: CustomerSearchItem[];
};

export type ReservationOrigin = "minimo" | "phone" | "walk_in" | "other";
export type CreateReservationOrigin = Exclude<ReservationOrigin, "phone">;

// 管理画面からの手動予約作成ペイロード。
// 既存客モード: customerId 指定（電話任意）。新規客モード: customer 手入力。
// serviceId は旧 backend 互換の併送フィールド（単一選択時のみ
// buildServiceSelectionPayload が設定する。複数選択時は serviceIds のみ）。
export type CreateReservationPayload = {
  idempotencyKey: string;
  storeId: string;
  serviceIds: string[];
  serviceId?: string;
  resourceId: string;
  startAt: string;
  origin?: CreateReservationOrigin;
} & (
  | { customerId: string; customer?: undefined }
  | {
      customerId?: undefined;
      customer: { displayName: string; displayNameKana?: string; phone: string };
    }
);

export type MergeCandidateCustomer = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalizedMasked: string;
  blockStatus: string;
  lastReservationAt: string | null;
};

export type MergeCandidateGroup = {
  // Opaque, stable per-group key (server-derived from member ids). The backend
  // deliberately does NOT expose phone_hash to the client.
  groupId: string;
  customers: MergeCandidateCustomer[];
};

export type MergeCandidatesResponse = {
  ok: true;
  groups: MergeCandidateGroup[];
  truncated: boolean;
};

export type CustomerMergeResponse = {
  ok: true;
  sourceId: string;
  targetId: string;
  reservationsMoved: number;
};

// Hard delete (irreversible). 4xx bodies carry { ok: false, reason }; the
// reason strings live in lib/error-messages.ts, which owns the UI copy.
export type CustomerDeleteResponse = {
  ok: true;
  removed: { reservations: number; visits: number; lineIdentities: number };
};

export type CustomerConsent = {
  id: string;
  type: string;
  version: string;
  consentedAt: string;
};

export type CustomerDetail = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalized: string | null;
  blockStatus: string;
  memo: string | null;
  referrerName?: string | null;
  reservationsNextOffset?: number | null;
  lastVisitAt?: string | null;
  nextReservation?: Reservation | null;
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
  visits: Array<{
    id: string;
    reservationId: string | null;
    storeId: string;
    storeName?: string;
    serviceName?: string | null;
    serviceNameSource?: "snapshot" | "current" | "unrecorded";
    visitedAt: string;
    visitSource: string;
    status: string;
    treatmentNotes: string | null;
    // 記入者。サーバ側で名前まで解決済み (自動完了は「自動完了」)。
    // ロールバックやデプロイ途中の混在で、この項目を返さない Worker と話すことがある。
    // 欠けたときは Worker 側と同じ「不明」を出す (resolveRecordedByLabel の既定値)。
    recordedBy?: string;
  }>;
  reservations: Reservation[];
  // May be absent while an older Worker serves a rollout or rollback.
  consentHistory?: CustomerConsent[];
  consentHistoryNextOffset?: number | null;
  // Owner/system_admin only (empty for staff): the customer's duplicate-reservation
  // acknowledgements over time — a signal for a customer repeatedly stacking
  // bookings instead of asking the store to cancel the old one.
  duplicateConsentHistory: Array<{
    reservationId: string;
    consentedAt: string;
    stage: "hard" | "soft";
    warningVersion: string;
    existingCount: number;
  }>;
};

export type CustomerDetailResponse = {
  ok: true;
  customer: CustomerDetail;
};

// 来店履歴の続き。`nextOffset` が null ならそこで終わり (issue #650)。
export type CustomerVisitsPageResponse = {
  ok: true;
  visits: CustomerDetail["visits"];
  nextOffset: number | null;
};

export type CustomerReservationsPageResponse = {
  ok: true;
  reservations: Reservation[];
  nextOffset: number | null;
};

export type CustomerConsentsPageResponse = {
  ok: true;
  consents: CustomerConsent[];
  nextOffset: number | null;
};

export type AddCustomerVisitRequest = {
  idempotencyKey: string;
  visitedAt: string; // YYYY-MM-DD (JST day), not in the future
  storeId: string;
  treatmentNotes?: string | null;
};

// 来店履歴の来店日編集 (owner+, 手動 visit のみ)。
export type UpdateCustomerVisitRequest = {
  idempotencyKey: string;
  visitedAt: string; // YYYY-MM-DD (JST day), not in the future
};

// 顧客の手動追加 (owner+)。紙カルテのお客様を予約前に登録しておく用途。
export type CreateCustomerRequest = {
  idempotencyKey: string;
  displayName: string;
  displayNameKana?: string | null;
  phone?: string | null;
};

export type CreateCustomerResponse = {
  ok: true;
  customerId: string;
  replayed: boolean;
};

export type AuditLogItem = {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadataJson: string | null;
  // 予約却下 (admin_reservation_reject) の行のみサーバー側で metadata から抽出される。
  // raw metadataJson と違い owner にも返る (staff は活動ログ API 自体が 403)。
  rejectionReason: string | null;
  createdAt: string;
};

export type AuditLogResponse = {
  ok: true;
  auditLogs: AuditLogItem[];
};

export type MutationOkResponse = {
  ok: true;
};

// --- 店舗ログイン（共有ログインメールの設定・無効化） ---

export type StoreLoginStatus = "unset" | "pending" | "active" | "disabled";

export type StoreLogin = {
  storeId: string;
  storeName: string;
  email: string | null;
  role: "owner" | "staff" | null;
  status: StoreLoginStatus;
  lastSeenAt: string | null;
  attention: "ambiguous_login" | null;
  canConfigure: boolean;
};

export type StoreLoginsResponse = { ok: true; storeLogins: StoreLogin[] };

export type StoreLoginUpsertRequest = {
  storeId: string;
  email: string;
  role: "owner" | "staff";
  idempotencyKey: string;
};

// --- LINE友だち ↔ 紙カルテ顧客 手動紐付け ---

export type LineFriendListItem = {
  lineUserId: string;
  displayName: string | null;
  pictureUrl: string | null;
  profileStatus: "pending" | "fetched" | "unavailable";
  linked: boolean;
  linkedCustomerId: string | null;
};

export type LineFriendsResponse = {
  ok: true;
  items: LineFriendListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type LineFriendSyncResponse = {
  ok: true;
  totalFriends: number;
  fetched: number;
  pending: number;
  unavailable: number;
  failed: number;
};

export type LineFriendsFilter = "unlinked" | "linked" | "all";

export type LinkLineFriendRequest =
  | { mode: "new"; storeId: string; newCustomer: { displayName: string; displayNameKana?: string; phone?: string } }
  | { mode: "existing"; storeId: string; customerId: string };

// --- External block (one-off) create / cancel ---

export type ExternalBlockCreateRequest = {
  idempotencyKey: string;
  storeId: string;
  resourceId: string;
  startAt: string;
  endAt: string;
  title?: string;
};

export type ExternalBlockActionResponse = {
  ok: true;
  externalBlockId: string;
  status: "active" | "cancelled";
  storeId: string;
  startAt: string;
  endAt: string;
  replayed: boolean;
};

export type StaffCreateResponse = {
  ok: true;
  staffId: string;
  replayed: boolean;
};

export type ServiceCreateResponse = {
  ok: true;
  serviceId: string;
  replayed: boolean;
};

export type StaffCreateRequest = {
  storeId: string;
  displayName: string;
  role: "owner" | "staff" | "system_admin";
  active: boolean;
  idempotencyKey: string;
};

export type StaffUpdateRequest = {
  storeId: string;
  displayName: string;
  role: "owner" | "staff" | "system_admin";
  active: boolean;
  expectedVersion: number;
};

export type ServiceCreateRequest = {
  storeId: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceLabel: string | null;
  priceAmount?: number | null;
  comboPriceAmount?: number | null;
  comboWithPrefix?: string | null;
  active: boolean;
  mensMenu?: boolean;
  idempotencyKey: string;
};

export type ServiceUpdateRequest = {
  storeId: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceLabel: string | null;
  priceAmount?: number | null;
  comboPriceAmount?: number | null;
  comboWithPrefix?: string | null;
  active: boolean;
  /** 省略するとサーバ側で現在値を維持する（部分 PUT での意図しないリセットを防ぐ）。 */
  mensMenu?: boolean;
};

export type Closure = {
  id: string;
  storeId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  source: "admin" | "google_external_block";
};

export type ReminderOffset = {
  storeId: string;
  offsetMinutes: number | null;
};

export type BusinessHourRow = {
  weekday: number;
  opensAt: string;
  closesAt: string;
  closed: boolean;
};

export type BusinessHoursResponse = {
  ok: true;
  businessHours: BusinessHourRow[];
};

export type ClosureCreateRequest = {
  storeId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  idempotencyKey: string;
};

export type ClosureUpdateRequest = {
  storeId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};

export type ResourceCreateRequest = {
  storeId: string;
  name: string;
  resourceType: "staff_calendar";
  active: boolean;
  idempotencyKey: string;
};

export type ResourceUpdateRequest = {
  storeId: string;
  name: string;
  resourceType: "staff_calendar";
  active: boolean;
};

export type ReminderUpdateRequest = {
  storeId: string;
  offsetMinutes: number | null;
};

export type ReservationCapUpdateRequest = {
  storeId: string;
  maxActiveReservationsPerCustomer: number;
};

export type BookingWindowUpdateRequest = {
  storeId: string;
  bookingWindowDays: number;
};

export type CustomerNoticeUpdateRequest = {
  storeId: string;
  customerNotice: string | null;
};

export type RecurringPreviewRequest = {
  storeId: string;
  resourceId: string;
  rrule: string;
  dtstart: string;
  windowEnd: string;
  durationMinutes: number;
};

export type RecurringPreviewResponse = {
  ok: true;
  occurrences: string[];
  truncatedByWindow: boolean;
  truncatedByCap: boolean;
  windowCapped: boolean;
};

export type RecurringCommitRequest = {
  idempotencyKey: string;
  storeId: string;
  resourceId: string;
  rrule: string;
  dtstart: string;
  windowEnd: string;
  durationMinutes: number;
  title?: string;
};

export type RecurringCommitResponse = {
  ok: true;
  createdCount: number;
  replayedCount: number;
  skippedPastCount: number;
  failedCount: number;
};

// --- Google Sync Status ---

export type SyncWarningItem = {
  kind: string;
  count: number;
  message: string;
};

export type SyncSummary = {
  openGoogleConflicts: number;
  googleSyncJobsNeedingAttention: number;
  lineNotificationJobsNeedingAttention: number;
  channelsNeedingAttention: number;
};

export type OwnerConflictStoreCount = {
  storeId: string;
  total: number;
  actionRequired: number;
};

export type OwnerConflictAggregate = {
  totalConflicts: number;
  totalRequiringAction: number;
  perStore: OwnerConflictStoreCount[];
};

export type SyncStatusStaff = {
  ok: true;
  role: "staff";
  warnings: SyncWarningItem[];
};

export type SyncStatusOwner = {
  ok: true;
  role: "owner";
  summary: SyncSummary;
  recoveryTasks: SyncWarningItem[];
  conflictAggregate: OwnerConflictAggregate;
  /** Absent when the previous Worker is serving during rollout/rollback. */
  actionableConflicts?: Array<{
    id: string;
    storeId: string;
    conflictType: "google_all_day_event" | "reservation_event_deleted";
    summary: string | null;
    createdAt: string;
    startAt: string | null;
    endAt: string | null;
    storeName: string;
    customerDisplayName: string | null;
    overlappingReservations: [];
  }>;
};

export type SyncChannel = {
  id: string;
  storeId: string;
  calendarId: string;
  status: string;
  syncTokenPresent: boolean;
  expirationAt: string | null;
  lastNotificationAt: string | null;
  lastResourceState: string | null;
  lastMessageNumber: string | null;
  lastIncrementalSyncAt: string | null;
  lastFullReconcileAt: string | null;
  updatedAt: string;
};

export type SyncDlqJob = {
  source: "google_calendar_import_jobs" | "calendar_sync_jobs" | "notification_jobs";
  id: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  updatedAt: string;
  storeId?: string;
  calendarId?: string;
  reason?: string;
  ownerType?: string;
  ownerId?: string;
  googleAction?: string;
  templateKey?: string;
  recipientType?: string;
  recipientId?: string;
  reservationId?: string | null;
};

export type SyncConflictType =
  | "external_block_slot_conflict"
  | "external_block_event_deleted"
  | "external_block_non_google_edit"
  | "reservation_event_deleted"
  | "google_all_day_event"
  | "google_recurring_event";

export type SyncConflict = {
  id: string;
  storeId: string;
  calendarId: string;
  googleEventId: string;
  reservationId: string | null;
  externalBlockId: string | null;
  conflictType: SyncConflictType | (string & {});
  summary: string | null;
  googleSafeSnapshotJson: string;
  d1SafeSnapshotJson: string | null;
  resolutionStatus: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  overlappingReservations: Array<{
    id: string;
    startAt: string;
    endAt: string;
    status: string;
    customerDisplayName: string;
  }>;
};

export type SyncStatusSystemAdmin = {
  ok: true;
  role: "system_admin";
  summary: SyncSummary;
  channels: SyncChannel[];
  dlq: {
    source: "d1_attention_jobs";
    jobs: SyncDlqJob[];
  };
  conflicts: SyncConflict[];
  googleEvents: Array<{
    id: string;
    storeId: string;
    calendarId: string;
    googleEventId: string;
    reservationId: string | null;
    externalBlockId: string | null;
    googleEtag: string | null;
    googleUpdatedAt: string | null;
    lastSeenAt: string;
    lastImportedAt: string | null;
    sourceType: string;
    status: string;
    googleSafeSnapshotJson: string | null;
  }>;
  outboundWrites: Array<{
    id: string;
    calendarSyncJobId: string | null;
    dedupeKey: string;
    calendarId: string;
    googleEventId: string;
    ownerType: string;
    ownerId: string;
    action: string;
    expectedFingerprint: string;
    googleEtagAfter: string | null;
    expiresAt: string;
    createdAt: string;
  }>;
};

export type SyncStatusResponse = SyncStatusStaff | SyncStatusOwner | SyncStatusSystemAdmin;

// ── 管理画面 Web Push ──────────────────────────────────────────────
export type AdminPushSubscribeRequest = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type AdminPushUnsubscribeRequest = {
  endpoint: string;
};

/** テスト送信の結果。sent = 実際に配信を試みた自分の端末数。 */
export type AdminPushTestResponse = {
  ok: true;
  /** Devices registered for this admin — 0 means nothing to send to. */
  devices: number;
  /** Of those, how many the push service accepted. */
  sent: number;
};
