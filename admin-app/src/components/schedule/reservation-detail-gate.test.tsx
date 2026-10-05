import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AuthContext } from "@/providers/auth-context";
import { createQueryWrapper, createTestQueryClient } from "@/test-utils/query-client";
import { ReservationDetailPanel } from "./reservation-detail-panel";

afterEach(() => vi.unstubAllGlobals());

it.each(["opening", "saving", "network"])("staff can recover the %s approval boundary without losing the notes draft", async (when) => {
  let approved = when === "saving";
  let expireOnSave = when === "saving";
  let failedRead = when === "network";
  let saved: unknown;
  const fetchMock = vi.fn<typeof fetch>(async (path, options) => {
    switch (String(path)) {
      case "/api/admin/reservations/reservation-1":
        return Response.json({ ok: true, reservation: {
          id: "reservation-1", customerId: "customer-1", customerDisplayName: "予約 花子",
          status: "completed", source: "admin", storeId: "store-1", storeName: "本店",
          serviceName: "基本メニュー", resourceName: "担当A", lineFriendStatus: null,
          startAt: "2026-09-29T10:00:00+09:00", endAt: "2026-09-29T11:00:00+09:00",
          visits: [{ id: "visit-1", status: "valid", visitedAt: "2026-09-29", treatmentNotes: "既存メモ" }],
        } });
      case "/api/admin/customers/customer-1":
        if (failedRead) {
          failedRead = false;
          throw new TypeError("Failed to fetch");
        }
        return approved ? Response.json({ ok: true, customer: {} })
          : Response.json({ ok: false, reason: "customer_gate_required" }, { status: 403 });
      case "/api/admin/customer-gate/request":
        return Response.json({ ok: true, challengeId: "challenge-1", expiresAt: "2026-09-29T12:10:00Z" });
      case "/api/admin/customer-gate/verify":
        approved = true;
        return Response.json({ ok: true, grantedUntil: "2026-09-30T00:00:00Z" });
      case "/api/admin/customers/customer-1/visits/visit-1/notes":
        if (expireOnSave) {
          expireOnSave = false;
          approved = false;
          return Response.json({ ok: false, reason: "customer_gate_required" }, { status: 403 });
        }
        saved = JSON.parse(String(options?.body));
        return Response.json({ ok: true });
      default:
        throw new Error(`Unexpected path: ${path}`);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <AuthContext value={{ user: { email: "staff@example.invalid", role: "staff", storeId: "store-1", staffMemberId: null }, isPrivileged: false, vapidPublicKey: "" }}>
      <ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />
    </AuthContext>,
    { wrapper: createQueryWrapper(createTestQueryClient()) },
  );
  await user.click(await screen.findByRole("button", { name: "編集" }));
  await user.type(screen.getByRole("textbox", { name: "施術メモ" }), "・下書き");
  if (when === "saving") {
    await waitFor(() => expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "保存" }));
  }
  if (when === "network") {
    expect(await screen.findByText(/保存に必要な承認を確認できません/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "承認を再確認" }));
  }
  expect(await screen.findByText(/施術メモの保存には/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: /施術メモの保存には/, level: 5 })).toBeTruthy();
  expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  expect(saved).toBeUndefined();
  await user.click(screen.getByRole("button", { name: "確認コードを送る" }));
  await user.type(await screen.findByRole("textbox", { name: "確認コード" }), "123456");
  await user.click(screen.getByRole("button", { name: "確認して編集を続ける" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("textbox", { name: "施術メモ" }) as HTMLTextAreaElement).value).toBe("既存メモ・下書き");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(saved).toEqual({ treatmentNotes: "既存メモ・下書き", expectedTreatmentNotes: "既存メモ" }));
});
