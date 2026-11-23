import { use, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { actionErrorMessage } from "@/lib/error-messages";
import type {
  CalendarRescheduleCommitRequest,
  CalendarRescheduleIntent,
  CalendarReschedulePreviewRequest,
  ReservationDetailResponse,
} from "@/types/api";
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
type Operation = Readonly<{ id: string; body: CalendarRescheduleCommitRequest; sentAt: number }>;
type ChangeState =
  | { kind: "idle"; notice?: Notice }
  | { kind: "previewing" }
  | { kind: "committing"; operation: Operation }
  | { kind: "unknown"; operation: Operation; checking: boolean };
const IDLE: ChangeState = { kind: "idle" };

function operationOf(state: ChangeState) {
  return state.kind === "committing" || state.kind === "unknown" ? state.operation : null;
}

function checkTimeLeft(operation: Operation) {
  return CHECK_WINDOW_MS - (performance.now() - operation.sentAt);
}

function reschedulePath(id: string) {
  return `/api/admin/reservations/${encodeURIComponent(id)}/reschedule`;
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

function commitRequest(
  value: unknown, id: string, preview: CalendarReschedulePreviewRequest,
): CalendarRescheduleCommitRequest {
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
  return {
    ...preview,
    intent: normalized,
    previewFingerprint,
    idempotencyKey: `calendar-v1:${crypto.randomUUID()}:${previewFingerprint}`,
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
      typeof startAt !== "string" || typeof endAt !== "string" || !(Date.parse(endAt) > Date.parse(startAt))) {
    throw new Error("Invalid reservation in reschedule commit response");
  }
  return { version, status, startAt, endAt };
}

export function useCalendarReschedule({
  reservationId,
  calendar,
  onCloseEditor,
}: Readonly<{ reservationId: string | null; calendar?: CalendarRescheduleOptions; onCloseEditor: () => void }>) {
  const queryClient = use(QueryClientContext);
  const calendarScope = calendar?.scope;
  const onCommitSessionChange = calendar?.onCommitSessionChange;
  const detailSession = useRef<{ id: string; sentCommit: boolean } | null>(null);
  const writeDisabled = useRef(calendar?.disabled);
  const [state, setState] = useState<ChangeState>(IDLE);
  // Event handlers also use the current phase before React renders disabled buttons.
  const stateRef = useRef(state);
  const transition = useCallback((next: ChangeState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useLayoutEffect(() => {
    if (calendarScope === undefined) return;
    if (stateRef.current !== IDLE) transition(IDLE);
    if (!reservationId) return;
    const session = { id: reservationId, sentCommit: false };
    detailSession.current = session;
    return () => {
      detailSession.current = null;
      if (session.sentCommit) onCommitSessionChange?.(false);
    };
  }, [calendarScope, reservationId, transition, onCommitSessionChange]);

  useLayoutEffect(() => {
    writeDisabled.current = calendar?.disabled;
  }, [calendar?.disabled]);

  const refreshReservations = () => {
    void queryClient?.invalidateQueries({ queryKey: ["reservations"] });
  };

  const reject = (error: unknown, reason: string | undefined) => {
    if (reason) refreshReservations();
    if (reason === "feature_disabled" || reason === "unsupported_contract") {
      calendar?.onUnavailable();
      transition(IDLE);
      return;
    }
    const text = reason ? (FAILURE_MESSAGES[reason] ?? actionErrorMessage(error))
      : "日時を変更できませんでした。時間をおいて再度お試しください。";
    transition({ kind: "idle", notice: { text, error: true } });
  };

  const expire = (operation: Operation) => {
    if (!detailSession.current || operationOf(stateRef.current) !== operation) return;
    refreshReservations();
    transition({ kind: "idle", notice: { text: "保存結果の確認期限が過ぎました。最新の予約情報をご確認ください。" } });
    onCloseEditor();
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

  const commit = async (operation: Operation, check: boolean) => {
    if (!queryClient) return;
    const { id, body } = operation;
    const canUseResult = () => {
      if (!detailSession.current || operationOf(stateRef.current) !== operation) return false;
      if (checkTimeLeft(operation) > 0) return true;
      expire(operation);
      return false;
    };
    try {
      const response = await api.post<unknown>(`${reschedulePath(id)}/commit${check ? "?mode=check" : ""}`, body);
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
      const reason = failureReason(error);
      if (reason === "operation_not_applied") {
        refreshReservations();
        transition({ kind: "idle", notice: { text: "保存されていません。この変更はこの後も保存されません。" } });
      } else if (!check && reason) {
        reject(error, reason);
      } else {
        if (reason === "feature_disabled") {
          calendar?.onUnavailable();
          refreshReservations();
        }
        transition({ kind: "unknown", operation, checking: false });
      }
    }
    if (!check) onCloseEditor();
  };

  const save = async (id: string, version: number, intent: CalendarRescheduleIntent) => {
    const session = detailSession.current;
    if (session?.id !== id || !queryClient ||
        stateRef.current.kind !== "idle" || !Number.isSafeInteger(version) || version < 1) return;
    if (writeDisabled.current) {
      onCloseEditor();
      return;
    }
    transition({ kind: "previewing" });
    const preview = { contractVersion: CONTRACT, expectedVersion: version, intent } satisfies CalendarReschedulePreviewRequest;
    let body: CalendarRescheduleCommitRequest;
    try {
      const proposed = await api.post<unknown>(`${reschedulePath(id)}/preview`, preview);
      if (detailSession.current !== session) return;
      if (writeDisabled.current) {
        transition(IDLE);
        onCloseEditor();
        return;
      }
      body = commitRequest(proposed, id, preview);
    } catch (error) {
      if (detailSession.current !== session) return;
      const reason = failureReason(error) ?? (error instanceof ApiError && error.status === 404 ? "unsupported_contract" : undefined);
      reject(error, reason);
      onCloseEditor();
      return;
    }
    const operation = { id, body, sentAt: performance.now() };
    if (!session.sentCommit) {
      session.sentCommit = true;
      onCommitSessionChange?.(true);
    }
    transition({ kind: "committing", operation });
    await commit(operation, false);
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

  return {
    save,
    check,
    abandon: () => {
      if (stateRef.current.kind === "unknown") {
        refreshReservations();
        transition(IDLE);
      }
    },
    pending: state.kind === "previewing" || state.kind === "committing",
    unknown: state.kind === "unknown" ? state : null,
    notice: state.kind === "idle" ? state.notice : undefined,
  };
}
