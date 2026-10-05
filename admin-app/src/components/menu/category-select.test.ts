import { describe, expect, it } from "vitest";
import {
  NEW_CATEGORY,
  NO_CATEGORY,
  effectiveCategory,
  validateNewCategory,
} from "./category-select";

describe("effectiveCategory", () => {
  it("センチネルと新規入力を実カテゴリ文字列へ解決する", () => {
    expect(effectiveCategory(NO_CATEGORY, "")).toBe("");
    expect(effectiveCategory("脱毛", "")).toBe("脱毛");
    expect(effectiveCategory(NEW_CATEGORY, " ヘッドスパ ")).toBe("ヘッドスパ");
  });
});

describe("validateNewCategory", () => {
  it("空・空白のみを拒否する", () => {
    expect(validateNewCategory("")).toMatch(/入力してください/);
    expect(validateNewCategory("   ")).toMatch(/入力してください/);
  });

  it("区切り文字 ｜ を含む名前を拒否する (分解の round-trip を守る)", () => {
    expect(validateNewCategory("脱毛｜光")).toMatch(/「｜」は使えません/);
  });

  it("センチネル文字列も「｜」規則で拒否される (制御値として保存され得ない)", () => {
    expect(validateNewCategory(NO_CATEGORY)).toMatch(/「｜」は使えません/);
    expect(validateNewCategory(NEW_CATEGORY)).toMatch(/「｜」は使えません/);
    expect(validateNewCategory(` ${NO_CATEGORY} `)).toMatch(/「｜」は使えません/);
  });

  it("センチネルは「｜」を含む (categoryOfName の解析結果と構造的に衝突しない)", () => {
    // categoryOfName は最初の「｜」より前を返すため、解析された実カテゴリは
    // 「｜」を含み得ない。この不変条件がセンチネル衝突の再発を防ぐ。
    expect(NO_CATEGORY).toContain("｜");
    expect(NEW_CATEGORY).toContain("｜");
  });

  it("40文字を超える名前を拒否し、40文字ちょうどは許可する", () => {
    expect(validateNewCategory("あ".repeat(41))).toMatch(/40文字以内/);
    expect(validateNewCategory("あ".repeat(40))).toBeNull();
  });

  it("通常のカテゴリ名は許可する", () => {
    expect(validateNewCategory("ヘッドスパ")).toBeNull();
  });
});
