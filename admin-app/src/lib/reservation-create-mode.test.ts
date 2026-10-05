import { describe, expect, it } from "vitest";
import { buildCustomerPart } from "./reservation-create-mode";

describe("buildCustomerPart", () => {
  it("既存客モードは customerId のみを送り customer/phone を含まない（staff のマスク電話が payload に混入しない）", () => {
    const result = buildCustomerPart("existing", "customer_1", {
      name: "既存 客",
      kana: "キソン キャク",
      phone: "***-****-0902",
    });
    expect(result).toEqual({ ok: true, part: { customerId: "customer_1" } });
    if (result.ok) {
      expect(result.part).not.toHaveProperty("customer");
      expect(JSON.stringify(result.part)).not.toContain("0902");
    }
  });

  it("既存客モードで未選択はエラー", () => {
    expect(buildCustomerPart("existing", null, { name: "", kana: "", phone: "" })).toEqual({
      ok: false,
      error: "既存のお客様を選択してください",
    });
  });

  it("新規モードは氏名+電話必須で customer オブジェクトを組む（カナは空なら省略）", () => {
    expect(
      buildCustomerPart("new", null, { name: " 山田 花子 ", kana: "", phone: " 075-000-0000 " }),
    ).toEqual({
      ok: true,
      part: { customer: { displayName: "山田 花子", phone: "075-000-0000" } },
    });
    expect(
      buildCustomerPart("new", null, { name: "山田", kana: "ヤマダ", phone: "075-000-0000" }),
    ).toEqual({
      ok: true,
      part: { customer: { displayName: "山田", displayNameKana: "ヤマダ", phone: "075-000-0000" } },
    });
    expect(buildCustomerPart("new", null, { name: "山田", kana: "", phone: " " })).toEqual({
      ok: false,
      error: "氏名と電話番号を入力してください",
    });
  });
});
