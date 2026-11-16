import { sha256Hex } from "../crypto-utils";

export type MinimoStaffMapping = {
  rimaUserId: string;
  resourceId: string;
  maxDurationMinutes: number;
};

export type MinimoAccount = {
  storeId: string;
  salonId: string;
  password: string;
  intervalMinutes: number;
  inboundIntervalMinutes?: number;
  staff: MinimoStaffMapping[];
};

function invalid(): never { throw new Error("Invalid Minimo configuration"); }
const stores = new Set(["kyoto", "osaka", "nagoya", "wakayama"]);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : invalid();
const identifier = (value: unknown): string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\s\u0000-\u0008\u000e-\u001f\u007f]/.test(value)
    ? value : invalid();
const keys = (value: Record<string, unknown>, allowed: string[]): void => {
  if (Object.keys(value).some((name) => !allowed.includes(name))) invalid();
};

export function parseMinimoConfig(env: {
  MINIMO_SYNC_MODE?: string;
  MINIMO_ACCOUNTS_JSON?: string;
  MINIMO_SESSION_KEY?: string;
}): { mode: "off" | "preview" | "apply"; accounts: MinimoAccount[]; sessionKey: string } {
  const mode = env.MINIMO_SYNC_MODE;
  if (mode === undefined || mode === "" || mode === "off") {
    return { mode: "off", accounts: [], sessionKey: "" };
  }
  if (mode !== "preview" && mode !== "apply") invalid();
  const sessionKey = env.MINIMO_SESSION_KEY;
  try {
    if (typeof sessionKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(sessionKey)
      || atob(sessionKey).length !== 32 || btoa(atob(sessionKey)) !== sessionKey) invalid();
  } catch { invalid(); }
  const raw = env.MINIMO_ACCOUNTS_JSON;
  if (typeof raw !== "string" || raw.length > 65_536) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { invalid(); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 4) invalid();
  const seenStores = new Set<string>();
  const seenSalons = new Set<string>();
  const seenResources = new Set<string>();
  const accounts = parsed.map((value): MinimoAccount => {
    const row = object(value);
    keys(row, ["storeId", "salonId", "password", "intervalMinutes", "inboundIntervalMinutes", "staff"]);
    const storeId = identifier(row.storeId);
    const salonId = identifier(row.salonId);
    if (!stores.has(storeId) || seenStores.has(storeId) || seenSalons.has(salonId)) invalid();
    seenStores.add(storeId);
    seenSalons.add(salonId);
    const password = row.password;
    if (typeof password !== "string" || !password.trim() || password.length > 1024
      || /[\u0000-\u001f\u007f]/.test(password)) invalid();
    const intervalMinutes = row.intervalMinutes === undefined ? 30 : row.intervalMinutes;
    if (typeof intervalMinutes !== "number" || !Number.isInteger(intervalMinutes)
      || intervalMinutes < 10 || intervalMinutes > 1440) invalid();
    const inboundIntervalMinutes = row.inboundIntervalMinutes === undefined ? 10 : row.inboundIntervalMinutes;
    if (typeof inboundIntervalMinutes !== "number" || !Number.isInteger(inboundIntervalMinutes)
      || inboundIntervalMinutes < 10 || inboundIntervalMinutes > 1440) invalid();
    if (!Array.isArray(row.staff) || row.staff.length < 1 || row.staff.length > 20) invalid();
    const seenStaff = new Set<string>();
    const staff = row.staff.map((value): MinimoStaffMapping => {
      const mapping = object(value);
      keys(mapping, ["rimaUserId", "resourceId", "maxDurationMinutes"]);
      const rimaUserId = identifier(mapping.rimaUserId);
      const resourceId = identifier(mapping.resourceId);
      const maxDurationMinutes = mapping.maxDurationMinutes;
      if (seenStaff.has(rimaUserId) || seenResources.has(resourceId)
        || typeof maxDurationMinutes !== "number" || !Number.isInteger(maxDurationMinutes)
        || maxDurationMinutes < 5 || maxDurationMinutes > 720 || maxDurationMinutes % 5 !== 0) invalid();
      seenStaff.add(rimaUserId);
      seenResources.add(resourceId);
      return { rimaUserId, resourceId, maxDurationMinutes };
    });
    return { storeId, salonId, password, intervalMinutes, inboundIntervalMinutes, staff };
  });
  return { mode, accounts, sessionKey: sessionKey! };
}

export function minimoConnectionHash(account: MinimoAccount): Promise<string> {
  return sha256Hex(JSON.stringify({ salonId: account.salonId,
    staff: account.staff.map(({ rimaUserId, resourceId }) => ({ rimaUserId, resourceId }))
      .sort((a, b) => a.rimaUserId.localeCompare(b.rimaUserId)) }));
}
