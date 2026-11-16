import { parseDateJstToUtcIso } from "../date-parse";
import type { MinimoAccount } from "./config";
import { formatMinimoDateTimeJst, MinimoDurationMismatch, parseMinimoIdentifier, parseMinimoSchedule, type MinimoSchedule } from "./schedule";
import { parseMinimoBookableMenuDurations, parseMinimoReservationDetail, parseMinimoReservationPage, parseMinimoStaffIds,
  type MinimoReservationIndex, type MinimoReservationPage } from "./reservations";

const origin = "https://minimodel.jp";
const loginPath = "/salontool/login";
const accountsPath = "/api/v1/salontool/accounts";
const schedulePath = "/api/v1/salontool/schedule";
const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

export type MinimoRequestPacer = (signal: AbortSignal) => Promise<void>;

/** A shared run budget avoids bursts across salon clients; this is not a provider quota. */
export function createMinimoRequestPacer(): MinimoRequestPacer {
  let next = 0;
  return async (signal) => {
    signal.throwIfAborted();
    const start = Math.max(Date.now(), next);
    next = start + 1000;
    const delay = start - Date.now();
    if (delay <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, delay);
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
  };
}

export class MinimoClientError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterMs: number | null = null) {
    super(code);
    this.name = "MinimoClientError";
  }
}

function retryAfter(value: string | null, now: number): number {
  const seconds = value && /^\d{1,12}$/.test(value.trim()) ? Number(value) : null;
  const date = seconds === null && value ? Date.parse(value) : Number.NaN;
  const delay = seconds !== null ? seconds * 1000 : date - now;
  // Preserve longer upstream cooldowns; a 24-hour cap could trigger an early retry.
  return Math.max(600_000, Number.isFinite(delay) ? delay : 0);
}

async function boundedText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new MinimoClientError("body_too_large", response.status);
  }
  signal.throwIfAborted();
  if (!response.body) return "";
  const reader = response.body.getReader();
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  let bytes = 0;
  const buffer = new Uint8Array(limit);
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (bytes + value.byteLength > limit) throw new MinimoClientError("body_too_large", response.status);
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
    signal.throwIfAborted();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function csrfToken(html: string, cookie: string | undefined): string | null {
  for (const input of html.matchAll(/<input\b[^>]{0,4096}>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of input[0].matchAll(/\b(name|value)\s*=\s*(["'])(.*?)\2/gi)) {
      attributes.set(attribute[1].toLowerCase(), attribute[3]);
    }
    if (attributes.get("name") === "csrf_token") {
      const value = attributes.get("value");
      if (value && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    }
  }
  if (cookie) {
    try {
      const value = cookie.split(".")[0].replaceAll("-", "+").replaceAll("_", "/");
      const decoded = JSON.parse(atob(value.padEnd(Math.ceil(value.length / 4) * 4, "="))) as { csrf_token?: unknown };
      if (typeof decoded.csrf_token === "string" && decoded.csrf_token && decoded.csrf_token.length <= 1024
        && !/[\u0000-\u001f\u007f]/.test(decoded.csrf_token)) return decoded.csrf_token;
    } catch { /* An unusable CSRF cookie must not authenticate the session. */ }
  }
  return null;
}

function parseSetCookie(line: string, status: number): { name: string; value: string; attributes: string[] } {
  if (line.length > 4096 || /[\u0000-\u001f\u007f]/.test(line)) {
    throw new MinimoClientError("invalid_response", status);
  }
  const [pair, ...attributes] = line.split(";");
  const equals = pair.indexOf("=");
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (equals < 1 || name.length > 128 || !cookieName.test(name) || !cookieValue.test(value)) {
    throw new MinimoClientError("invalid_response", status);
  }
  return { name, value, attributes };
}

function cookieAttributes(attributes: string[], status: number): { maxAge: number | null; expires: number | null } {
  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const attribute of attributes) {
    const separator = attribute.indexOf("=");
    const attributeName = attribute.slice(0, separator < 0 ? undefined : separator).trim().toLowerCase();
    const attributeValue = separator < 0 ? "" : attribute.slice(separator + 1).trim();
    if (attributeName === "max-age" && /^-?\d+$/.test(attributeValue)) maxAge = Number(attributeValue);
    if (attributeName === "expires" && Number.isFinite(Date.parse(attributeValue))) expires = Date.parse(attributeValue);
    if (attributeName === "domain" && !["minimodel.jp", ".minimodel.jp"].includes(attributeValue.toLowerCase())) {
      throw new MinimoClientError("invalid_response", status);
    }
  }
  return { maxAge, expires };
}

function validateLoginRedirect(response: Response, method: string | undefined, login: boolean): void {
  const location = response.headers.get("location");
  const destination = location ? new URL(location, origin) : null;
  if (!login || method !== "POST" || ![302, 303].includes(response.status)
    || destination?.origin !== origin || destination.pathname !== "/salontool/home"
    || destination.search || destination.hash || destination.username || destination.password) {
    throw new MinimoClientError("redirect", response.status);
  }
}

function validateChallenge(response: Response, text: string, login: boolean): void {
  // The live login form includes this empty, inactive badge placeholder.
  // An iframe/script or any content in it remains subject to the challenge stop.
  const inspected = login ? text.replace(/<div\s+id=["']JS_inline_recaptcha["']\s+class=["']recaptcha-badge["']\s*>\s*<\/div>/g, "") : text;
  if ((login || response.headers.get("content-type")?.includes("text/html") || text.trimStart().startsWith("<"))
    && /(?:captcha|cf-chl|challenge-platform)/i.test(inspected)) throw new MinimoClientError("challenge", response.status);
}

export class MinimoClient {
  private readonly account: MinimoAccount;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly signal?: AbortSignal;
  private readonly pace: MinimoRequestPacer;
  private readonly cookies = new Map<string, string>();
  private reauthenticated = false;
  private stopped: MinimoClientError | null = null;
  private verifiedAccount: { salonId: string; name: string | null } | null = null;

  constructor(options: {
    account: MinimoAccount;
    fetchImpl?: typeof fetch;
    now?: () => number;
    cookie?: string;
    signal?: AbortSignal;
    pace?: MinimoRequestPacer;
  }) {
    this.account = options.account;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.signal = options.signal;
    this.pace = options.pace ?? createMinimoRequestPacer();
    if (options.cookie !== undefined) {
      if (!options.cookie || options.cookie.length > 4096) throw new MinimoClientError("invalid_session", 0);
      for (const part of options.cookie.split("; ")) {
        const equals = part.indexOf("=");
        const name = part.slice(0, equals);
        const value = part.slice(equals + 1);
        if (equals < 1 || !cookieName.test(name) || name.length > 128 || !value
          || !cookieValue.test(value) || this.cookies.has(name) || this.cookies.size >= 20) {
          throw new MinimoClientError("invalid_session", 0);
        }
        this.cookies.set(name, value);
      }
      if (!this.sessionCookie) throw new MinimoClientError("invalid_session", 0);
    }
  }

  get sessionCookie(): string | null {
    return this.cookies.has("minimo_salontool") ? this.cookieHeader() : null;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private absorb(response: Response): void {
    const previousCookie = this.sessionCookie;
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie()
      : (headers.get("set-cookie") ?? "").split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
    if (lines.length > 20) throw new MinimoClientError("invalid_response", response.status);
    for (const line of lines) {
      if (!line) continue;
      const { name, value, attributes } = parseSetCookie(line, response.status);
      const { maxAge, expires } = cookieAttributes(attributes, response.status);
      const deleted = !value || (maxAge === null ? expires !== null && expires <= this.now() : maxAge <= 0);
      if (deleted) this.cookies.delete(name);
      else this.cookies.set(name, value);
      if (this.cookies.size > 20 || this.cookieHeader().length > 4096) {
        throw new MinimoClientError("invalid_response", response.status);
      }
    }
    if (this.sessionCookie !== previousCookie) this.verifiedAccount = null;
  }

  private validateStatus(response: Response, method: string | undefined, login: boolean): void {
    if (response.status === 429) throw new MinimoClientError("rate_limited", 429, retryAfter(response.headers.get("retry-after"), this.now()));
    if (response.headers.get("cf-mitigated") === "challenge") throw new MinimoClientError("challenge", response.status);
    if (response.status === 403) throw new MinimoClientError("forbidden", 403);
    if (response.redirected) throw new MinimoClientError("redirect", response.status);
    if (response.status >= 300 && response.status < 400) validateLoginRedirect(response, method, login);
    else if (response.status === 401) throw new MinimoClientError("auth_failed", 401);
    else if (response.status !== (method === "POST" && !login ? 204 : 200)) {
      throw new MinimoClientError(login ? "auth_failed" : "invalid_response", response.status);
    }
  }

  private requestError(error: unknown, response: Response | undefined, signal: AbortSignal, deadlineLimited: boolean): MinimoClientError {
    if (error instanceof MinimoClientError) return error;
    if (signal.aborted) return new MinimoClientError(this.signal?.aborted || deadlineLimited ? "aborted" : "timeout", response?.status ?? 0);
    return new MinimoClientError(response ? "invalid_response" : "network_error", response?.status ?? 0);
  }

  private async request(path: string, init: RequestInit, login = false, deadlineMs?: number): Promise<{ response: Response; text: string }> {
    const remaining = deadlineMs === undefined ? 10_000 : deadlineMs - this.now();
    if (!Number.isFinite(remaining) || remaining < 1) throw new MinimoClientError("aborted", 0);
    const deadlineLimited = deadlineMs !== undefined && remaining <= 10_000;
    const timeout = AbortSignal.timeout(Math.min(10_000, Math.floor(remaining)));
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      await this.pace(signal);
      signal.throwIfAborted();
      if (deadlineMs !== undefined && this.now() >= deadlineMs) throw new MinimoClientError("aborted", 0);
      response = await this.fetchImpl(`${origin}${path}`, { ...init, redirect: "manual", signal });
      this.validateStatus(response, init.method, login);
      const text = await boundedText(response, login ? 262_144 : 1_048_576, signal);
      signal.throwIfAborted();
      if (deadlineMs !== undefined && this.now() >= deadlineMs) throw new MinimoClientError("aborted", response.status);
      validateChallenge(response, text, login);
      this.absorb(response);
      return { response, text };
    } catch (error) {
      void response?.body?.cancel().catch(() => {});
      throw this.requestError(error, response, signal, deadlineLimited);
    }
  }

  private async login(deadlineMs?: number): Promise<void> {
    const { text } = await this.request(loginPath, { method: "GET", headers: { Accept: "text/html" } }, true, deadlineMs);
    const csrf = csrfToken(text, this.cookies.get("minimo"));
    if (!csrf) throw new MinimoClientError("auth_failed", 200);
    await this.request(loginPath, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html",
        Cookie: this.cookieHeader(), Origin: origin, Referer: `${origin}${loginPath}` },
      body: new URLSearchParams({ salon_id: this.account.salonId, password: this.account.password, csrf_token: csrf })
    }, true, deadlineMs);
    if (!this.sessionCookie) throw new MinimoClientError("auth_failed", 200);
  }

  private async scheduleRequest(path: string, method: "GET" | "POST", body?: string, deadlineMs?: number): Promise<{ response: Response; text: string }> {
    if (this.stopped) throw this.stopped;
    if (!this.sessionCookie) {
      await this.login(deadlineMs);
      if (path !== accountsPath) await this.verifyAccount(deadlineMs);
    }
    const send = () => this.request(path, { method, body, headers: {
      Accept: "application/json", "X-From": `${origin}/salontool/home`, Origin: origin,
      Referer: `${origin}/salontool/home`, Cookie: this.cookieHeader(),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {})
    } }, false, deadlineMs);
    try { return await send(); }
    catch (error) {
      if (!(error instanceof MinimoClientError) || error.status !== 401 || this.reauthenticated) throw error;
      this.reauthenticated = true;
      this.cookies.clear();
      this.verifiedAccount = null;
      await this.login(deadlineMs);
      if (path !== accountsPath) await this.verifyAccount(deadlineMs);
      return send();
    }
  }

  private async verifyAccount(deadlineMs?: number): Promise<{ salonId: string; name: string | null }> {
    if (this.stopped) throw this.stopped;
    if (this.verifiedAccount) return this.verifiedAccount;
    const { text, response } = await this.scheduleRequest(accountsPath, "GET", undefined, deadlineMs).catch(error => {
      if (error instanceof MinimoClientError && error.status === 404) throw new MinimoClientError("account_unavailable", 404);
      throw error;
    });
    let current: { salon_id?: unknown; name?: unknown } | undefined;
    try { current = JSON.parse(text)?.current_account; }
    catch { throw new MinimoClientError("invalid_response", response.status); }
    if (!current || typeof current.salon_id !== "string" || !current.salon_id || current.salon_id.length > 128) {
      throw new MinimoClientError("invalid_response", response.status);
    }
    if (current.salon_id !== this.account.salonId) throw new MinimoClientError("account_mismatch", response.status);
    if (!this.sessionCookie) throw new MinimoClientError("invalid_session", response.status);
    this.verifiedAccount = { salonId: current.salon_id, name: typeof current.name === "string" ? current.name : null };
    return this.verifiedAccount;
  }

  async getAccount(deadlineMs?: number): Promise<{ salonId: string; name: string | null }> {
    try { return await this.verifyAccount(deadlineMs); }
    catch (error) { return this.fail(error); }
  }

  private fail(error: unknown): never {
    this.stopped = error instanceof MinimoClientError ? error : new MinimoClientError("invalid_response", 0);
    throw this.stopped;
  }

  private async readProtocol<T>(path: string, parse: (value: unknown) => T, deadlineMs?: number): Promise<T> {
    await this.verifyAccount(deadlineMs);
    const { text, response } = await this.scheduleRequest(path, "GET", undefined, deadlineMs);
    try { return parse(JSON.parse(text)); }
    catch (error) { throw new MinimoClientError(error instanceof MinimoDurationMismatch ? "duration_mismatch" : "invalid_response", response.status); }
  }

  async getReservationPage(page: number, deadlineMs?: number): Promise<MinimoReservationPage> {
    try {
      if (!Number.isInteger(page) || page < 1 || page > 100) throw new MinimoClientError("invalid_response", 0);
      const query = new URLSearchParams({ embed: "true", page: String(page), count: "100", exclude_statuses: "0,3,10,11,12" });
      return await this.readProtocol(`/api/v1/salontool/reservations?${query}`, value => parseMinimoReservationPage(value, page), deadlineMs);
    } catch (error) { return this.fail(error); }
  }

  async getReservation(id: string, deadlineMs?: number): Promise<MinimoReservationIndex | null> {
    try {
      if (parseMinimoIdentifier(id) !== id || id === "." || id === "..") throw new MinimoClientError("invalid_response", 0);
      return await this.readProtocol(`/api/v1/salontool/reservations/${encodeURIComponent(id)}?embed=true`,
        value => parseMinimoReservationDetail(value, id), deadlineMs);
    } catch (error) {
      if (error instanceof MinimoClientError && error.code === "invalid_response" && error.status === 404) return null;
      return this.fail(error);
    }
  }

  async getStaffIds(deadlineMs?: number): Promise<string[]> {
    try { return await this.readProtocol("/api/v1/salontool/staffs", parseMinimoStaffIds, deadlineMs); }
    catch (error) { return this.fail(error); }
  }

  async getBookableMenuDurations(staffId: string, deadlineMs?: number): Promise<number[]> {
    try {
      if (parseMinimoIdentifier(staffId) !== staffId || staffId === "." || staffId === "..") throw new MinimoClientError("invalid_response", 0);
      return await this.readProtocol(`/api/v1/salontool/staffs/${encodeURIComponent(staffId)}/recruitment/menus`, parseMinimoBookableMenuDurations, deadlineMs);
    } catch (error) { return this.fail(error); }
  }

  async getSchedule(date: string, deadlineMs?: number): Promise<MinimoSchedule> {
    try {
      if (!parseDateJstToUtcIso(date)) throw new MinimoClientError("invalid_response", 0);
      return await this.readProtocol(`${schedulePath}?date=${encodeURIComponent(date)}`, value => parseMinimoSchedule(value, date), deadlineMs);
    } catch (error) { return this.fail(error); }
  }

  async postSchedule(schedule: MinimoSchedule, deadlineMs?: number): Promise<void> {
    try {
      if (!parseDateJstToUtcIso(schedule.date) || !Array.isArray(schedule.entries) || schedule.entries.length > 200) {
        throw new MinimoClientError("invalid_response", 0);
      }
      const seenStaff = new Set<string>();
      const entries = schedule.entries.map((entry) => {
        if (typeof entry.staffId !== "string" || !entry.staffId || entry.staffId.length > 128
          || /[\s\u0000-\u0008\u000e-\u001f\u007f]/.test(entry.staffId) || seenStaff.has(entry.staffId)
          || !Array.isArray(entry.openSlots) || entry.openSlots.length > 288) throw new MinimoClientError("invalid_response", 0);
        seenStaff.add(entry.staffId);
        const slots = entry.openSlots.map((slot) => formatMinimoDateTimeJst(slot, schedule.date));
        if (new Set(slots).size !== slots.length) throw new MinimoClientError("invalid_response", 0);
        return { rima_user_id: entry.staffId, quick_reservation: slots };
      });
      const body = JSON.stringify({ date: schedule.date, entries });
      if (new TextEncoder().encode(body).length > 1_048_576) throw new MinimoClientError("body_too_large", 0);
      await this.verifyAccount(deadlineMs);
      await this.scheduleRequest(schedulePath, "POST", body, deadlineMs);
    } catch (error) { this.fail(error); }
  }
}
