import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerDetail } from "@/types/api";
import { ApiError } from "@/lib/api-client";

const blockCustomer = vi.fn();
const archiveCustomer = vi.fn();
const noOpMutation = vi.fn();
const refetchCustomer = vi.fn();
const loadVisitsPageAsync = vi.fn();
// 「さらに読み込む」で引く続きのページ。既定は 1 ページで終わり。
let loadVisitsPage = vi.fn();
let loadConsentsPage = vi.fn();
let loadReservationsPage = vi.fn();
let consentsPagePending = false;
let customer: CustomerDetail;
let privileged = true;

const navigateMock = vi.fn();

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isPrivileged: privileged }),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({
    stores: [{ id: "store-1", name: "新宿店" }],
  }),
}));

vi.mock("@/hooks/use-customers", () => ({
  useCustomerDetail: () => ({
    data: { ok: true, customer },
    isPending: false,
    isError: false,
    refetch: refetchCustomer,
  }),
  useCustomerReservationsPage: () => ({ mutate: loadReservationsPage, isPending: false }),
  useCustomerVisitsPage: () => ({ mutate: loadVisitsPage, mutateAsync: loadVisitsPageAsync, isPending: false }),
  useCustomerConsentsPage: () => ({ mutate: loadConsentsPage, isPending: consentsPagePending }),
  useCustomerReferrerUpdate: () => ({ mutate: noOpMutation, isPending: false }),
  useCustomerMemoUpdate: () => ({ mutate: noOpMutation, isPending: false }),
  useCustomerProfileUpdate: () => ({ mutate: noOpMutation, isPending: false }),
  useCustomerBlockAction: () => ({ mutate: blockCustomer, isPending: false }),
  useCustomerArchiveAction: () => ({ mutate: archiveCustomer, isPending: false }),
  useVisitNotesUpdate: () => ({ mutate: noOpMutation, isPending: false }),
  useAddCustomerVisit: () => ({ mutate: noOpMutation, isPending: false }),
  useUpdateCustomerVisit: () => ({ mutate: noOpMutation, isPending: false }),
  useDeleteCustomerVisit: () => ({ mutate: noOpMutation, isPending: false }),
  useCustomerDelete: () => ({ mutate: noOpMutation, isPending: false }),
}));

vi.mock("@/components/schedule/reservation-detail-panel", () => ({ ReservationDetailPanel: () => null }));

vi.mock("@/components/customers/link-line-from-card-dialog", () => ({
  LinkLineFromCardDialog: () => null,
}));

import { CustomerDetailPanel } from "./customer-detail-panel";

function LayoutSnapshot({ children, onSnapshot }: Readonly<{
  children: ReactNode;
  onSnapshot: (text: string) => void;
}>) {
  useLayoutEffect(() => {
    onSnapshot(document.body.textContent ?? "");
  });
  return children;
}

beforeEach(() => {
  blockCustomer.mockReset();
  archiveCustomer.mockReset();
  noOpMutation.mockReset();
  refetchCustomer.mockReset();
  loadVisitsPageAsync.mockReset();
  refetchCustomer.mockImplementation(async () => ({ data: { ok: true, customer } }));
  navigateMock.mockReset();
  loadVisitsPage = vi.fn();
  loadReservationsPage = vi.fn();
  loadConsentsPage = vi.fn();
  consentsPagePending = false;
  privileged = true;
  blockCustomer.mockImplementation((_input, options) => options?.onSuccess?.());
  archiveCustomer.mockImplementation((_input, options) => options?.onSuccess?.());
  customer = {
    id: "customer-1",
    displayName: "顧客 花子",
    displayNameKana: "コキャク ハナコ",
    phoneNormalized: "09012345678",
    blockStatus: "active",
    memo: null,
    birthDate: null,
    gender: null,
    allergyNotes: null,
    archivedAt: null,
    lineIdentities: [],
    validVisitCount: 0,
    visits: [],
    reservations: [],
    consentHistory: [],
    consentHistoryNextOffset: null,
    duplicateConsentHistory: [],
  };
});

describe("CustomerDetailPanel の書きかけ保護", () => {
  const withVisit = (treatmentNotes: string | null) => ({
    ...customer,
    visits: [{
      id: "visit-1",
      reservationId: null,
      storeId: "store-1",
      visitedAt: "2026-07-23",
      visitSource: "manual_import" as const,
      status: "valid" as const,
      treatmentNotes,
      recordedBy: "オーナー",
    }],
  });

  // 保存済みのカルテを全選択して消し、そのまま保存すると無確認で消えていた。
  it("保存済みの施術メモを空にして保存しようとすると確認を挟む", async () => {
    const user = userEvent.setup();
    customer = withVisit("前回の施術内容");
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "メモ編集" }));
    await user.clear(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(noOpMutation).not.toHaveBeenCalled();
    expect(screen.getByText("施術メモを消しますか？")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "消して保存" }));
    expect(noOpMutation).toHaveBeenCalledWith(
      { customerId: "customer-1", visitId: "visit-1", treatmentNotes: null, expectedTreatmentNotes: "前回の施術内容" },
      expect.anything(),
    );
  });

  it("元から空のメモに書き足すときは確認を挟まない", async () => {
    const user = userEvent.setup();
    customer = withVisit(null);
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "メモ編集" }));
    await user.type(screen.getByRole("textbox"), "追記");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(noOpMutation).toHaveBeenCalledWith(
      { customerId: "customer-1", visitId: "visit-1", treatmentNotes: "追記", expectedTreatmentNotes: null },
      expect.anything(),
    );
  });

  it("書きかけの顧客メモがあるまま Esc を押しても閉じず、破棄を選んだときだけ閉じる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CustomerDetailPanel customerId="customer-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "書きかけ");
    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("書きかけの入力があります")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "破棄して閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // アーカイブは onSuccess で onClose() を直接呼ぶので、閉じる経路のガードを通らない。
  // ただし Esc / 外側クリックのような誤操作ではなく、確認を経た意図的な操作なので
  // 破棄確認は挟まない。代わりにその確認文の中で「消える」ことを伝える。
  it("書きかけがあるときはアーカイブの確認文で破棄されることを伝える", async () => {
    const user = userEvent.setup();
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "アーカイブ" }));
    expect(screen.queryByText(/編集中の内容は保存されずに破棄されます/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "書きかけ");
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));

    expect(screen.getByText(/編集中の内容は保存されずに破棄されます/)).toBeTruthy();
  });

  // 「次回予約」は onClose() を直接呼ぶので Radix の onOpenChange を通らない。
  // 閉じる経路だけ守っても、このボタンから書きかけが黙って消える。
  it("書きかけのまま「次回予約」を押しても遷移せず、破棄を選んだときだけ遷移する", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CustomerDetailPanel customerId="customer-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "書きかけ");
    await user.click(screen.getByRole("button", { name: "＋ 予約を追加" }));

    expect(navigateMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("書きかけの入力があります")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "破棄して閉じる" }));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("編集を開いただけで内容を変えていなければ Esc でそのまま閉じる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CustomerDetailPanel customerId="customer-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CustomerDetailPanel の混在バージョン耐性", () => {
  // ロールバックやデプロイ途中に、この項目を返さない Worker と話すことがある。
  // 欠けたまま出すと「記入:」だけのラベルになるので、Worker 側と同じ既定値を出す。
  it("recordedBy を返さない応答でも記入者欄が空にならない", () => {
    customer = {
      ...customer,
      visits: [{
        id: "visit-1",
        reservationId: null,
        storeId: "store-1",
        visitedAt: "2026-07-23",
        visitSource: "manual_import",
        status: "valid",
        treatmentNotes: null,
      } as CustomerDetail["visits"][number]],
    };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.getByText("登録: 不明")).toBeTruthy();
  });

  // 顧客を切り替えたあとに前の顧客の mutation が返ると、前の顧客の来店件数から
  // 次の offset を導いてしまい、いま開いている顧客の「さらに読み込む」が消える。
  it("前の顧客の来店 mutation が遅れて返ってもページングを壊さない", async () => {
    const user = userEvent.setup();
    // A は 1 件だけ。B は 1 ページぶんちょうどなので「さらに読み込む」が出る。
    const visit = (id: string) => ({
      id,
      reservationId: null,
      storeId: "store-1",
      visitedAt: "2026-07-23",
      visitSource: "manual_import" as const,
      status: "valid" as const,
      treatmentNotes: "既存メモ",
      recordedBy: "オーナー",
    });
    const customerA = { ...customer, id: "customer-1", visits: [visit("a-1")] };
    const customerB = {
      ...customer,
      id: "customer-2",
      visits: Array.from({ length: 50 }, (_, index) => visit(`b-${index}`)),
    };
    customer = customerA;

    // A の施術メモ保存を「まだ返ってこない」状態で保持する。
    let resolveNotes: (() => void) | undefined;
    noOpMutation.mockImplementation((_input, options) => {
      resolveNotes = () => options?.onSuccess?.();
    });

    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    const visitsSection = () =>
      within(screen.getByText(/^来店履歴 \(/).closest("div") as HTMLElement);
    await user.click(visitsSection().getAllByRole("button", { name: "メモ編集" })[0]);
    await user.type(visitsSection().getByRole("textbox"), "追記");
    await user.click(visitsSection().getByRole("button", { name: "保存" }));
    expect(resolveNotes).toBeTypeOf("function");

    // B へ切り替え。ここで「さらに読み込む」が出る。
    customer = customerB;
    view.rerender(<CustomerDetailPanel customerId="customer-2" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "さらに読み込む" })).toBeTruthy();

    // ここで A の保存が返る。ガードが無いと B の offset が A の 1 件から導かれ、
    // 「さらに読み込む」が消えて 51 件目以降が二度と読めなくなる。
    act(() => resolveNotes?.());
    expect(screen.getByRole("button", { name: "さらに読み込む" })).toBeTruthy();
  });
});

describe("CustomerDetailPanel", () => {
  it("保存済みの通常同意が無い状態を表示する", () => {
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.getByText("保存された同意記録はありません")).toBeTruthy();
  });

  it("同意履歴を含まない旧版の応答でも顧客詳細を表示する", () => {
    const { consentHistory: _history, consentHistoryNextOffset: _offset, ...legacyCustomer } = customer;
    customer = legacyCustomer;
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.getByText("顧客 花子")).toBeTruthy();
    expect(screen.getByText("同意履歴を表示できません。画面を更新してお試しください。")).toBeTruthy();
    expect(screen.queryByText("保存された同意記録はありません")).toBeNull();
  });

  it("通常同意の文書種別・版・日時を表示し、続きは id で重複除去する", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      consentHistory: [{
        id: "consent-1",
        type: "notice",
        version: "notice-2026-06",
        consentedAt: "2025-12-31T15:00:00.000Z",
      }],
      consentHistoryNextOffset: 50,
    };
    loadConsentsPage.mockImplementation((input, options) => {
      expect(input).toEqual({ customerId: "customer-1", offset: 50 });
      options?.onSuccess?.({
        ok: true,
        consents: [
          customer.consentHistory?.[0],
          {
            id: "consent-2",
            type: "privacy_policy",
            version: "privacy-2026-06",
            consentedAt: "2024-12-31T15:00:00.000Z",
          },
        ],
        nextOffset: null,
      });
    });
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.getByText("予約前確認事項")).toBeTruthy();
    expect(screen.getByText("notice-2026-06")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));

    expect(screen.getByText("2026年1月1日 (木) 00:00")).toBeTruthy();
    expect(screen.getByText("2025年1月1日 (水) 00:00")).toBeTruthy();
    expect(screen.getByText("プライバシーポリシー")).toBeTruthy();
    expect(screen.getByText("privacy-2026-06")).toBeTruthy();
    expect(screen.getAllByText("notice-2026-06")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "同意履歴をさらに読み込む" })).toBeNull();
  });

  it("通常同意の続きが失敗したら再試行できる失敗状態を表示する", async () => {
    const user = userEvent.setup();
    customer = { ...customer, consentHistoryNextOffset: 50 };
    loadConsentsPage.mockImplementation((_input, options) => options?.onError?.(new Error("failed")));
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));

    expect(screen.getByText("続きの同意履歴を読み込めませんでした。もう一度お試しください。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "同意履歴をさらに読み込む" })).toBeTruthy();
  });

  it("顧客を切り替えた後に届いた前の顧客の同意履歴を捨てる", async () => {
    const user = userEvent.setup();
    customer = { ...customer, consentHistoryNextOffset: 50 };
    let resolvePage: (() => void) | null = null;
    loadConsentsPage.mockImplementation((input, options) => {
      if (input.customerId === "customer-1") {
        resolvePage = () => options?.onSuccess?.({
          ok: true,
          consents: [{
            id: "consent-stale",
            type: "notice",
            version: "前の顧客の版",
            consentedAt: "2026-09-12T03:00:00.000Z",
          }],
          nextOffset: null,
        });
        return;
      }
      options?.onSuccess?.({
        ok: true,
        consents: [{
          id: "consent-b-extra",
          type: "privacy_policy",
          version: "Bの追加版",
          consentedAt: "2026-09-11T03:00:00.000Z",
        }],
        nextOffset: null,
      });
    });
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));

    customer = {
      ...customer,
      id: "customer-2",
      consentHistory: [{
        id: "consent-b",
        type: "notice",
        version: "Bの初期版",
        consentedAt: "2026-09-12T03:00:00.000Z",
      }],
      consentHistoryNextOffset: 50,
    };
    view.rerender(<CustomerDetailPanel customerId="customer-2" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));
    await act(async () => resolvePage?.());

    expect(screen.queryByText("前の顧客の版")).toBeNull();
    expect(screen.getByText("Bの初期版")).toBeTruthy();
    expect(screen.getByText("Bの追加版")).toBeTruthy();
  });

  it("Aの読込中でも切替先Bの同意履歴を読み込める", async () => {
    const user = userEvent.setup();
    customer = { ...customer, consentHistoryNextOffset: 50 };
    loadConsentsPage.mockImplementation(() => undefined);
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));
    // The shared mutation is still pending for A; B must ignore that state.
    consentsPagePending = true;
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    expect((screen.getByRole("button", { name: "同意履歴を読み込み中" }) as HTMLButtonElement).disabled).toBe(true);

    customer = { ...customer, id: "customer-2", consentHistoryNextOffset: 50 };
    view.rerender(<CustomerDetailPanel customerId="customer-2" onClose={() => {}} />);

    expect((screen.getByRole("button", { name: "同意履歴をさらに読み込む" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Bの最初のcommitにAの追加履歴・失敗・offsetを描画しない", async () => {
    const user = userEvent.setup();
    const snapshots: string[] = [];
    customer = { ...customer, consentHistoryNextOffset: 50 };
    loadConsentsPage
      .mockImplementationOnce((_input, options) => options?.onSuccess?.({
        ok: true,
        consents: [{
          id: "consent-a-extra",
          type: "notice",
          version: "Aの追加版",
          consentedAt: "2026-09-12T03:00:00.000Z",
        }],
        nextOffset: 100,
      }))
      .mockImplementationOnce((_input, options) => options?.onError?.(new Error("failed")));
    const view = render(
      <LayoutSnapshot onSnapshot={(text) => snapshots.push(text)}>
        <CustomerDetailPanel customerId="customer-1" onClose={() => {}} />
      </LayoutSnapshot>,
    );
    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));
    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));

    snapshots.length = 0;
    customer = {
      ...customer,
      id: "customer-2",
      consentHistory: [{
        id: "consent-b",
        type: "privacy_policy",
        version: "Bの初期版",
        consentedAt: "2026-09-11T03:00:00.000Z",
      }],
      consentHistoryNextOffset: null,
    };
    view.rerender(
      <LayoutSnapshot onSnapshot={(text) => snapshots.push(text)}>
        <CustomerDetailPanel customerId="customer-2" onClose={() => {}} />
      </LayoutSnapshot>,
    );

    expect(snapshots[0]).toContain("Bの初期版");
    expect(snapshots[0]).not.toContain("Aの追加版");
    expect(snapshots[0]).not.toContain("続きの同意履歴を読み込めませんでした");
    expect(snapshots[0]).not.toContain("同意履歴をさらに読み込む");
  });

  it.each(["先頭ページ更新", "A→B→A"])("%sでも以前の読込応答を破棄する", async (change) => {
    const user = userEvent.setup();
    customer = { ...customer, consentHistoryNextOffset: 50 };
    const originalCustomer = customer;
    let resolvePage: (() => void) | undefined;
    loadConsentsPage.mockImplementation((_input, options) => {
      resolvePage = () => options?.onSuccess?.({
        ok: true,
        consents: [{ id: "old", type: "notice", version: "古い追加版", consentedAt: "2026-09-12T03:00:00.000Z" }],
        nextOffset: null,
      });
    });
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "同意履歴をさらに読み込む" }));

    if (change === "A→B→A") {
      customer = { ...customer, id: "customer-2" };
      view.rerender(<CustomerDetailPanel customerId="customer-2" onClose={() => {}} />);
      customer = originalCustomer;
    } else {
      customer = {
        ...customer,
        consentHistory: [{ id: "new", type: "notice", version: "新しい先頭版", consentedAt: "2026-09-12T04:00:00.000Z" }],
      };
    }
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await act(async () => resolvePage?.());

    expect(screen.queryByText("古い追加版")).toBeNull();
    expect((screen.getByRole("button", { name: "同意履歴をさらに読み込む" }) as HTMLButtonElement).disabled).toBe(false);
    if (change === "先頭ページ更新") expect(screen.getByText("新しい先頭版")).toBeTruthy();
  });

  it("有効な未紐付け顧客の管理操作を表示し、確認後にブロックする", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      visits: [{
        id: "visit-1",
        reservationId: null,
        storeId: "store-1",
        visitedAt: "2026-07-23",
        visitSource: "manual_import",
        status: "valid",
        treatmentNotes: null,
        recordedBy: "オーナー",
      }],
    };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "LINEと紐付け" }));
    expect(screen.getByRole("button", { name: "アーカイブ" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "ブロック" }));
    await user.click(screen.getByRole("button", { name: "実行" }));

    expect(blockCustomer).toHaveBeenCalledWith(
      { customerId: "customer-1", action: "block" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    await user.click(screen.getByRole("button", { name: "ブロック" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));
    await user.click(screen.getByRole("button", { name: "実行" }));
    expect(archiveCustomer).toHaveBeenCalledWith(
      { customerId: "customer-1", action: "archive" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    await user.click(screen.getByRole("button", { name: "削除" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    await user.click(screen.getByRole("button", { name: "完全に削除" }));
    expect(screen.getByText("顧客を完全に削除")).toBeTruthy();
  });

  it("予約履歴でキャンセル料未納の予約にだけバッジを表示する", async () => {
    const user = userEvent.setup();
    const reservation = (id: string, cancellationFeeUnpaidAt: string | null) => ({
      id,
      status: "cancelled",
      source: "web",
      storeId: "store-1",
      storeName: "新宿店",
      serviceId: "service-1",
      serviceName: "全身脱毛",
      resourceId: "resource-1",
      resourceName: "枠1",
      startAt: "2026-07-20T10:00:00+09:00",
      endAt: "2026-07-20T11:00:00+09:00",
      customerId: "customer-1",
      customerDisplayName: "顧客 花子",
      lineFriendStatus: null,
      cancellationFeeUnpaidAt,
    });
    customer = {
      ...customer,
      reservations: [
        reservation("reservation-1", "2026-07-21T00:00:00Z"),
        reservation("reservation-2", null),
      ],
    };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await user.click(screen.getByRole("tab", { name: "予約履歴" }));
    expect(screen.getByText("予約履歴 (2件)")).toBeTruthy();
    expect(screen.getAllByText("キャンセル料未納")).toHaveLength(1);
  });

  // アーカイブ済みのブロック解除はサーバーが not_found で拒否する (block/unblock は
  // archived_at IS NULL を要求する)。先に復元させる導線だけを出す。
  it("ブロック済み・アーカイブ済み顧客には復元だけを表示する", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      blockStatus: "blocked",
      archivedAt: "2026-07-24T00:00:00Z",
      lineIdentities: [{
        id: "line-1",
        officialFriendStatus: "friend",
        followedAt: null,
        unfollowedAt: null,
        lastFriendCheckedAt: null,
      }],
    };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: "ブロック解除" })).toBeNull();
    expect(screen.getByRole("button", { name: "復元" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "LINEと紐付け" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "復元" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
  });

  it("スタッフにもブロック・アーカイブは出すが、LINE紐付けと完全削除は出さない", () => {
    privileged = false;
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "ブロック" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "アーカイブ" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "LINEと紐付け" })).toBeNull();
    expect(screen.queryByRole("button", { name: "完全に削除" })).toBeNull();
  });

  it("スタッフはアーカイブ済み顧客を復元できるが、編集とブロック切替の入口は出ない", () => {
    privileged = false;
    customer = { ...customer, archivedAt: "2026-08-01T00:00:00.000Z" };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "復元" })).toBeTruthy();
    // アーカイブ済みは全 role で読み取り専用 (API が archived_at IS NULL を要求する)。
    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "基本情報を編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ブロック" })).toBeNull();
  });

  it("オーナーでもアーカイブ済みでは編集の入口を出さない", () => {
    customer = { ...customer, archivedAt: "2026-08-01T00:00:00.000Z" };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
    expect(screen.getByRole("button", { name: "完全に削除" })).toBeTruthy();
  });
  // ブロック確認を開いたまま別の操作者にアーカイブされると、実行ボタンは残るが
  // サーバーの block は archived_at IS NULL を要求するので必ず失敗する。
  // (/code-review 指摘)
  it("ブロック確認を開いたままアーカイブされたらダイアログを閉じる", async () => {
    const user = userEvent.setup();
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "ブロック" }));
    expect(screen.getByRole("button", { name: "実行" })).toBeTruthy();

    customer = { ...customer, archivedAt: "2026-08-26T00:00:00.000Z" };
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "実行" })).toBeNull();
  });

  // 編集フォームを開いたまま顧客がアーカイブされると、入口ボタンは isArchived で
  // 消えても開いている form は残り、保存は必ず失敗する (archived_at IS NULL 要求)。
  // 自分のパネルからアーカイブした場合は onClose() で customerId が null になり
  // 既存のリセットが効くので、実際に踏むのは「別の操作者がアーカイブし、その再取得が
  // 届いた」場合 — このテストが再現しているのはそちら。(sourcery 指摘)
  it("編集フォームを開いたままアーカイブされたらフォームを畳む", async () => {
    const user = userEvent.setup();
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(document.body.querySelector("textarea")).not.toBeNull();

    customer = { ...customer, archivedAt: "2026-08-26T00:00:00.000Z" };
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={vi.fn()} />);

    expect(document.body.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
  });
});

describe("CustomerDetailPanel — 無効化された来店実績", () => {
  const visit = (overrides: Partial<CustomerDetail["visits"][number]> = {}) => ({
    id: "visit-1",
    reservationId: "reservation-1",
    storeId: "store-1",
    visitedAt: "2026-07-23",
    visitSource: "reservation",
    status: "valid",
    treatmentNotes: "カット",
    recordedBy: "京都 花子",
    ...overrides,
  });

  // 顧客のブロック状態バッジも「有効」と出るので、来店履歴セクションに絞る。
  const visitsSection = () =>
    within(screen.getByText(/^来店履歴 \(/).closest("div") as HTMLElement);

  it("有効な来店実績は「有効」バッジとメモ編集を出す", () => {
    customer = { ...customer, visits: [visit()] };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(visitsSection().getByText("来店済み")).toBeTruthy();
    expect(visitsSection().getByRole("button", { name: "メモ編集" })).toBeTruthy();
  });

  // 詳細が返すのは先頭 50 件だけ。ボタンが出ないと 51 件目より古い施術メモが
  // この画面から読めない (予約詳細パネルの案内の行き先がここ)。
  it("来店が 1 ページ分あるときだけ「さらに読み込む」を出し、続きを足す", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      validVisitCount: 56,
      visits: Array.from({ length: 50 }, (_, i) => visit({ id: `visit-${i}` })),
    };
    loadVisitsPage.mockImplementation((input, options) => {
      expect(input).toEqual({ customerId: "customer-1", offset: 50 });
      options?.onSuccess?.({
        ok: true,
        visits: [visit({ id: "visit-old", treatmentNotes: "いちばん古いカルテ" })],
        nextOffset: null,
      });
    });
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "さらに読み込む" }));

    expect(visitsSection().getByText("いちばん古いカルテ")).toBeTruthy();
    // 続きが無いと分かったらボタンは消える。
    expect(screen.queryByRole("button", { name: "さらに読み込む" })).toBeNull();
  });

  // このパネルは顧客を切り替えても作り直されない。読み込み中に別の顧客を開いたとき、
  // 遅れて返ってきた前の顧客の施術メモが今開いている顧客の履歴に出てはいけない。
  it("読み込み中に顧客を切り替えたら、遅れて返ってきた前の顧客の来店を捨てる", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      validVisitCount: 56,
      visits: Array.from({ length: 50 }, (_, i) => visit({ id: `visit-${i}` })),
    };
    let resolvePage: (() => void) | null = null;
    loadVisitsPage.mockImplementation((_input, options) => {
      resolvePage = () =>
        options?.onSuccess?.({
          ok: true,
          visits: [visit({ id: "visit-of-customer-1", treatmentNotes: "顧客1のカルテ" })],
          nextOffset: null,
        });
    });
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "さらに読み込む" }));

    // 別の顧客を開いた後に、前の顧客ぶんの応答が届く。
    customer = { ...customer, id: "customer-2", visits: [visit({ id: "visit-of-customer-2" })] };
    view.rerender(<CustomerDetailPanel customerId="customer-2" onClose={() => {}} />);
    // act で包まないと、遅れて届いた setState が反映されないまま次の行を評価してしまい、
    // 捨てていなくてもテストが通る (ガードを外しても落ちない = 何も固定していない)。
    await act(async () => {
      resolvePage?.();
    });

    expect(screen.queryByText("顧客1のカルテ")).toBeNull();
  });

  // 来店の編集・削除は 1 ページ目を取り直すだけなので、2 ページ目以降を件数で
  // 見張っていると消したはずの行が編集できる状態で残る。
  it("来店が取り直されたら、読み込み済みの続きを捨てる", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 50 }, (_, i) => visit({ id: `visit-${i}` }));
    customer = { ...customer, validVisitCount: 56, visits: firstPage };
    loadVisitsPage.mockImplementation((_input, options) => {
      options?.onSuccess?.({
        ok: true,
        visits: [visit({ id: "visit-old", treatmentNotes: "いちばん古いカルテ" })],
        nextOffset: null,
      });
    });
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "さらに読み込む" }));
    expect(visitsSection().getByText("いちばん古いカルテ")).toBeTruthy();

    // 件数は 50 のままだが中身が入れ替わった (メモを直して取り直した) 状態。
    customer = { ...customer, visits: firstPage.map((row) => ({ ...row })) };
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.queryByText("いちばん古いカルテ")).toBeNull();
  });

  // 51 件目以降を直した回は 1 ページ目の中身が変わらないので、詳細クエリを取り直しても
  // 配列の同一性まで保たれる (react-query の structural sharing)。読み込み済みの続きを
  // 明示的に捨てないと、消したはずの行が編集できる状態で残る。
  it("来店を書き換えたら、読み込み済みの続きを捨てる", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      validVisitCount: 56,
      visits: Array.from({ length: 50 }, (_, i) => visit({ id: `visit-${i}` })),
    };
    loadVisitsPage.mockImplementation((_input, options) => {
      options?.onSuccess?.({
        ok: true,
        visits: [visit({ id: "visit-old", treatmentNotes: "いちばん古いカルテ" })],
        nextOffset: null,
      });
    });
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "さらに読み込む" }));
    expect(visitsSection().getByText("いちばん古いカルテ")).toBeTruthy();

    // 1 ページ目のどれかの施術メモを保存する。1 ページ目の中身は変わらないので、
    // 詳細クエリを取り直しても配列の同一性は保たれる。
    await user.click(visitsSection().getAllByRole("button", { name: "メモ編集" })[0]);
    await user.type(visitsSection().getByRole("textbox"), "追記");
    await user.click(visitsSection().getByRole("button", { name: "保存" }));
    expect(noOpMutation).toHaveBeenCalled();

    await act(async () => {
      noOpMutation.mock.calls.at(-1)?.[1]?.onSuccess?.();
    });

    expect(screen.queryByText("いちばん古いカルテ")).toBeNull();
  });

  // 続きを読み込んでいる最中に来店を書き換えると、読み込み済みの続きは捨てられる。
  // その後に前の世代の応答が届くと、空になった一覧の後ろに古いページが足され、
  // offset だけ先へ進んで 51〜100 件目が二度と読めなくなる。
  it("続きを捨てたあとに届いた前の世代の応答は受け取らない", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      validVisitCount: 156,
      visits: Array.from({ length: 50 }, (_, i) => visit({ id: `visit-${i}` })),
    };
    let resolvePage: (() => void) | null = null;
    loadVisitsPage.mockImplementation((_input, options) => {
      resolvePage = () =>
        options?.onSuccess?.({
          ok: true,
          visits: [visit({ id: "visit-stale", treatmentNotes: "捨てたはずのページ" })],
          nextOffset: 150,
        });
    });
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "さらに読み込む" }));

    // 読み込み中に施術メモを保存した (= 読み込み済みの続きを捨てる)。
    await user.click(visitsSection().getAllByRole("button", { name: "メモ編集" })[0]);
    await user.type(visitsSection().getByRole("textbox"), "追記");
    await user.click(visitsSection().getByRole("button", { name: "保存" }));
    await act(async () => {
      noOpMutation.mock.calls.at(-1)?.[1]?.onSuccess?.();
    });

    await act(async () => {
      resolvePage?.();
    });

    expect(screen.queryByText("捨てたはずのページ")).toBeNull();
  });

  // offset ページングなので、読み込みの合間に来店が増えると境界がずれて同じ行が
  // 2 度返り得る。React の key が重複するので id で落とす。
  it("続きに既に出ている来店が混ざっていても重複させない", async () => {
    const user = userEvent.setup();
    customer = {
      ...customer,
      validVisitCount: 56,
      visits: Array.from({ length: 50 }, (_, i) => visit({ id: `visit-${i}` })),
    };
    loadVisitsPage.mockImplementation((_input, options) => {
      options?.onSuccess?.({
        ok: true,
        // 1 ページ目の最後の行が押し出されてもう一度返ってきた状態。
        visits: [visit({ id: "visit-49" }), visit({ id: "visit-old", treatmentNotes: "いちばん古いカルテ" })],
        nextOffset: null,
      });
    });
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "さらに読み込む" }));

    expect(visitsSection().getByText("いちばん古いカルテ")).toBeTruthy();
    // 50 件 + 重複を除いた 1 件。
    expect(visitsSection().getAllByText("登録: 京都 花子")).toHaveLength(51);
  });

  it("来店が 1 ページに満たないときは「さらに読み込む」を出さない", () => {
    customer = { ...customer, visits: [visit()] };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: "さらに読み込む" })).toBeNull();
  });

  // 誰が入れた記録か分からないと、間違いを見つけても本人に聞けない。
  it("来店履歴の各行に記入者を出す", () => {
    customer = {
      ...customer,
      visits: [visit(), visit({ id: "visit-2", recordedBy: "自動完了" })],
    };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(visitsSection().getByText("登録: 京都 花子")).toBeTruthy();
    expect(visitsSection().getByText("登録: 自動完了")).toBeTruthy();
  });

  it("予約由来の行には編集できない理由が出て、手作業の行には出ない", () => {
    customer = {
      ...customer,
      visits: [visit(), visit({ id: "visit-2", reservationId: null, visitSource: "manual_import" })],
    };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(
      screen.getAllByText("この来店記録は予約に連動しています。訂正は予約側から行ってください。"),
    ).toHaveLength(1);
    // 手作業の行には編集・削除ボタンが残る。
    expect(screen.getByRole("button", { name: "来店日を編集" })).toBeTruthy();
  });

  it("見出しの件数は表示中の行ではなくサーバーの有効件数を使う", () => {
    // visits は 50 行で打ち切られ、無効化された行もその枠を消費する。表示中の
    // 行を数えると来店の多い顧客で件数が減って見えるので、見出しは別に取得した
    // 全件数を使う。
    customer = { ...customer, validVisitCount: 51, visits: [visit({ status: "voided" })] };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.getByText("来店履歴 (51件)")).toBeTruthy();
  });

  it("無効化された行には理由の文言が出る", () => {
    customer = { ...customer, visits: [visit({ status: "voided" })] };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    expect(screen.getByText("来店なしへの訂正により無効化されました。")).toBeTruthy();
  });

  it("無効化された行は一覧に残り、「無効」バッジが付き、メモ編集できない", () => {
    customer = { ...customer, visits: [visit({ status: "voided" })] };
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);

    // 行そのものは消さない (何が起きたか追えなくなるため)。
    expect(visitsSection().getByText("カット")).toBeTruthy();
    expect(visitsSection().getByText("無効")).toBeTruthy();
    // 英単語がそのまま出ていた既存バグの回帰ピン。
    expect(screen.queryByText("voided")).toBeNull();
    expect(screen.queryByRole("button", { name: "メモ編集" })).toBeNull();
  });
});


describe("顧客カルテの編集snapshot", () => {
  it("編集中に再取得されても顧客メモの期待値と下書きを置き換えない", async () => {
    const user = userEvent.setup();
    customer = { ...customer, memo: "元の顧客メモ" };
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "・下書き");
    customer = { ...customer, memo: "別の担当者の更新" };
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(noOpMutation).toHaveBeenLastCalledWith({
      customerId: "customer-1", memo: "元の顧客メモ・下書き", expectedMemo: "元の顧客メモ",
    }, expect.anything());
  });
});


describe("紹介者と編集競合", () => {
  it("紹介者を任意で追加し、編集開始時のnullを期待値として送る", async () => {
    const user = userEvent.setup();
    customer = { ...customer, referrerName: null };
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    expect(screen.queryByText("紹介でご来店")).toBeNull();
    await user.click(screen.getByRole("button", { name: "紹介者を追加" }));
    await user.type(screen.getByRole("textbox", { name: "紹介者名" }), "紹介 太郎");
    customer = { ...customer, referrerName: "他の紹介者" };
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(noOpMutation).toHaveBeenLastCalledWith({
      customerId: "customer-1", referrerName: "紹介 太郎", expectedReferrerName: null,
    }, expect.anything());
  });

  it("競合時は下書きを保持し、最新内容の確認後だけ期待値を更新する", async () => {
    const user = userEvent.setup();
    customer = { ...customer, memo: "元のメモ" };
    const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "・下書き");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await act(async () => {
      noOpMutation.mock.calls.at(-1)?.[1]?.onError?.(new ApiError(409, { reason: "stale_snapshot" }));
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("元のメモ・下書き");
    customer = { ...customer, memo: "他担当の最新メモ" };
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "最新内容を確認" }));
    expect(await screen.findByText("他担当の最新メモ")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "確認して下書きを再編集" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(noOpMutation).toHaveBeenLastCalledWith({
      customerId: "customer-1", memo: "元のメモ・下書き", expectedMemo: "他担当の最新メモ",
    }, expect.anything());
  });

  it("紹介者フィールドの無い旧Workerでは追加書き込みを出さない", () => {
    render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "紹介者を追加" })).toBeNull();
  });
});


it("施術メモも編集開始時のexact値を保持し、競合後に再編集できる", async () => {
  const user = userEvent.setup();
  const visit = { id: "visit-1", reservationId: "reservation-1", storeId: "store-1", visitedAt: "2026-09-01", visitSource: "reservation", status: "valid", treatmentNotes: " 元の施術メモ " };
  customer = { ...customer, visits: [visit] };
  const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: "メモ編集" }));
  await user.type(screen.getByRole("textbox"), "・下書き");
  customer = { ...customer, visits: [{ ...visit, treatmentNotes: "新しい施術メモ" }] };
  view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(noOpMutation).toHaveBeenLastCalledWith({ customerId: "customer-1", visitId: "visit-1", treatmentNotes: "元の施術メモ ・下書き", expectedTreatmentNotes: " 元の施術メモ " }, expect.anything());
  await act(async () => { noOpMutation.mock.calls.at(-1)?.[1]?.onError?.(new ApiError(409, { reason: "stale_snapshot" })); });
  await user.click(screen.getByRole("button", { name: "最新内容を確認" }));
  expect(await screen.findByText("新しい施術メモ")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "確認して下書きを再編集" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(noOpMutation.mock.calls.at(-1)?.[0].expectedTreatmentNotes).toBe("新しい施術メモ");
});


it("来店メニューの当時名と未記録を区別し、予約履歴の追加取得を再試行できる", async () => {
  const user = userEvent.setup();
  const reservation = { id: "reservation-1", startAt: "2026-09-29T10:00:00+09:00", endAt: "2026-09-29T11:00:00+09:00", storeId: "store-1", storeName: "新宿店", serviceId: "service-1", serviceName: "カット + カラー", serviceNameSource: "snapshot" as const, resourceId: "resource-1", resourceName: "担当", customerId: "customer-1", customerDisplayName: "顧客 花子", lineFriendStatus: null, status: "completed", source: "admin", cancellationFeeUnpaidAt: null };
  customer = { ...customer, lastVisitAt: "2026-09-29", nextReservation: null, reservations: [reservation], reservationsNextOffset: 50, visits: [
    { id: "visit-1", reservationId: "reservation-1", storeId: "store-1", storeName: "新宿店", visitedAt: "2026-09-29", visitSource: "reservation", status: "valid", treatmentNotes: "施術内容", serviceName: "カット + カラー", serviceNameSource: "snapshot" },
    { id: "visit-2", reservationId: null, storeId: "store-1", storeName: "新宿店", visitedAt: "2026-09-01", visitSource: "manual_import", status: "valid", treatmentNotes: "紙から転記", serviceName: null, serviceNameSource: "unrecorded" },
  ] };
  render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  expect(screen.getByText("カット + カラー")).toBeTruthy();
  expect(screen.getByText("メニュー未記録")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "予約履歴" }));
  loadReservationsPage.mockImplementationOnce((_input, options) => options?.onError?.(new Error("network")));
  await user.click(screen.getByRole("button", { name: "過去の予約をさらに読み込む" }));
  expect(screen.getByRole("alert").textContent).toContain("予約履歴を読み込めませんでした");
  expect(screen.getByText("カット + カラー")).toBeTruthy();
  loadReservationsPage.mockImplementationOnce((input, options) => {
    expect(input).toEqual({ customerId: "customer-1", offset: 50 });
    options?.onSuccess?.({ ok: true, reservations: [reservation, { ...reservation, id: "reservation-old", serviceName: "古いメニュー" }], nextOffset: null });
  });
  await user.click(screen.getByRole("button", { name: "過去の予約をさらに読み込む" }));
  expect(screen.getByText("古いメニュー")).toBeTruthy();
  expect(screen.getAllByText("カット + カラー")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "過去の予約をさらに読み込む" })).toBeNull();
  expect(screen.getByText("予約履歴の終端です")).toBeTruthy();
});


it("予約関連が欠落した予約由来の来店に手動訂正を出さない", () => {
  customer = { ...customer, visits: [{ id: "broken-visit", reservationId: null, storeId: "store-1", visitedAt: "2026-09-29", visitSource: "reservation_completed", status: "valid", treatmentNotes: "既存施術内容" }] };
  render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  expect(screen.queryByRole("button", { name: "来店日を編集" })).toBeNull();
  expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
});


it("51件目の施術メモ編集中に先頭ページが更新されても下書きを保持する", async () => {
  const user = userEvent.setup();
  const visit = (id: string, treatmentNotes: string | null) => ({ id, reservationId: null, storeId: "store-1", visitedAt: "2026-09-01", visitSource: "manual_import", status: "valid", treatmentNotes });
  const firstPage = Array.from({ length: 50 }, (_, index) => visit(`visit-${index}`, null));
  customer = { ...customer, visits: firstPage };
  loadVisitsPage.mockImplementation((_input, options) => options?.onSuccess?.({ ok: true, visits: [visit("visit-old", "古い施術記録")], nextOffset: null }));
  const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: "さらに読み込む" }));
  const card = screen.getByText("古い施術記録").closest("details")!;
  await user.click(card.querySelector("summary")!);
  await user.click(within(card).getByRole("button", { name: "メモ編集" }));
  await user.type(screen.getByRole("textbox", { name: "施術メモ" }), "・下書き");
  customer = { ...customer, visits: firstPage.map((row) => ({ ...row })) };
  view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  expect((screen.getByRole("textbox", { name: "施術メモ" }) as HTMLTextAreaElement).value).toBe("古い施術記録・下書き");
});


it("長年の来店を年付きJST日付で区別できる", () => {
  customer = { ...customer, lastVisitAt: "2022-01-15", visits: [{ id: "visit-2022", reservationId: null, storeId: "store-1", visitedAt: "2022-01-15", visitSource: "paper_chart_import", status: "valid", treatmentNotes: null }] };
  render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  expect(screen.getAllByText("2022年1月15日 (土)")).toHaveLength(2);
});


it("151件目の競合内容の再取得が失敗しても元のページ位置で再試行する", async () => {
  const user = userEvent.setup();
  const visit = (index: number, treatmentNotes: string | null = null) => ({
    id: `visit-${index}`, reservationId: null, storeId: "store-1", visitedAt: "2026-09-01",
    visitSource: "manual_import", status: "valid", treatmentNotes,
  });
  const firstPage = Array.from({ length: 50 }, (_, index) => visit(index));
  const target = visit(150, "151件目の元の施術メモ");
  customer = { ...customer, visits: firstPage };
  loadVisitsPage.mockImplementation(({ offset }, options) => options?.onSuccess?.({
    ok: true,
    visits: offset === 150 ? [target] : Array.from({ length: 50 }, (_, index) => visit(offset + index)),
    nextOffset: offset === 150 ? null : offset + 50,
  }));
  const view = render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  for (let page = 0; page < 3; page++) await user.click(screen.getByText("さらに読み込む"));
  const card = screen.getByText("151件目の元の施術メモ").closest("details")!;
  await user.click(card.querySelector("summary")!);
  await user.click(within(card).getByRole("button", { name: "メモ編集" }));
  await user.click(screen.getByLabelText("施術メモ"));
  await user.paste("・下書き");
  await user.click(screen.getByText("保存"));
  expect(noOpMutation.mock.calls.at(-1)?.[0].expectedTreatmentNotes).toBe("151件目の元の施術メモ");
  await act(async () => { noOpMutation.mock.calls.at(-1)?.[1]?.onError?.(new ApiError(409, { reason: "stale_snapshot" })); });

  refetchCustomer.mockImplementation(async () => {
    customer = { ...customer, visits: firstPage.map((row, index) => index === 0 ? { ...row, treatmentNotes: "先頭ページの変更" } : row) };
    view.rerender(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
    return { data: { ok: true, customer } };
  });
  loadVisitsPageAsync.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  loadVisitsPageAsync.mockImplementation(async ({ offset }) => ({
    ok: true, visits: offset === 150 ? [{ ...target, treatmentNotes: "151件目の最新の施術メモ" }] : [], nextOffset: null,
  }));
  await user.click(screen.getByText("最新内容を確認"));
  expect(await screen.findByText("最新内容を読み込めませんでした。もう一度お試しください。")).toBeTruthy();
  expect((screen.getByLabelText("施術メモ") as HTMLTextAreaElement).value).toBe("151件目の元の施術メモ・下書き");
  await user.click(screen.getByText("最新内容を確認"));
  expect(loadVisitsPageAsync.mock.calls.map(([input]) => input.offset)).toEqual([150, 150]);
  expect(await screen.findByText("151件目の最新の施術メモ")).toBeTruthy();
  expect(noOpMutation).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("施術メモ") as HTMLTextAreaElement).value).toBe("151件目の元の施術メモ・下書き");
  await user.click(screen.getByText("確認して下書きを再編集"));
  await user.click(screen.getByText("保存"));
  expect(noOpMutation.mock.calls.at(-1)?.[0]).toEqual({
    customerId: "customer-1", visitId: "visit-150", treatmentNotes: "151件目の元の施術メモ・下書き",
    expectedTreatmentNotes: "151件目の最新の施術メモ",
  });
});


const provenanceReservation = {
  id: "reservation-1", startAt: "2026-09-29T10:00:00+09:00", endAt: "2026-09-29T11:00:00+09:00",
  storeId: "store-1", storeName: "新宿店", serviceId: "service-1", serviceName: "カット",
  resourceId: "resource-1", resourceName: "担当", customerId: "customer-1", customerDisplayName: "顧客 花子",
  lineFriendStatus: null, status: "completed", source: "phone_admin", reservationOrigin: "minimo",
  createdAt: "2025-12-31T15:20:00Z", cancellationFeeUnpaidAt: null,
};

it("予約履歴で来店予定と日本時間の登録日時、受付経路を区別できる", async () => {
  customer = { ...customer, reservations: [provenanceReservation], reservationsNextOffset: null };
  render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  await userEvent.setup().click(screen.getByRole("tab", { name: "予約履歴" }));
  expect(screen.getByText("来店予定")).toBeTruthy();
  expect(screen.getByText("2026年9月29日 (火) 10:00")).toBeTruthy();
  expect(screen.getByText("登録日時")).toBeTruthy();
  expect(screen.getByText("2026年1月1日 (木) 00:20")).toBeTruthy();
  expect(screen.getByText("手動予約 · minimo")).toBeTruthy();
  expect(screen.getByText("登録日時は、このシステムに予約を登録した日時です。")).toBeTruthy();
});


it.each([
  ["LINE", "web_line", null, "LINE予約"],
  ["電話", "phone_admin", "phone", "手動予約 · 電話"],
  ["店頭", "admin", "walk_in", "手動予約 · 店頭"],
  ["その他", "admin", "other", "手動予約 · その他"],
  ["経路なし", "phone_admin", null, "手動予約 · 経路未記録"],
  ["未知の経路", "admin", "instagram", "手動予約 · 経路未記録"],
  ["システム取込", "system_import", null, "システム取込"],
] as const)("予約履歴に%sの受付経路を表示する", async (_name, source, reservationOrigin, expected) => {
  customer = { ...customer, reservations: [{ ...provenanceReservation, source, reservationOrigin }], reservationsNextOffset: null };
  render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  await userEvent.setup().click(screen.getByRole("tab", { name: "予約履歴" }));
  expect(screen.getByText(expected)).toBeTruthy();
});

it.each([undefined, null, "invalid-date"])("登録日時が%sなら予定日で補完せず未記録を表示する", async (createdAt) => {
  customer = { ...customer, reservations: [{ ...provenanceReservation, createdAt }], reservationsNextOffset: null };
  render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  await userEvent.setup().click(screen.getByRole("tab", { name: "予約履歴" }));
  expect(screen.getByText("未記録")).toBeTruthy();
  expect(screen.getByText("2026年9月29日 (火) 10:00")).toBeTruthy();
});

it("追加取得した過去の予約にも登録日時と受付経路を表示する", async () => {
  customer = { ...customer, reservations: [provenanceReservation], reservationsNextOffset: 50 };
  loadReservationsPage.mockImplementation((_input, options) => options?.onSuccess?.({
    ok: true, reservations: [{ ...provenanceReservation, id: "older", source: "web_line", reservationOrigin: null, createdAt: "2022-08-31T23:45:00Z" }], nextOffset: null,
  }));
  render(<CustomerDetailPanel customerId="customer-1" onClose={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "予約履歴" }));
  await user.click(screen.getByRole("button", { name: "過去の予約をさらに読み込む" }));
  expect(screen.getByText("2022年9月1日 (木) 08:45")).toBeTruthy();
  expect(screen.getByText("LINE予約")).toBeTruthy();
  expect(screen.getAllByText("来店予定")).toHaveLength(2);
});
