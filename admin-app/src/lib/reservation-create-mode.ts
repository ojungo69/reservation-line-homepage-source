// 管理画面の手動予約: 顧客指定モードの純ロジック。
// 既存客は role を問わず customerId で予約する（staff には電話番号がマスク表示
// されるため、手入力経路では既存客を指定できない）。検索・詳細と同じく
// サーバー側の staffCanAccessCustomer / storeScope が自店舗スコープを強制する。

export type CreateMode = "existing" | "new";

export type CustomerPartResult =
  | { ok: true; part: { customerId: string } | { customer: { displayName: string; displayNameKana?: string; phone: string } } }
  | { ok: false; error: string };

/**
 * 送信 payload の顧客部分。既存客モードは customerId のみを送り、customer /
 * phone（staff にはマスク値しか見えない）は決して含めない。新規モードは
 * 氏名+電話必須。
 */
export function buildCustomerPart(
  mode: CreateMode,
  selectedCustomerId: string | null,
  manual: { name: string; kana: string; phone: string },
): CustomerPartResult {
  if (mode === "existing") {
    if (!selectedCustomerId) {
      return { ok: false, error: "既存のお客様を選択してください" };
    }
    return { ok: true, part: { customerId: selectedCustomerId } };
  }
  const name = manual.name.trim();
  const phone = manual.phone.trim();
  if (!name || !phone) {
    return { ok: false, error: "氏名と電話番号を入力してください" };
  }
  const kana = manual.kana.trim();
  return {
    ok: true,
    part: { customer: { displayName: name, ...(kana ? { displayNameKana: kana } : {}), phone } },
  };
}
