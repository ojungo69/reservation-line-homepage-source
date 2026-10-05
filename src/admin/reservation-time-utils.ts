export const isNonEmptyString = (value: unknown, maxLength: number): value is string => {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
};

export { toIso, addMinutes } from "../time-utils";

export const parseStartAt = (value: string, intervalMinutes: number): Date | undefined => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    return undefined;
  }
  if (date.getUTCMinutes() % intervalMinutes !== 0) {
    return undefined;
  }
  return date;
};
