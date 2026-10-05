import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { InvalidReason } from "@/components/ui/form-hint";
import { buildPricingPayload, composedNameError } from "@/lib/service-pricing";

// Select 内部センチネル。categoryOfName は最初の「｜」より前を返すため、解析された
// 実カテゴリは「｜」を含み得ない。「｜」入りの値をセンチネルにすることで、どんな既存
// services.name (直接 API/DB 由来を含む) とも衝突が構造的に起きない。
export const NO_CATEGORY = "｜none｜";
export const NEW_CATEGORY = "｜new｜";

/** value (センチネル込み) と新規入力から、name 合成に使う実カテゴリ文字列を得る。 */
export const effectiveCategory = (value: string, newCategory: string): string => {
  if (value === NEW_CATEGORY) return newCategory.trim();
  if (value === NO_CATEGORY) return "";
  return value;
};

/**
 * 新規カテゴリ名の検証 (追加・編集ダイアログ共通)。エラーメッセージ、問題なければ null。
 * 「｜」の拒否は name 分解の round-trip 保護と同時に、「｜」入りセンチネルとの一致も排除する。
 */
export const validateNewCategory = (newCategory: string): string | null => {
  const trimmed = newCategory.trim();
  if (!trimmed) return "新しいカテゴリ名を入力してください";
  if (trimmed.includes("｜")) return "カテゴリ名に「｜」は使えません";
  if (trimmed.length > 40) return "カテゴリ名は40文字以内で入力してください";
  return null;
};

export type ServiceFormField = "name" | "category" | "duration" | "price" | "comboPrice" | "comboPrefix";

// 名前・カテゴリの保存不可判定 (名前 → カテゴリ → 合成長)。
// カテゴリと名前は保存時に「カテゴリ｜名前」へ合成するため、どちらにも区切りの ｜ を
// 含められない (含むと編集時の分解が壊れる)。
// 編集フォームはカテゴリ・名前が未変更のとき保存名を元のまま送るため、この検証を
// 免除する (旧UI・API 直経由の「複数｜」「空本文」等の変則名でも価格だけの編集を塞がない)。
export function computeServiceNameInvalid(
  name: string,
  category: string,
  newCategory: string,
): InvalidReason<"name" | "category"> {
  if (!name.trim()) return { field: "name", message: "メニュー名を入力してください" };
  if (name.includes("｜")) {
    return { field: "name", message: "メニュー名に「｜」は使えません。カテゴリは上の欄で選択してください" };
  }
  if (category === NEW_CATEGORY) {
    const message = validateNewCategory(newCategory);
    if (message) return { field: "category", message };
  }
  // 名前・カテゴリとも単体の文字数上限は無いため、合成がサーバ上限100字を超え得る。
  const message = composedNameError(effectiveCategory(category, newCategory), name);
  if (message) return { field: "name", message };
  return null;
}

// 所要時間・料金の保存不可判定 (名前検証を免除する未変更保存でも常に適用する)。
export function computeServiceDetailsInvalid(
  durationMinutes: number,
  pricing: ReturnType<typeof buildPricingPayload>,
): InvalidReason<"duration" | "price" | "comboPrice" | "comboPrefix"> {
  if (Number.isNaN(durationMinutes) || durationMinutes < 5 || durationMinutes > 1440) {
    return { field: "duration", message: "所要時間は5〜1440分の数値で入力してください" };
  }
  if (!pricing.ok) return { field: pricing.field, message: pricing.message };
  return null;
}

// 追加・編集フォーム共通の保存不可判定 (名前 → カテゴリ → 合成長 → 所要時間 → 料金)。
export function computeCommonServiceInvalid(
  name: string,
  category: string,
  newCategory: string,
  durationMinutes: number,
  pricing: ReturnType<typeof buildPricingPayload>,
): InvalidReason<ServiceFormField> {
  return (
    computeServiceNameInvalid(name, category, newCategory) ??
    computeServiceDetailsInvalid(durationMinutes, pricing)
  );
}

type Props = Readonly<{
  /** DOM id の接頭辞 (create-service / edit-service)。 */
  idPrefix: string;
  /** 既存カテゴリ候補 (categoryCandidates 由来)。編集中の現在値も含めて渡す。 */
  options: string[];
  /** NO_CATEGORY / NEW_CATEGORY / 既存カテゴリ名。 */
  value: string;
  newCategory: string;
  onValueChange: (value: string) => void;
  onNewCategoryChange: (value: string) => void;
  /** 新規カテゴリ入力に付ける invalidFieldProps(...) の spread。 */
  newCategoryInvalidProps?: Record<string, unknown>;
}>;

// メニュー名の「カテゴリ｜名前」プレフィックスを選択制にする共有ブロック。
// 追加ダイアログと編集フォームで同じ見た目・同じ文言を使う。
export function CategorySelect({
  idPrefix,
  options,
  value,
  newCategory,
  onValueChange,
  onNewCategoryChange,
  newCategoryInvalidProps,
}: Props) {
  // options は categoryOfName 由来 (「｜」を含み得ない) なのでセンチネルと衝突しない。
  const resolved = effectiveCategory(value, newCategory);
  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-category`}>カテゴリ</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={`${idPrefix}-category`}>
          <SelectValue placeholder="カテゴリを選択" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_CATEGORY}>（カテゴリなし）</SelectItem>
          {options.map((category) => (
            <SelectItem key={category} value={category}>
              {category}
            </SelectItem>
          ))}
          <SelectItem value={NEW_CATEGORY}>＋ 新しいカテゴリを作る</SelectItem>
        </SelectContent>
      </Select>
      {value === NEW_CATEGORY && (
        <>
          <Input
            id={`${idPrefix}-category-new`}
            value={newCategory}
            onChange={(e) => onNewCategoryChange(e.target.value)}
            placeholder="例: ヘッドスパ"
            aria-label="新しいカテゴリ名"
            {...newCategoryInvalidProps}
          />
          {/* 予約画面の表示順は public-options.ts の SQL が既存4カテゴリを
              先頭固定しているため、新しいカテゴリはその後ろに並ぶ。 */}
          <p className="text-xs text-muted-foreground">
            予約画面では「脱毛」「フェイシャル」「マッサージ」「ネイル・フットケア」の順に表示され、新しいカテゴリはその後ろに並びます。
          </p>
        </>
      )}
      {resolved === "メンズ" && (
        <p className="text-xs text-muted-foreground">
          「メンズ」カテゴリは表示上の分類です。男性のお客様向けの予約枠の制限は、カテゴリではなく下の「メンズメニュー」チェックで設定されます。
        </p>
      )}
    </div>
  );
}
