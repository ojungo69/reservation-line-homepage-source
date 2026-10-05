import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormHint, invalidFieldProps, type InvalidReason } from "@/components/ui/form-hint";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useServiceCreate } from "@/hooks/use-services";
import { DURATION_PRESETS } from "@/lib/service-options";
import {
  buildPricingPayload,
  categoryCandidates,
  composeServiceName,
  parseAmountInput,
  prefixCandidates,
} from "@/lib/service-pricing";
import {
  CategorySelect,
  NO_CATEGORY,
  type ServiceFormField,
  computeCommonServiceInvalid,
  effectiveCategory,
} from "@/components/menu/category-select";

type StoreOption = { id: string; name: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stores: StoreOption[];
  defaultStoreId: string | null;
  services: Array<{ storeId: string; name: string }>;
};

// 保存不可の理由を導出する。共通部分は computeCommonServiceInvalid (category-select.tsx)
// に集約し、追加ダイアログ固有の店舗未選択チェックだけ先頭に足す。
function computeServiceInvalid(
  name: string,
  category: string,
  newCategory: string,
  storeId: string,
  durationMinutes: number,
  pricing: ReturnType<typeof buildPricingPayload>,
): InvalidReason<ServiceFormField | "storeId"> {
  if (!storeId) return { field: "storeId", message: "店舗を選択してください" };
  return computeCommonServiceInvalid(name, category, newCategory, durationMinutes, pricing);
}

export function ServiceCreateDialog({ open, onOpenChange, stores, defaultStoreId, services }: Readonly<Props>) {
  const createMutation = useServiceCreate();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>(NO_CATEGORY);
  const [newCategory, setNewCategory] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [customDuration, setCustomDuration] = useState(false);
  const [priceLabel, setPriceLabel] = useState("");
  const [priceAmountInput, setPriceAmountInput] = useState("");
  const [comboPriceInput, setComboPriceInput] = useState("");
  const [comboPrefix, setComboPrefix] = useState("");
  const [mensMenu, setMensMenu] = useState(false);
  const [storeId, setStoreId] = useState(defaultStoreId ?? stores[0]?.id ?? "");
  const idempotencyKeyRef = useRef<string>("");
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  const reset = () => {
    setName("");
    setCategory(NO_CATEGORY);
    setNewCategory("");
    setDurationMinutes(60);
    setCustomDuration(false);
    setPriceLabel("");
    setPriceAmountInput("");
    setComboPriceInput("");
    setComboPrefix("");
    setMensMenu(false);
    setStoreId(defaultStoreId ?? stores[0]?.id ?? "");
    idempotencyKeyRef.current = crypto.randomUUID();
  };

  const pricing = buildPricingPayload({ priceAmountInput, comboPriceInput, comboPrefix });
  // 組み合わせ割引欄は、数値料金が入力済みで、かつ選べるカテゴリ (同店舗メニュー名の ｜ 前)
  // が存在するときだけ出す。カテゴリは自店舗の既存メニューからのみ選択できる。
  const comboCategoryOptions = prefixCandidates(services, storeId);
  const showComboFields =
    typeof parseAmountInput(priceAmountInput) === "number" && comboCategoryOptions.length > 0;
  // メニュー自体のカテゴリ候補は combo 用と別に導出する (combo 側は40文字超を
  // サーバが拒否するため除外するが、カテゴリ自体に単体の長さ制限は無い)。
  const menuCategoryOptions = categoryCandidates(services, storeId);

  // 保存不可の理由。disabled 判定・submit guard・表示をすべてこの1つから導出し、
  // 条件の乖離 (旧: disabled は NaN と 1440 超を見ていなかった) を防ぐ。
  // duration が不正になり得るのはカスタム数値入力のときだけ (プリセットは常に有効値)。
  const serviceInvalid = computeServiceInvalid(name, category, newCategory, storeId, durationMinutes, pricing);

  const handleSubmit = () => {
    if (serviceInvalid !== null || !pricing.ok) return;
    createMutation.mutate(
      {
        storeId,
        name: composeServiceName(effectiveCategory(category, newCategory), name),
        durationMinutes,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceLabel: priceLabel.trim() || null,
        ...pricing.payload,
        active: true,
        mensMenu,
        idempotencyKey: idempotencyKeyRef.current,
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          if (createMutation.isPending) return;
          reset();
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>メニュー追加</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-1">
          <CategorySelect
            idPrefix="create-service"
            options={menuCategoryOptions}
            value={category}
            newCategory={newCategory}
            onValueChange={setCategory}
            onNewCategoryChange={setNewCategory}
            newCategoryInvalidProps={invalidFieldProps(serviceInvalid, "category", "service-create-hint")}
          />
          <div className="space-y-2">
            <Label htmlFor="create-service-name">メニュー名</Label>
            <Input
              id="create-service-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 全身脱毛（フォト付き）"
              autoFocus
              {...invalidFieldProps(serviceInvalid, "name", "service-create-hint")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-service-store">店舗</Label>
            <Select
              value={storeId}
              onValueChange={(v) => {
                setStoreId(v);
                // カテゴリは店舗固有 — 店舗を切り替えたら前店舗のカテゴリが
                // 見えないまま payload に残らないよう、メニューカテゴリも
                // 組み合わせ欄もクリアする。
                setCategory(NO_CATEGORY);
                setNewCategory("");
                setComboPrefix("");
                setComboPriceInput("");
              }}
            >
              <SelectTrigger
                id="create-service-store"
                {...invalidFieldProps(serviceInvalid, "storeId", "service-create-hint")}
              >
                <SelectValue placeholder="店舗を選択" />
              </SelectTrigger>
              <SelectContent>
                {stores.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-service-price">料金表示（自由記入・任意）</Label>
            <Input
              id="create-service-price"
              value={priceLabel}
              onChange={(e) => setPriceLabel(e.target.value)}
              placeholder="例: ¥5,500 / ¥6,600〜"
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-service-price-amount">料金（円・数値・任意）</Label>
            <p className="text-xs text-muted-foreground">
              予約画面の合計金額の計算に使われます。税込の整数で入力してください。
            </p>
            <Input
              id="create-service-price-amount"
              type="number"
              inputMode="numeric"
              min={0}
              max={1000000}
              step={1}
              value={priceAmountInput}
              onChange={(e) => {
                setPriceAmountInput(e.target.value);
                if (e.target.value.trim() === "") {
                  setComboPriceInput("");
                  setComboPrefix("");
                }
              }}
              placeholder="例: 1500"
              {...invalidFieldProps(serviceInvalid, "price", "service-create-hint")}
            />
          </div>
          {showComboFields && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">組み合わせ割引（任意）</p>
              <p className="text-xs text-muted-foreground">
                選択したカテゴリのメニューと同時に予約されたとき、このメニューの料金が組み合わせ時料金に切り替わります。
              </p>
              <Label htmlFor="create-service-combo-prefix">対象カテゴリ</Label>
              <Select
                value={comboPrefix === "" ? "__none__" : comboPrefix}
                onValueChange={(v) => setComboPrefix(v === "__none__" ? "" : v)}
              >
                <SelectTrigger
                  id="create-service-combo-prefix"
                  {...invalidFieldProps(serviceInvalid, "comboPrefix", "service-create-hint")}
                >
                  <SelectValue placeholder="カテゴリを選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">（設定しない）</SelectItem>
                  {comboCategoryOptions.map((prefix) => (
                    <SelectItem key={prefix} value={prefix}>
                      {prefix}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor="create-service-combo-price">組み合わせ時料金（円）</Label>
              <Input
                id="create-service-combo-price"
                type="number"
                inputMode="numeric"
                min={0}
                max={1000000}
                step={1}
                value={comboPriceInput}
                onChange={(e) => setComboPriceInput(e.target.value)}
                placeholder="例: 1000"
                {...invalidFieldProps(serviceInvalid, "comboPrice", "service-create-hint")}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label>所要時間</Label>
            {customDuration ? (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  className="w-24"
                  {...invalidFieldProps(serviceInvalid, "duration", "service-create-hint")}
                />
                <span className="text-sm text-muted-foreground">分</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCustomDuration(false);
                    setDurationMinutes(60);
                  }}
                >
                  プリセット
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  value={String(durationMinutes)}
                  onValueChange={(v) => setDurationMinutes(Number(v))}
                >
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_PRESETS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d}分
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCustomDuration(true)}
                >
                  カスタム
                </Button>
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label>メンズメニュー</Label>
            {/* 名前や ID ではなくこのフラグで判定する: 管理画面から追加したメニューは
                UUID の ID になるため、命名規約に頼ると制限をすり抜ける。 */}
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={mensMenu}
                onChange={(e) => setMensMenu(e.target.checked)}
              />
              <span>メンズ向けメニューにする</span>
            </label>
            <p className="text-xs text-muted-foreground">
              メンズ予約窓の対象店舗では、メンズメニューの予約枠を、火曜日は営業時間内すべて、水・土・日曜日は13時以降のみお客様に表示します（月・木曜日は表示しません）。
            </p>
          </div>
          <FormHint id="service-create-hint" reason={serviceInvalid} />
          <DialogFooter>
            <Button
              onClick={handleSubmit}
              disabled={serviceInvalid !== null || createMutation.isPending}
              aria-describedby="service-create-hint"
            >
              {createMutation.isPending ? "追加中..." : "追加"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
