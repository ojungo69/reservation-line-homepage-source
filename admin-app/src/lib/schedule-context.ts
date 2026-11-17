export type ScheduleContext = {
  scope: string;
  date: string;
  viewMode: "day" | "week";
  mobileView: "agenda" | "timeline";
  reservationId: string;
  mainScroll: number;
  scheduleScroll: number;
  scheduleScrollLeft: number;
};

export function readScheduleContext(raw: unknown, scope: string): ScheduleContext | null {
  if (typeof raw !== "object" || raw === null || !("scheduleContext" in raw)) return null;
  const value = raw.scheduleContext;
  if (typeof value !== "object" || value === null) return null;
  if (!("scope" in value) || value.scope !== scope ||
      !("date" in value) || typeof value.date !== "string" || !Number.isFinite(Date.parse(value.date)) ||
      !("viewMode" in value) || (value.viewMode !== "day" && value.viewMode !== "week") ||
      !("mobileView" in value) || (value.mobileView !== "agenda" && value.mobileView !== "timeline") ||
      !("reservationId" in value) || typeof value.reservationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.reservationId) ||
      !("mainScroll" in value) || typeof value.mainScroll !== "number" || !Number.isFinite(value.mainScroll) || value.mainScroll < 0 ||
      !("scheduleScroll" in value) || typeof value.scheduleScroll !== "number" || !Number.isFinite(value.scheduleScroll) || value.scheduleScroll < 0 ||
      !("scheduleScrollLeft" in value) || typeof value.scheduleScrollLeft !== "number" || !Number.isFinite(value.scheduleScrollLeft) || value.scheduleScrollLeft < 0) return null;
  return { scope, date: value.date, viewMode: value.viewMode, mobileView: value.mobileView,
    reservationId: value.reservationId, mainScroll: value.mainScroll,
    scheduleScroll: value.scheduleScroll, scheduleScrollLeft: value.scheduleScrollLeft };
}
