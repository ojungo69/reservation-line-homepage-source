import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReservationDetail } from "@/types/api";
import { ApiError } from "@/lib/api-client";
import { createQueryWrapper, createTestQueryClient } from "@/test-utils/query-client";

const runAction = vi.fn();
const saveNotes = vi.fn();
const refetchReservation = vi.fn();
const updateCancellationFee = vi.fn();
let reservation: ReservationDetail;
let privileged = true;
let feePending = false;
let gateFailureReason: unknown;

vi.mock("@/hooks/use-reservations", () => ({
  useReservationDetail: () => ({
    data: { ok: true, reservation },
    isPending: false,
    isFetching: false,
    refetch: refetchReservation,
  }),
  useReservationAction: () => ({ mutate: runAction, isPending: false }),
  useUpdateTreatmentNotes: () => ({ mutate: saveNotes, isPending: false }),
  useReservationCancellationFee: () => ({
    mutate: updateCancellationFee,
    isPending: feePending,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isPrivileged: privileged }),
}));

vi.mock("@/hooks/use-customers", () => ({
  useCustomerDetail: () => ({
    data: gateFailureReason ? undefined : { ok: true },
    isFetching: !!gateFailureReason,
    isError: false,
    error: null,
    failureReason: gateFailureReason,
  }),
}));

vi.mock("./reservation-reschedule-dialog", () => ({
  ReservationRescheduleDialog: () => null,
}));

vi.mock("./reservation-duration-dialog", () => ({
  ReservationDurationDialog: () => null,
}));

import { ReservationDetailPanel } from "./reservation-detail-panel";

beforeEach(() => {
  runAction.mockReset();
  saveNotes.mockReset();
  refetchReservation.mockReset();
  refetchReservation.mockImplementation(async () => ({ data: { ok: true, reservation } }));
  updateCancellationFee.mockReset();
  privileged = true;
  feePending = false;
  gateFailureReason = undefined;
  reservation = {
    id: "reservation-1",
    status: "no_show",
    source: "admin",
    storeId: "store-1",
    storeName: "新宿店",
    serviceId: "service-1",
    serviceIds: ["service-1"],
    serviceName: "基本メニュー",
    resourceId: "resource-1",
    resourceName: "担当A",
    startAt: "2026-07-24T10:00:00+09:00",
    endAt: "2026-07-24T11:00:00+09:00",
    customerId: "customer-1",
    customerDisplayName: "予約 花子",
    customerDisplayNameKana: "ヨヤク ハナコ",
    phoneNormalized: "09012345678",
    lineFriendStatus: null,
    cancellationFeeUnpaidAt: null,
    googleSyncState: null,
    googleEventId: null,
    version: 1,
    reservationOrigin: "phone",
    customerMemo: null,
    customerAllergyNotes: null,
    customerPastNotes: [],
    customerPastNotesTruncated: false,
    visits: [{
      id: "visit-1",
      visitedAt: "2026-07-24",
      visitSource: "reservation",
      // DB の CHECK 上ありうるのは valid / voided だけ。実在しない値を使っていたため
      // 「バッジに英単語が出る」バグがテストを素通りしていた。
      status: "valid",
      treatmentNotes: "施術済み",
    }],
    audit: [],
    notifications: [],
    calendarSync: [],
    duplicateConsent: null,
  };
});

describe("ReservationDetailPanel", () => {
  it("キャンセル料の未納・入金済み状態を更新する", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "キャンセル料未納にする" }));
    expect(updateCancellationFee).toHaveBeenCalledWith({
      reservationId: "reservation-1",
      unpaid: true,
    });

    reservation = {
      ...reservation,
      cancellationFeeUnpaidAt: "2026-07-24T12:00:00Z",
    };
    rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "入金済みにする" }));
    expect(updateCancellationFee).toHaveBeenLastCalledWith({
      reservationId: "reservation-1",
      unpaid: false,
    });
  });

  it("状態・処理中表示に応じて操作を隠す", () => {
    feePending = true;
    const { rerender } = render(
      <ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "処理中..." })).toBeTruthy();

    reservation = { ...reservation, cancellationFeeUnpaidAt: "2026-07-24T12:00:00Z" };
    rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "処理中..." })).toBeTruthy();

    // キャンセル料の記録は owner 限定ではない: staff (isPrivileged=false) にも出す。
    // バックエンドが自店舗スコープで許可しているため、画面ごとに可否が食い違わないようにする。
    privileged = false;
    rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "処理中..." })).toBeTruthy();

    privileged = true;
    feePending = false;
    reservation = { ...reservation, cancellationFeeUnpaidAt: null, status: "confirmed" };
    rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /キャンセル料/ })).toBeNull();
  });

  it("顧客メモは空でも見出しと「メモなし」を出す（アレルギーは null なら出さない）", () => {
    const { rerender } = render(
      <ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />,
    );
    // 空でも見出しを消さないのが契約。消すと「メモが無い」と「壊れている」を
    // 現場が区別できない（実際にバグとして報告された）。
    // 「メモなし」は施術メモ側にも出る文言なので、顧客メモの見出しと同じブロックに
    // 入っていることまで見る（fixture の施術メモを空にした瞬間に別物を拾うため）。
    const memoLabel = screen.getByText("顧客メモ");
    expect(within(memoLabel.parentElement as HTMLElement).getByText("メモなし")).toBeTruthy();
    // アレルギーは従来どおり値があるときだけ出す（無い＝特記なしで誤読の余地が無い）。
    expect(screen.queryByText("アレルギー・注意事項")).toBeNull();

    reservation = {
      ...reservation,
      customerMemo: "カラー剤は弱め希望\n前回パーマ",
      customerAllergyNotes: "金属アレルギー",
    };
    rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByText("顧客メモ")).toBeTruthy();
    // 改行保持の契約: 複数行 textContent がそのまま残り、whitespace-pre-wrap が
    // 付いていること（クラスを外すと JSDOM でも検出できるようにする）。
    const memoBody = screen.getByText(/カラー剤は弱め希望/);
    expect(memoBody.textContent).toBe("カラー剤は弱め希望\n前回パーマ");
    expect(memoBody.className).toContain("whitespace-pre-wrap");
    expect(screen.getByText("アレルギー・注意事項")).toBeTruthy();
    expect(screen.getByText("金属アレルギー")).toBeTruthy();
  });

  it("未完了の予約でも同じ顧客の過去の施術メモを出す", () => {
    // この予約自身の来店行がまだ無い（＝これから来る予約）状態を作る。
    reservation = {
      ...reservation,
      // これから来る予約であることまで固定する（fixture の既定は no_show で、
      // 「来店行が無い」しか再現しない）。
      status: "confirmed",
      visits: [],
      customerPastNotes: [
        { visitedAt: "2026-07-01T02:00:00.000Z", treatmentNotes: "前回はカラー弱め\n次回は明るめ希望" },
        { visitedAt: "2026-06-01T02:00:00.000Z", treatmentNotes: "初回カウンセリング" },
        // 手入力 (manual_import) の来店は visited_at が JST の 'YYYY-MM-DD' 日付キーで、
        // ISO とは書式が違う。日付キーでも同じ表記になることをここで固定する。
        { visitedAt: "2026-05-01", treatmentNotes: "紙カルテから取り込んだ回" },
      ],
    };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);

    expect(screen.getByText("過去の施術メモ")).toBeTruthy();
    // 年入りの表記であること。年が無いと去年の同じ日と区別できない。
    expect(screen.getByText("2026年7月1日 (水)")).toBeTruthy();
    const latest = screen.getByText(/前回はカラー弱め/);
    expect(latest.textContent).toBe("前回はカラー弱め\n次回は明るめ希望");
    expect(latest.className).toContain("whitespace-pre-wrap");
    expect(screen.getByText("初回カウンセリング")).toBeTruthy();
    expect(screen.getByText("2026年5月1日 (金)")).toBeTruthy();
    expect(screen.getByText("紙カルテから取り込んだ回")).toBeTruthy();
    // この予約の来店行が無いので、編集できる「施術メモ」セクションは出さない。
    expect(screen.queryByText("施術メモ")).toBeNull();
  });

  // 上限ちょうどの3件。案内を出す・出さないの分岐だけが違う2本で共有する。
  const threeNotes = [
    { visitedAt: "2026-07-01T02:00:00.000Z", treatmentNotes: "3回目" },
    { visitedAt: "2026-06-01T02:00:00.000Z", treatmentNotes: "2回目" },
    { visitedAt: "2026-05-01T02:00:00.000Z", treatmentNotes: "1回目" },
  ];

  it("3件ちょうどのときは「これより前のぶん」の案内を出さない", () => {
    // 件数で判定していた頃はここで案内が出てしまい、無い過去を見に行かせていた。
    reservation = { ...reservation, customerPastNotes: threeNotes, customerPastNotesTruncated: false };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByText("過去の施術メモ")).toBeTruthy();
    expect(screen.queryByText(/これより前のぶん/)).toBeNull();
  });

  it("打ち切られたときだけ「これより前のぶん」の案内を出す", () => {
    reservation = { ...reservation, customerPastNotes: threeNotes, customerPastNotesTruncated: true };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByText("これより前のぶんは顧客タブの来店履歴でご確認いただけます。")).toBeTruthy();
  });

  // owner にはこの一覧へ全店舗ぶんが並ぶ。どこで受けた施術か分からないと、別店舗の
  // 内容を自店舗の履歴として読んでしまう (issue #649)。同じ店舗のぶんにまで名前を
  // 付けると、ほとんどの行が同じ文字で埋まって差が見えなくなるので出さない。
  it("他店舗で受けた回にだけ店舗名を出す", () => {
    reservation = {
      ...reservation,
      customerPastNotes: [
        { visitedAt: "2026-07-01T02:00:00.000Z", treatmentNotes: "梅田で受けた回", storeId: "osaka", storeName: "ExampleStore B" },
        { visitedAt: "2026-06-01T02:00:00.000Z", treatmentNotes: "この店で受けた回", storeId: "store-1", storeName: "ExampleStore A" },
      ],
    };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);

    expect(screen.getByText("ExampleStore B")).toBeTruthy();
    expect(screen.queryByText("ExampleStore A")).toBeNull();
  });

  // 店舗が分からない行 (取り込み元に店舗が無い過去データ) は、バッジを出さずに
  // そのまま並べる。「他店舗」と決めつけると、自店舗の回を別店舗として読ませる。
  it("店舗が分からない回にはバッジを出さない", () => {
    reservation = {
      ...reservation,
      customerPastNotes: [
        { visitedAt: "2026-07-01T02:00:00.000Z", treatmentNotes: "店舗不明の回", storeId: null, storeName: null },
      ],
    };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);

    expect(screen.getByText("店舗不明の回")).toBeTruthy();
    expect(screen.queryByText("他店舗")).toBeNull();
  });

  it("過去の施術メモが無いときはセクションごと出さない", () => {
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.queryByText("過去の施術メモ")).toBeNull();
  });

  it("customerPastNotes ごと欠けた応答でもパネルが落ちない", () => {
    // 新しい SPA が古い worker の応答を受け取る移行中に起こる形。ここで throw すると
    // 承認・キャンセルのボタンごとパネル全体が消える。
    const { customerPastNotes: _omitted, ...withoutField } = reservation;
    reservation = withoutField as typeof reservation;
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByText("予約 花子")).toBeTruthy();
    expect(screen.queryByText("過去の施術メモ")).toBeNull();
  });

  it("メニュー名はカテゴリ prefix を除去して表示する (メンズ｜は保持)", () => {
    reservation = { ...reservation, serviceName: "脱毛｜全身脱毛 60分 / メンズ｜サンプル 10" };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByText("全身脱毛 60分 / メンズ｜サンプル 10")).toBeTruthy();
  });
});

describe("ReservationDetailPanel の施術メモの取り違え防止", () => {
  it.each([
    [403, "customer_gate_required", true],
    [403, "forbidden", false],
    [500, "internal", false],
  ] as const)("再試行中の %s %s でも承認が必要な場合だけ確認カードを表示する", async (status, reason, needsApproval) => {
    privileged = false;
    gateFailureReason = new ApiError(status, { reason });
    const user = userEvent.setup();
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />, {
      wrapper: createQueryWrapper(createTestQueryClient()),
    });
    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox", { name: "施術メモ" }), "・下書き");
    expect(!!screen.queryByRole("button", { name: "確認コードを送る" })).toBe(needsApproval);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "施術メモ" }) as HTMLTextAreaElement).value).toBe("施術済み・下書き");
  });

  it("完了後のメモ入力から編集へ切り替えても下書きを引き継ぐ", async () => {
    const user = userEvent.setup();
    reservation = { ...reservation, status: "confirmed" };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "完了" }));
    await user.click(screen.getByRole("button", { name: "実行" }));
    reservation = { ...reservation, status: "completed" };
    await act(async () => { runAction.mock.calls.at(-1)?.[1]?.onSuccess?.(); });
    await user.type(screen.getByRole("textbox", { name: "施術メモ" }), "完了後の下書き");
    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getAllByRole("textbox", { name: "施術メモ" })).toHaveLength(1);
    expect((screen.getByRole("textbox", { name: "施術メモ" }) as HTMLTextAreaElement).value).toBe("完了後の下書き");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(saveNotes).toHaveBeenCalledWith(
      { customerId: "customer-1", visitId: "visit-1", treatmentNotes: "完了後の下書き", expectedTreatmentNotes: "施術済み" },
      expect.anything(),
    );
  });

  // 保存済みのカルテを全選択して消し、そのまま保存すると無確認で消えていた
  // (新規入力側は空だと保存ボタンが無効なので、消える経路はこちらだけだった)。
  it("保存済みのメモを空にして保存しようとすると確認を挟む", async () => {
    const user = userEvent.setup();
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.clear(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(saveNotes).not.toHaveBeenCalled();
    expect(screen.getByText("施術メモを消しますか？")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "消して保存" }));
    expect(saveNotes).toHaveBeenCalledWith(
      { customerId: "customer-1", visitId: "visit-1", treatmentNotes: null, expectedTreatmentNotes: "施術済み" },
      expect.anything(),
    );

    // 成功したら確認も畳む。畳まないと、サーバー側が消し終わったあとも確認が開いた
    // ままになり、同じ削除を何度でも押せる。
    await act(async () => {
      saveNotes.mock.calls.at(-1)?.[1]?.onSuccess?.();
    });
    expect(screen.queryByText("施術メモを消しますか？")).toBeNull();
  });

  it("メモが元から空なら確認は挟まない", async () => {
    const user = userEvent.setup();
    reservation = {
      ...reservation,
      visits: [{ ...reservation.visits[0], treatmentNotes: null }],
    };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "追記");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(saveNotes).toHaveBeenCalledWith(
      { customerId: "customer-1", visitId: "visit-1", treatmentNotes: "追記", expectedTreatmentNotes: null },
      expect.anything(),
    );
  });

  // Esc / 外側クリック / × は Radix が同じ onOpenChange(false) で通知する。
  // 書きかけの内容を持ったまま閉じると、その場で消えて戻す手段が無かった。
  it("書きかけのメモがあるまま Esc を押しても閉じず、破棄を選んだときだけ閉じる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "書きかけ");
    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("書きかけの施術メモがあります")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "破棄して閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 「次回予約」は onClose() を直接呼ぶので Radix の onOpenChange を通らない。
  // 閉じる経路だけ守っても、このボタンから書きかけが黙って消える。
  it("書きかけのまま「次回予約」を押しても遷移せず、破棄を選んだときだけ遷移する", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onRebook = vi.fn();
    render(
      <ReservationDetailPanel reservationId="reservation-1" onClose={onClose} onRebook={onRebook} />,
    );

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.type(screen.getByRole("textbox"), "書きかけ");
    await user.click(screen.getByRole("button", { name: "次回予約" }));

    expect(onRebook).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("書きかけの施術メモがあります")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "破棄して閉じる" }));
    expect(onRebook).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 却下は取り消せない終端遷移。キャンセル側にはその一文があるのに却下だけ無く、
  // 「後で戻せる」と読める文言だった。
  it("却下の確認文言が取り消せないことを伝える", async () => {
    const user = userEvent.setup();
    reservation = { ...reservation, status: "pending_approval" };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "却下" }));
    expect(screen.getByText(/取り消せません/)).toBeTruthy();
  });

  it("編集を開いただけで内容を変えていなければ Esc でそのまま閉じる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ReservationDetailPanel の終端状態の訂正", () => {
  it("owner と staff に来店なしへの訂正ボタンを出す", () => {
    reservation = { ...reservation, status: "completed" };
    const { rerender } = render(
      <ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "来店なしに訂正" })).toBeTruthy();

    privileged = false;
    rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "来店なしに訂正" })).toBeTruthy();
  });

  it("訂正では現在の version を expectedVersion として送る", async () => {
    const user = userEvent.setup();
    privileged = false;
    reservation = { ...reservation, status: "completed", version: 7 };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);

    await user.click(screen.getByRole("button", { name: "来店なしに訂正" }));
    await user.click(screen.getByRole("button", { name: "実行" }));

    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation-1",
        action: "correct-no-show",
        expectedVersion: 7,
      }),
      expect.anything(),
    );
  });

  it("訂正の成功ではパネルを閉じない (同じ画面から戻せるようにするため)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    reservation = { ...reservation, status: "completed" };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "来店なしに訂正" }));
    await user.click(screen.getByRole("button", { name: "実行" }));

    // mutate の第2引数に渡した onSuccess を実行して、閉じないことを確かめる。
    const [, options] = runAction.mock.calls[0] as [unknown, { onSuccess: () => void }];
    options.onSuccess();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("no_show の「完了に戻す」は owner にだけ出す", () => {
    reservation = { ...reservation, status: "no_show" };
    const { rerender } = render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "完了に戻す" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "来店なしに訂正" })).toBeNull();
    privileged = false;
    rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "完了に戻す" })).toBeNull();
  });

  it("無効化された来店記録は施術メモの編集対象にしない", () => {
    reservation = {
      ...reservation,
      status: "no_show",
      visits: [{ ...reservation.visits[0], status: "voided" }],
    };
    render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
    // 有効な行が無いので保存ボタンは「読込中...」のまま = 編集対象にならない。
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });
});


it("予約詳細の施術メモも元値を送信し、競合後は確認して再編集できる", async () => {
  const user = userEvent.setup();
  reservation = { ...reservation, status: "completed" };
  const view = render(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: "編集" }));
  await user.type(screen.getByRole("textbox", { name: "施術メモ" }), "・下書き");
  reservation = { ...reservation, visits: [{ ...reservation.visits[0], treatmentNotes: "他担当の更新" }] };
  view.rerender(<ReservationDetailPanel reservationId="reservation-1" onClose={() => {}} />);
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(saveNotes.mock.calls.at(-1)?.[0].expectedTreatmentNotes).toBe("施術済み");
  await act(async () => { saveNotes.mock.calls.at(-1)?.[1]?.onError?.(new ApiError(409, { reason: "stale_snapshot" })); });
  expect((screen.getByRole("textbox", { name: "施術メモ" }) as HTMLTextAreaElement).value).toBe("施術済み・下書き");
  await user.click(screen.getByRole("button", { name: "最新内容を確認" }));
  expect(await screen.findByText("他担当の更新")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "確認して下書きを再編集" }));
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(saveNotes.mock.calls.at(-1)?.[0].expectedTreatmentNotes).toBe("他担当の更新");
});
