import { afterEach, expect, it, vi } from "vitest";
import { createMinimoRequestPacer, MinimoClient } from "../src/minimo/client";

afterEach(() => vi.useRealTimers());
const account = { storeId: "kyoto", salonId: "synthetic", password: "synthetic", intervalMinutes: 30, staff: [] };

it("spaces requests across clients sharing one provider budget", async () => {
  vi.useFakeTimers({ now: 10000 });
  const starts: number[] = [];
  const pace = createMinimoRequestPacer();
  const fetchImpl: typeof fetch = async () => {
    starts.push(Date.now());
    return Response.json({ current_account: { salon_id: account.salonId } });
  };
  const one = new MinimoClient({ account, pace, fetchImpl, cookie: "minimo_salontool=one" });
  const two = new MinimoClient({ account, pace, fetchImpl, cookie: "minimo_salontool=two" });
  const work = Promise.all([one.getAccount(), two.getAccount()]);
  await vi.advanceTimersByTimeAsync(1000);
  await work;
  expect(starts).toEqual([10000, 11000]);
});

it("does not dispatch a paced request after its lease deadline", async () => {
  vi.useFakeTimers({ now: 10000 });
  const fetchImpl = vi.fn(async () => Response.json({ current_account: { salon_id: account.salonId } }));
  const client = new MinimoClient({ account, fetchImpl, cookie: "minimo_salontool=one" });
  await client.getAccount(20000);
  const pending = expect(client.getSchedule("2026-10-01", 10500)).rejects.toMatchObject({ code: "aborted" });
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
