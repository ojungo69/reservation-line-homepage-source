export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
    this.name = "ApiError";
  }
}

export class ApiOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("API write outcome is unknown", { cause });
    this.name = "ApiOutcomeUnknownError";
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers: extraHeaders, ...rest } = options;
  const isAdminRequest = path.startsWith("/api/admin/");

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(extraHeaders as Record<string, string>),
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;
  const isRead = !rest.method || rest.method === "GET";
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("API request timed out", "TimeoutError")),
    isRead ? 15_000 : 30_000,
  );
  const signal = deadline.signal;
  const onCallerAbort = () => deadline.abort(rest.signal?.reason);
  if (rest.signal?.aborted) onCallerAbort();
  else rest.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    const response = await fetch(path, {
      ...rest,
      ...(isAdminRequest && { redirect: "manual" as const }),
      signal,
      headers,
      body: serializedBody,
      credentials: "same-origin",
    });

    // Admin API contracts never redirect. Stop Access redirects here before following
    // them into a cross-origin CORS failure; no login URL or HTML needs to be read.
    if (isAdminRequest && response.type === "opaqueredirect") throw new ApiError(401, null);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => {
        if (signal.aborted) throw signal.reason;
        return null;
      });
      throw new ApiError(response.status, errorBody);
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    // A write may have committed before its response was lost. Never retry it here.
    if (!isRead && !(error instanceof ApiError)) throw new ApiOutcomeUnknownError(error);
    throw error;
  } finally {
    clearTimeout(timer);
    rest.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export const api = {
  get: <T>(path: string, options?: Pick<RequestOptions, "signal">) => request<T>(path, options),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
