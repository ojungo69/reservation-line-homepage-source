export type ReservationEventType =
  | "created"
  | "approved"
  | "rejected"
  | "cancelled"
  | "completed"
  | "expired"
  | "no_show"
  | "checked_in"
  // 終端状態の訂正 (completed <-> no_show)。既存の completed / no_show とは別の
  // イベントにする — 往復させるたびに完了件数と no_show 件数が両方増えて、
  // 実際の来店実績を反映しなくなるため。
  | "corrected_no_show"
  | "restored_completed";

export type MetricEventType =
  | ReservationEventType
  | "notification_sent"
  | "notification_failed";

export interface MetricEvent {
  type: MetricEventType;
  storeId: string;
  serviceId?: string;
  source?: "online" | "phone_admin" | "admin";
  channel?: "line" | "email";
  /** Dispatcher outcomes, including intentional suppression; not delivered messages. */
  jobCount?: number;
  environment: string;
}

export function trackEvent(
  env: { METRICS?: AnalyticsEngineDataset },
  event: MetricEvent
): void {
  if (!env.METRICS) return;
  env.METRICS.writeDataPoint({
    indexes: [event.storeId],
    blobs: [
      event.type,
      event.serviceId ?? "",
      event.source ?? "",
      event.environment,
      event.channel ?? ""
    ],
    // double1 keeps the historical batch/event count. double2 is available only
    // for new notification points; old points cannot supply a historical count.
    doubles: event.jobCount === undefined ? [1] : [1, event.jobCount]
  });
}
