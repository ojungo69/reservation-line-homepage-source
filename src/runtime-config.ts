import type { WorkerBindings } from "./bindings";

export const D1_DR_FREEZE_MAINTENANCE_MODE = "d1-dr-freeze";
export const D1_DR_FREEZE_SENTINEL_PATH = "/.well-known/sdj-d1-dr-freeze";
export const D1_DR_FREEZE_HEADER_NAME = "x-sdj-maintenance";
export const D1_DR_FREEZE_RETRY_DELAY_SECONDS = 300;

export function isGoogleImportEnabled(env: Partial<Pick<WorkerBindings, "GOOGLE_IMPORT_ENABLED">>) {
  return env.GOOGLE_IMPORT_ENABLED !== "false";
}

export function isGoogleLiveAvailabilityEnabled(
  env: Partial<Pick<WorkerBindings, "GOOGLE_IMPORT_ENABLED" | "GOOGLE_LIVE_AVAILABILITY_ENABLED">>
) {
  return isGoogleImportEnabled(env) && env.GOOGLE_LIVE_AVAILABILITY_ENABLED === "true";
}

export function isReservationReminderDispatchEnabled(
  env: Partial<Pick<WorkerBindings, "RESERVATION_REMINDER_DISPATCH_ENABLED">>
) {
  return env.RESERVATION_REMINDER_DISPATCH_ENABLED === "true";
}

export function isDailyOpsSummaryDispatchEnabled(
  env: Partial<Pick<WorkerBindings, "DAILY_OPS_SUMMARY_DISPATCH_ENABLED">>
) {
  return env.DAILY_OPS_SUMMARY_DISPATCH_ENABLED === "true";
}

export function isD1DrFreezeMaintenanceMode(
  env: Partial<Pick<WorkerBindings, "MAINTENANCE_MODE" | "EMERGENCY_D1_FREEZE">>
): boolean {
  return (
    env.EMERGENCY_D1_FREEZE === "true" ||
    env.MAINTENANCE_MODE === D1_DR_FREEZE_MAINTENANCE_MODE
  );
}

export function isWorkflowEnabled(
  env: Partial<Pick<WorkerBindings, "WORKFLOW_ENABLED">>
): boolean {
  return env.WORKFLOW_ENABLED === "true";
}
