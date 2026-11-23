import { use, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { actionErrorMessage } from "@/lib/error-messages";
import type {
  CalendarRescheduleCommitRequest,
  CalendarRescheduleIntent,
  CalendarReschedulePreviewRequest,
  Reservation,
  ReservationDetailResponse,
} from "@/types/api";
import { sha256Hex } from "../../../src/crypto-utils";
import { reservationDetailKey } from "./use-reservations";

const CONTRACT = "calendar-interactions-v1";
const CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;
const REJECTION_STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  unsupported_contract: 400,
  invalid_time: 400,
  outside_business_hours: 400,
  store_closed: 400,
  forbidden: 403,
  not_found: 404,
  feature_disabled: 404,
  version_conflict: 409,
  invalid_transition: 409,
  preview_stale: 409,
  no_change: 409,
  slot_unavailable: 409,
  customer_time_conflict: 409,
  idempotency_conflict: 409,
  operation_not_applied: 409,
  rate_limited: 429,
};
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  version_conflict: "他の操作で予約が更新されました。最新の予約をご確認ください。",
  preview_stale: "保存前に予約条件が変わりました。最新の予約を確認して、もう一度操作してください。",
  no_change: "変更内容は現在の予約と同じです。",
  idempotency_conflict: "保存内容を確認できませんでした。最新の予約をご確認ください。",
};

export type CalendarRescheduleOptions = Readonly<{
  scope: string;
  disabled: boolean;
  onUnavailable: () => void;
  onCommitSessionChange?: (open: boolean) => void;
}>;

type Notice = { text: string; error?: boolean };
type PreviewWindow = { startAt: string; treatmentEndAt: string; endAt: string; treatmentMinutes: number };
type Confirmation = Readonly<{
  id: string;
  body: CalendarRescheduleCommitRequest;
  reservation: Reservation;
  before: PreviewWindow;
  after: PreviewWindow;
  notifiesCustomer: boolean;
}>;
type ChangeRequestContext = { source?: Reservation; onCloseEditor?: () => void };
type PreparedPreview = { proposed: unknown; body: CalendarRescheduleCommitRequest };
type Operation = Readonly<{
  id: string;
  body: CalendarRescheduleCommitRequest;
  sentAt: number;
  confirmation?: Confirmation;
  onCloseEditor?: () => void;
}>;
type ChangeState =
  | { kind: "idle"; notice?: Notice }
  | { kind: "previewing"; direct: boolean }
  | { kind: "confirming"; confirmation: Confirmation }
  | { kind: "committing"; operation: Operation }
  | { kind: "unknown"; operation: Operation; checking: boolean };
const IDLE: ChangeState = { kind: "idle" };

function operationOf(state: ChangeState) {
  return state.kind === "committing" || state.kind === "unknown" ? state.operation : null;
}

function checkTimeLeft(operation: Operation) {
  return CHECK_WINDOW_MS - (performance.now() - operation.sentAt);
}

function reservationPath(id: string) {
  return `/api/admin/reservations/${encodeURIComponent(id)}`;
}

export function canChangeReservationTime(status: string) {
  return status === "pending_approval" || status === "confirmed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failureReason(error: unknown) {
  if (!(error instanceof ApiError)) return;
  if (error.status === 401) return "login_required";
  if (!isRecord(error.body) || error.body.ok !== false) return;
  const reason = error.body.reason ?? error.body.error;
  if (typeof reason === "string" && REJECTION_STATUS[reason] === error.status) return reason;
}

async function commitRequest(
  value: unknown, id: string, preview: CalendarReschedulePreviewRequest,
): Promise<CalendarRescheduleCommitRequest> {
  if (!isRecord(value) || value.ok !== true || value.contractVersion !== CONTRACT ||
      value.reservationId !== id || value.version !== preview.expectedVersion ||
      typeof value.previewFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.previewFingerprint) ||
      !isRecord(value.intent)) {
    throw new Error("Invalid reschedule preview response");
  }
  const { intent, previewFingerprint } = value;
  let normalized: CalendarRescheduleIntent;
  if (intent.kind === "move" && preview.intent.kind === "move" && typeof intent.startAt === "string" &&
      Date.parse(intent.startAt) === Date.parse(preview.intent.startAt)) {
    normalized = { kind: "move", startAt: intent.startAt };
  } else if (intent.kind === "resize" && preview.intent.kind === "resize" && intent.treatmentMinutes === preview.intent.treatmentMinutes) {
    normalized = preview.intent;
  } else {
    throw new Error("Invalid reschedule preview intent");
  }
  const fingerprintHash = await sha256Hex(previewFingerprint);
  return {
    ...preview,
    intent: normalized,
    previewFingerprint,
    idempotencyKey: `calendar-v1:${crypto.randomUUID()}:${fingerprintHash}`,
  };
}

function currentReservation(value: unknown, id: string, expectedVersion: number, check: boolean) {
  if (!isRecord(value) || value.ok !== true || value.contractVersion !== CONTRACT ||
      typeof value.replayed !== "boolean" || (check && !value.replayed) ||
      typeof value.operationId !== "string" || !value.operationId ||
      !isRecord(value.reservation)) {
    throw new Error("Invalid reschedule commit response");
  }
  const { version, status, startAt, endAt } = value.reservation;
  if (value.reservation.id !== id || typeof version !== "number" ||
      !Number.isSafeInteger(version) || version <= expectedVersion || typeof status !== "string" ||
      typeof startAt !== "string" || typeof endAt !== "string") {
    throw new Error("Invalid reservation in reschedule commit response");
  }
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    throw new Error("Invalid reservation dates in reschedule commit response");
  }
  return { version, status, startAt, endAt };
}

function previewWindow(value: unknown): PreviewWindow {
  if (!isRecord(value)) throw new Error("Invalid reschedule preview window");
  const { startAt, treatmentEndAt, endAt, treatmentMinutes } = value;
  if (typeof startAt !== "string" || typeof treatmentEndAt !== "string" || typeof endAt !== "string" ||
      ![startAt, treatmentEndAt, endAt].every((date) => Number.isFinite(Date.parse(date))) ||
      typeof treatmentMinutes !== "number" || !Number.isFinite(treatmentMinutes)) {
    throw new Error("Invalid reschedule preview window");
  }
  return { startAt, treatmentEndAt, endAt, treatmentMinutes };
}

function confirmationOf(value: unknown, body: CalendarRescheduleCommitRequest, reservation: Reservation): Confirmation {
  if (!isRecord(value) || value.storeId !== reservation.storeId || value.resourceId !== reservation.resourceId ||
      !isRecord(value.notificationPlan)) {
    throw new Error("Invalid reschedule confirmation");
  }
  const { kind } = value.notificationPlan;
  if (kind !== "none" && kind !== "time_changed") throw new Error("Invalid reschedule notification plan");
  return {
    id: reservation.id, body, reservation, before: previewWindow(value.before), after: previewWindow(value.after),
    notifiesCustomer: kind === "time_changed",
  };
}

function hasVersion(version: number | undefined): version is number {
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1;
}

export type CalendarReschedule = ReturnType<typeof useCalendarReschedule>;

export function useCalendarReschedule(calendar: CalendarRescheduleOptions) {
  const queryClient = use(QueryClientContext);
  const { scope: calendarScope, onCommitSessionChange } = calendar;
  const scopeSession = useRef<{ sentCommit: boolean } | null>(null);
  const writeDisabled = useRef(calendar.disabled);
  const [state, setState] = useState<ChangeState>(IDLE);
  // Event handlers also use the current phase before React renders disabled buttons.
  const stateRef = useRef(state);
  const transition = useCallback((next: ChangeState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useLayoutEffect(() => {
    if (stateRef.current !== IDLE) transition(IDLE);
    const session = { sentCommit: false };
    scopeSession.current = session;
    return () => {
      scopeSession.current = null;
      if (session.sentCommit) onCommitSessionChange?.(false);
    };
  }, [calendarScope, transition, onCommitSessionChange]);

  useLayoutEffect(() => {
    writeDisabled.current = calendar.disabled;
    const current = stateRef.current;
    if (calendar.disabled && (current.kind === "confirming" || (current.kind === "previewing" && current.direct))) {
      transition(IDLE);
    }
  }, [calendar.disabled, transition]);

  const refreshReservations = () => {
    void queryClient?.invalidateQueries({ queryKey: ["reservations"] });
  };

  const reject = (error: unknown, reason: string | undefined) => {
    if (reason) refreshReservations();
    if (reason === "feature_disabled" || reason === "unsupported_contract") {
      calendar.onUnavailable();
      transition(IDLE);
      return;
    }
    const text = reason ? (FAILURE_MESSAGES[reason] ?? actionErrorMessage(error))
      : "日時を変更できませんでした。時間をおいて再度お試しください。";
    transition({ kind: "idle", notice: { text, error: true } });
  };

  const releaseCommitSession = () => {
    const session = scopeSession.current;
    if (!session?.sentCommit) return;
    session.sentCommit = false;
    onCommitSessionChange?.(false);
  };

  const expire = (operation: Operation) => {
    if (!scopeSession.current || operationOf(stateRef.current) !== operation) return;
    refreshReservations();
    transition({ kind: "idle", notice: { text: "保存結果の確認期限が過ぎました。最新の予約情報をご確認ください。" } });
    operation.onCloseEditor?.();
    if (operation.confirmation) releaseCommitSession();
  };
  const expireFromTimer = useEffectEvent(expire);
  const operation = operationOf(state);
  useEffect(() => {
    if (!operation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkDeadline = () => {
      clearTimeout(timer);
      const remaining = checkTimeLeft(operation);
      if (remaining <= 0) expireFromTimer(operation);
      else timer = setTimeout(checkDeadline, remaining);
    };
    checkDeadline();
    document.addEventListener("visibilitychange", checkDeadline);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkDeadline);
    };
  }, [operation]);

  const handleCommitFailure = (operation: Operation, check: boolean, error: unknown) => {
    const reason = failureReason(error);
    if (reason === "operation_not_applied") {
      refreshReservations();
      transition({ kind: "idle", notice: { text: "保存されていません。この変更はこの後も保存されません。" } });
      return;
    }
    if (!check && reason) {
      reject(error, reason);
      return;
    }
    if (reason === "feature_disabled" || (!reason && error instanceof ApiError && error.status === 404)) {
      calendar.onUnavailable();
      refreshReservations();
    }
    transition({ kind: "unknown", operation, checking: false });
  };

  const commit = async (operation: Operation, check: boolean) => {
    if (!queryClient) return;
    const { id, body } = operation;
    const canUseResult = () => {
      if (!scopeSession.current || operationOf(stateRef.current) !== operation) return false;
      if (checkTimeLeft(operation) > 0) return true;
      expire(operation);
      return false;
    };
    try {
      const response = await api.post<unknown>(`${reservationPath(id)}/reschedule/commit${check ? "?mode=check" : ""}`, body);
      if (!canUseResult()) return;

      const latest = currentReservation(response, id, body.expectedVersion, check);
      const queryKey = reservationDetailKey(id, calendarScope);
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData<ReservationDetailResponse>(queryKey, (data) =>
        data?.ok && data.reservation.version <= latest.version
          ? { ...data, reservation: { ...data.reservation, ...latest } }
          : data,
      );
      refreshReservations();
      transition({ kind: "idle", notice: { text: "保存済みです" } });
    } catch (error) {
      if (!canUseResult()) return;
      handleCommitFailure(operation, check, error);
    }
    if (operation.confirmation && stateRef.current.kind !== "unknown") releaseCommitSession();
  };

  const startCommit = async (id: string, body: CalendarRescheduleCommitRequest, context: {
    confirmation?: Confirmation;
    onCloseEditor?: () => void;
  }) => {
    const session = scopeSession.current;
    if (!session || writeDisabled.current) {
      transition(IDLE);
      return;
    }
    const operation = { id, body, sentAt: performance.now(), ...context };
    if (!session.sentCommit) {
      session.sentCommit = true;
      onCommitSessionChange?.(true);
    }
    transition({ kind: "committing", operation });
    await commit(operation, false);
  };

  const refreshPreviewVersion = async (client: QueryClient, source: Reservation, current: () => boolean) => {
    const detail = await client.fetchQuery({
      queryKey: reservationDetailKey(source.id, calendarScope),
      queryFn: ({ signal }) => api.get<ReservationDetailResponse>(reservationPath(source.id), { signal }),
      staleTime: 0,
    });
    if (!current()) return;
    const latest = detail.ok ? detail.reservation : null;
    if (latest?.id !== source.id || !canChangeReservationTime(latest.status) || latest.storeId !== source.storeId ||
        latest.resourceId !== source.resourceId || Date.parse(latest.startAt) !== Date.parse(source.startAt) ||
        Date.parse(latest.endAt) !== Date.parse(source.endAt)) {
      reject(undefined, "version_conflict");
      return;
    }
    if (!hasVersion(latest.version)) throw new Error("Missing reservation version");
    return latest.version;
  };

  const preparePreview = async ({
    client, id, version, intent, source, current,
  }: {
    client: QueryClient;
    id: string;
    version: number | undefined;
    intent: CalendarRescheduleIntent;
    source: Reservation | undefined;
    current: () => boolean;
  }): Promise<PreparedPreview | undefined> => {
    let expectedVersion = version;
    if (source && !hasVersion(expectedVersion)) {
      expectedVersion = await refreshPreviewVersion(client, source, current);
      if (!current() || expectedVersion === undefined) return;
    }
    if (!hasVersion(expectedVersion)) throw new Error("Missing reservation version");
    const preview = { contractVersion: CONTRACT, expectedVersion, intent } satisfies CalendarReschedulePreviewRequest;
    const proposed = await api.post<unknown>(`${reservationPath(id)}/reschedule/preview`, preview);
    if (!current()) return;
    const body = await commitRequest(proposed, id, preview);
    if (!current()) return;
    return { proposed, body };
  };

  const applyPreview = (id: string, { proposed, body }: PreparedPreview, { source, onCloseEditor }: ChangeRequestContext) => {
    if (writeDisabled.current) {
      transition(IDLE);
      return;
    }
    if (source) {
      transition({ kind: "confirming", confirmation: confirmationOf(proposed, body, source) });
      return;
    }
    return startCommit(id, body, { onCloseEditor });
  };

  const handlePreviewFailure = (error: unknown) => {
    const reason = failureReason(error) ?? (error instanceof ApiError && error.status === 404 ? "unsupported_contract" : undefined);
    reject(error, reason);
  };

  const request = async (id: string, version: number | undefined, intent: CalendarRescheduleIntent, context: ChangeRequestContext) => {
    const { source, onCloseEditor } = context;
    const session = scopeSession.current;
    if (!session || !queryClient || stateRef.current.kind !== "idle") return;
    if (!source && !hasVersion(version)) return;
    if (writeDisabled.current) {
      onCloseEditor?.();
      return;
    }
    const draft = { kind: "previewing", direct: source !== undefined } as const;
    const current = () => scopeSession.current === session && stateRef.current === draft;
    transition(draft);
    try {
      const prepared = await preparePreview({ client: queryClient, id, version, intent, source, current });
      if (!current() || !prepared) return;
      await applyPreview(id, prepared, context);
    } catch (error) {
      if (current()) handlePreviewFailure(error);
    } finally {
      if (scopeSession.current === session) onCloseEditor?.();
    }
  };

  const check = () => {
    const current = stateRef.current;
    if (current.kind !== "unknown" || current.checking) return;
    if (checkTimeLeft(current.operation) <= 0) {
      expire(current.operation);
      return;
    }
    transition({ ...current, checking: true });
    void commit(current.operation, true);
  };

  let confirmation: Confirmation | undefined;
  if (state.kind === "confirming") {
    confirmation = state.confirmation;
  } else if (state.kind === "committing") {
    confirmation = state.operation.confirmation;
  }

  return {
    save: (id: string, version: number, intent: CalendarRescheduleIntent, onCloseEditor: () => void) =>
      request(id, version, intent, { onCloseEditor }),
    previewDrop: (reservation: Reservation, intent: CalendarRescheduleIntent) =>
      request(reservation.id, reservation.version, intent, { source: reservation }),
    confirmDrop: () => {
      const current = stateRef.current;
      if (current.kind !== "confirming") return;
      const { id, body } = current.confirmation;
      void startCommit(id, body, { confirmation: current.confirmation });
    },
    cancelDrop: () => {
      const current = stateRef.current;
      if (current.kind === "confirming" || (current.kind === "previewing" && current.direct)) transition(IDLE);
    },
    check,
    close: () => {
      if (stateRef.current.kind === "committing") return;
      if (stateRef.current.kind === "unknown") refreshReservations();
      if (stateRef.current !== IDLE) transition(IDLE);
      releaseCommitSession();
    },
    busy: state.kind !== "idle",
    confirmation,
    pending: state.kind === "previewing" || state.kind === "committing",
    unknown: state.kind === "unknown" ? state : null,
    notice: state.kind === "idle" ? state.notice : undefined,
  };
}
