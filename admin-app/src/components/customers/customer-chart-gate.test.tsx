import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { AuthContext } from "@/providers/auth-context";
import { createQueryWrapper, createTestQueryClient } from "@/test-utils/query-client";
import CustomersPage from "@/pages/customers";

vi.mock("@/hooks/use-stores", () => ({ useStores: () => ({ stores: [{ id: "store-1", name: "本店" }], selectedStoreId: "store-1", selectStore: vi.fn(), isStoreFixed: true }) }));
afterEach(() => vi.unstubAllGlobals());

it.each(["opening", "saving", "list-expiry"])("カルテの%s承認境界でも選択顧客と下書きを維持する", async (when) => {
  let approved = when !== "opening";
  let expireOnSave = when === "saving";
  let memo = "元の顧客メモ";
  let saved: unknown;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path, options) => {
    const uri = String(path);
    if (uri === "/api/admin/customer-gate/request") return Response.json({ ok: true, challengeId: "challenge-1", expiresAt: "2026-09-30T00:00:00Z" });
    if (uri === "/api/admin/customer-gate/verify") {
      approved = true;
      return Response.json({ ok: true, grantedUntil: "2026-09-30T12:00:00Z" });
    }
    if (!approved) return Response.json({ ok: false, reason: "customer_gate_required" }, { status: 403 });
    if (uri.startsWith("/api/admin/customers?")) return Response.json({ ok: true, customers: [], total: 0 });
    if (uri === "/api/admin/customers/customer-1") return Response.json({ ok: true, customer: {
      id: "customer-1", displayName: "承認 顧客", displayNameKana: null, phoneNormalized: null,
      blockStatus: "active", memo, referrerName: null, lastVisitAt: null, nextReservation: null,
      birthDate: null, gender: null, allergyNotes: null, archivedAt: null, lineIdentities: [],
      validVisitCount: 0, visits: [], reservations: [], reservationsNextOffset: null,
      consentHistory: [], consentHistoryNextOffset: null, duplicateConsentHistory: [],
    } });
    if (uri === "/api/admin/customers/customer-1/memo") {
      if (expireOnSave) {
        expireOnSave = false;
        approved = false;
        memo = "他担当の再承認前の更新";
        return Response.json({ ok: false, reason: "customer_gate_required" }, { status: 403 });
      }
      saved = JSON.parse(String(options?.body));
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected path: ${uri}`);
  }));
  const client = createTestQueryClient();
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={["/customers?customerId=customer-1"]}>
    <AuthContext value={{ user: { email: "staff@example.invalid", role: "staff", storeId: "store-1", staffMemberId: null }, isPrivileged: false, vapidPublicKey: "" }}>
      <CustomersPage />
    </AuthContext>
  </MemoryRouter>, { wrapper: createQueryWrapper(client) });
  const verify = async () => {
    await user.click(await screen.findByRole("button", { name: "確認コードを送る" }));
    await user.type(await screen.findByRole("textbox", { name: "確認コード" }), "123456");
    await user.click(screen.getByRole("button", { name: "顧客情報を開く" }));
    await screen.findByRole("heading", { name: "承認 顧客" });
  };
  if (when === "opening") {
    expect(screen.queryByRole("heading", { name: "承認 顧客" })).toBeNull();
    await verify();
  } else {
    await screen.findByRole("heading", { name: "承認 顧客" });
  }
  await user.click(screen.getByRole("button", { name: "編集" }));
  await user.type(screen.getByRole("textbox", { name: "顧客メモ" }), "・下書き");
  if (when === "saving") await user.click(screen.getByRole("button", { name: "保存" }));
  if (when === "list-expiry") {
    approved = false;
    memo = "他担当の再承認前の更新";
    await act(async () => { await client.invalidateQueries({ queryKey: ["customers", "list"] }); });
  }
  if (when !== "opening") {
    await screen.findByRole("button", { name: "確認コードを送る" });
    expect(screen.queryByRole("textbox", { name: "顧客メモ" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "承認 顧客" })).toBeNull();
    expect(saved).toBeUndefined();
    await verify();
  }
  expect((screen.getByRole("textbox", { name: "顧客メモ" }) as HTMLTextAreaElement).value).toBe("元の顧客メモ・下書き");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(saved).toEqual({ memo: "元の顧客メモ・下書き", expectedMemo: "元の顧客メモ" }));
});
