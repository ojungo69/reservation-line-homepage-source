import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { api, ApiError } from "./api-client";

describe("api client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("GET sends JSON accept headers and same-origin credentials", async () => {
    const body = { ok: true, value: 42 };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(api.get("/api/value")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/value", {
      signal: expect.any(AbortSignal),
      headers: { Accept: "application/json" },
      body: undefined,
      credentials: "same-origin",
    });
  });

  it("POST serializes a defined body and adds Content-Type", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = { name: "山田", nested: { enabled: true } };

    await api.post("/api/items", body);

    expect(fetchMock).toHaveBeenCalledWith("/api/items", {
      method: "POST",
      signal: expect.any(AbortSignal),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  });

  it("POST without a body omits Content-Type and serialized body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.post("/api/sync")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/sync", {
      method: "POST",
      signal: expect.any(AbortSignal),
      headers: { Accept: "application/json" },
      body: undefined,
      credentials: "same-origin",
    });
  });

  it.each([
    ["put", "PUT"],
    ["patch", "PATCH"],
  ] as const)("%s uses the matching HTTP method", async (method, verb) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await api[method]("/api/items/1", { active: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/items/1",
      expect.objectContaining({
        method: verb,
        body: '{"active":false}',
      }),
    );
  });

  it("DELETE uses DELETE without a request body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await api.delete("/api/items/1");

    expect(fetchMock).toHaveBeenCalledWith("/api/items/1", {
      method: "DELETE",
      signal: expect.any(AbortSignal),
      headers: { Accept: "application/json" },
      body: undefined,
      credentials: "same-origin",
    });
  });

  it("returns undefined for 204 without attempting to parse JSON", async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);

    await expect(api.get("/api/empty")).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it("throws ApiError with the parsed non-ok response body", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, reason: "forbidden" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const error = await api.get("/api/private").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API error 403",
      status: 403,
      body: { ok: false, reason: "forbidden" },
    });
  });

  it("uses a null body when a non-ok response is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("gateway failure", { status: 502 }),
    );

    await expect(api.get("/api/broken")).rejects.toMatchObject({
      status: 502,
      body: null,
    });
  });

  it("propagates fetch failures without wrapping them", async () => {
    const error = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(error);

    await expect(api.get("/api/admin/offline")).rejects.toBe(error);
  });

  it.each(["GET", "POST"])("intercepts an opaque Access redirect before following a protected %s request", async (method) => {
    const response = Response.error();
    Object.defineProperty(response, "type", { value: "opaqueredirect" });
    fetchMock.mockResolvedValue(response);
    const result = method === "GET" ? api.get("/api/admin/me") : api.post("/api/admin/action", { value: 1 });
    await expect(result).rejects.toMatchObject({ name: "ApiError", status: 401, body: null });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "manual", credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not apply the protected-API redirect contract to public requests", async () => {
    const response = Response.error();
    Object.defineProperty(response, "type", { value: "opaqueredirect" });
    fetchMock.mockResolvedValue(response);
    await expect(api.get("/api/public/options")).rejects.toMatchObject({ status: 0 });
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBeUndefined();
  });

  it("does not call a non-redirected HTML response an auth failure", async () => {
    const response = new Response("<html>unrelated response</html>", { headers: { "Content-Type": "text/html" } });
    fetchMock.mockResolvedValue(response);
    const error = await api.get("/api/admin/me").catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it("preserves a normal protected JSON response with manual redirect handling", async () => {
    const response = Response.json({ ok: true });
    fetchMock.mockResolvedValue(response);
    await expect(api.get("/api/admin/me")).resolves.toEqual({ ok: true });
  });

  it("keeps the read deadline active until the response body finishes", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_path, options) => {
      const stream = new ReadableStream({
        start(controller) {
          options?.signal?.addEventListener("abort", () => controller.error(options.signal?.reason));
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/json" } });
    });
    const result = api.get("/api/slow-body").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject({ name: "TimeoutError" });
  });

  it("honors caller cancellation and releases the read deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    fetchMock.mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
    }));
    const result = api.get("/api/cancel", { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["network", "body"])("marks a lost write %s response as an unknown outcome without retrying", async (failure) => {
    if (failure === "network") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    else fetchMock.mockResolvedValue(new Response("incomplete JSON", { status: 200 }));
    await expect(api.post("/api/items", { value: 1 })).rejects.toMatchObject({ name: "ApiOutcomeUnknownError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["headers", "body"])("bounds a stalled write %s response and returns an unknown outcome", async (phase) => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_path, options) => {
      if (phase === "headers") {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          options?.signal?.addEventListener("abort", () => controller.error(options.signal?.reason));
        },
      }), { status: 200 });
    });
    const result = api.post("/api/items", { idempotencyKey: "same-key" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toBe("still pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject({
      name: "ApiOutcomeUnknownError", cause: { name: "TimeoutError" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["read cancellation", "read timeout", "write timeout"])("preserves %s while reading a non-2xx body", async (scenario) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    fetchMock.mockImplementation(async (_path, options) => new Response(new ReadableStream({
      start(controller) {
        options?.signal?.addEventListener("abort", () => controller.error(options.signal?.reason));
      },
    }), { status: 503 }));
    const result = (scenario === "write timeout"
      ? api.post("/api/items", { idempotencyKey: "same-key" })
      : api.get("/api/items", { signal: caller.signal })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    if (scenario === "read cancellation") caller.abort();
    await vi.advanceTimersByTimeAsync(scenario === "write timeout" ? 30_000 : 15_000);
    expect(await result).toMatchObject(scenario === "write timeout"
      ? { name: "ApiOutcomeUnknownError", cause: { name: "TimeoutError" } }
      : { name: scenario === "read cancellation" ? "AbortError" : "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure", "cancel", "pre-aborted"])("supports %s without AbortSignal.any and releases caller listeners", async (settlement) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    try {
      if (settlement === "pre-aborted") caller.abort();
      if (settlement === "cancel") {
        fetchMock.mockImplementation((_path, options) => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
        }));
      } else if (settlement === "failure") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      else fetchMock.mockResolvedValue(Response.json({ ok: true }));
      const result = api.get("/api/admin/me", { signal: caller.signal }).catch((error: unknown) => error);
      if (settlement === "cancel") caller.abort();
      expect(await result).toMatchObject(settlement === "success" ? { ok: true }
        : { name: settlement === "failure" ? "TypeError" : "AbortError" });
      if (settlement === "pre-aborted") expect(fetchMock).not.toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      Object.defineProperty(AbortSignal, "any", anyDescriptor);
    }
  });
});
