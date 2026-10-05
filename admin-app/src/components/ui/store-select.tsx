import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Store } from "@/types/api";

// 実店舗 ID は length<=64 の任意 TEXT（migration 0001）なので "all" も取り得る。
// センチネルが実 ID と衝突するとその店舗が絞り込めなくなるため、集約前に
// change-requests / reservations が使っていた `__all__` に統一する（"all" より衝突しにくい）。
// ponytail: 任意 TEXT の in-band センチネルは理論上どれも実 ID と衝突し得る（空文字含め
// length<=64 は全て有効 ID）。store 行は migration seed（オーナー provision）で生成され
// 顧客/攻撃者入力ではないため、`__all__` を店舗 ID に付ける事故は無視できる。将来 ID が
// ユーザー供給になるなら store 作成時に `id !== '__all__'` を検証してこの前提を守ること。
export const ALL_VALUE = "__all__";

// 呼び出し側の null（全店舗）⇄ Select 内部センチネルの変換。実 ID が偶然
// センチネルと一致しない限り衝突しないことを store-select.test.ts で担保する。
export const toSelectValue = (value: string | null): string => value ?? ALL_VALUE;
export const fromSelectValue = (value: string): string | null =>
  value === ALL_VALUE ? null : value;

// 「全店舗 / 店舗ごと」の絞り込み Select。5ページで同一実装だったものを集約。
// value/onChange は呼び出し側には null（全店舗）で見せ、Select 内部だけの
// センチネルとの変換をここに閉じ込める。単一店舗アカウントでは
// 選ぶ意味がないため stores.length <= 1 で何も描画しない（各呼び出し側で
// 繰り返されていたガードを吸収）。
export function StoreSelect({
  stores,
  value,
  onChange,
  id,
  className = "w-[180px]",
}: Readonly<{
  stores: Store[];
  value: string | null;
  onChange: (storeId: string | null) => void;
  id?: string;
  className?: string;
}>) {
  if (stores.length <= 1) return null;
  return (
    <Select
      value={toSelectValue(value)}
      onValueChange={(v) => onChange(fromSelectValue(v))}
    >
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder="全店舗" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_VALUE}>全店舗</SelectItem>
        {stores.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
