import { useState, useEffect } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormHint, invalidFieldProps } from "@/components/ui/form-hint";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";
import { useServiceUpdate, useServiceDelete } from "@/hooks/use-services";
import { DURATION_PRESETS } from "@/lib/service-options";
import {
  bodyOfName,
  buildPricingPayload,
  categoryCandidates,
  categoryOfName,
  composeServiceName,
  isStalePrefix,
  parseAmountInput,
  prefixCandidates,
} from "@/lib/service-pricing";
import {
  CategorySelect,
  NEW_CATEGORY,
  NO_CATEGORY,
  computeCommonServiceInvalid,
  computeServiceDetailsInvalid,
  effectiveCategory,
} from "@/components/menu/category-select";
import type { Service } from "@/types/api";
import { DetailRow } from "@/components/ui/detail-row";

type StoreOption = { id: string; name: string };

type Props = {
  service: Service | null;
  stores: StoreOption[];
  services: Array<{ id?: string; storeId: string; name: string; active?: boolean }>;
  /** owner/system_admin、または自店舗メニューを開いている staff (呼び出し側で判定)。 */
  canEdit: boolean;
  onClose: () => void;
};

// 保存不可判定は追加ダイアログと共通 (computeCommonServiceInvalid, category-select.tsx)。
type ServiceEditInvalid = ReturnType<typeof computeCommonServiceInvalid>;

function ServiceHeader({ service }: Readonly<{ service: Service }>) {
  return (
    // pr-8: 44px Close (右端 52px 占有) に長いメニュー名が潜らないため。
    <div className="pr-8">
      <h2 className="text-lg font-semibold">{service.name}</h2>
      <div className="mt-1 flex items-center gap-2">
        <Badge variant={service.active ? "default" : "secondary"}>
          {service.active ? "有効" : "無効"}
        </Badge>
        <Badge variant="outline">{service.durationMinutes}分</Badge>
      </div>
    </div>
  );
}

function ServiceEditForm({
  name,
  category,
  newCategory,
  categoryOptions,
  durationMinutes,
  customDuration,
  priceLabel,
  priceAmountInput,
  comboPriceInput,
  comboPrefix,
  comboSelectOptions,
  showComboFields,
  mensMenu,
  editInvalid,
  pending,
  onNameChange,
  onCategoryChange,
  onNewCategoryChange,
  onDurationChange,
  onCustomDurationChange,
  onPriceLabelChange,
  onPriceAmountChange,
  onComboPriceChange,
  onComboPrefixChange,
  onMensMenuChange,
  onSave,
  onCancel,
}: Readonly<{
  name: string;
  category: string;
  newCategory: string;
  categoryOptions: string[];
  durationMinutes: number;
  customDuration: boolean;
  priceLabel: string;
  priceAmountInput: string;
  comboPriceInput: string;
  comboPrefix: string;
  comboSelectOptions: string[];
  showComboFields: boolean;
  mensMenu: boolean;
  editInvalid: ServiceEditInvalid;
  pending: boolean;
  onNameChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onNewCategoryChange: (value: string) => void;
  onDurationChange: (value: number) => void;
  onCustomDurationChange: (value: boolean) => void;
  onPriceLabelChange: (value: string) => void;
  onPriceAmountChange: (value: string) => void;
  onComboPriceChange: (value: string) => void;
  onComboPrefixChange: (value: string) => void;
  onMensMenuChange: (value: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}>) {
  const handlePriceAmountChange = (value: string) => {
    onPriceAmountChange(value);
    if (value.trim() === "") {
      onComboPriceChange("");
      onComboPrefixChange("");
    }
  };

  return (
    <div className="space-y-4">
      <CategorySelect
        idPrefix="edit-service"
        options={categoryOptions}
        value={category}
        newCategory={newCategory}
        onValueChange={onCategoryChange}
        onNewCategoryChange={onNewCategoryChange}
        newCategoryInvalidProps={invalidFieldProps(editInvalid, "category", "service-edit-hint")}
      />
      <div className="space-y-2">
        <Label htmlFor="service-name">メニュー名</Label>
        <Input
          id="service-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="メニュー名を入力"
          {...invalidFieldProps(editInvalid, "name", "service-edit-hint")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="service-price">料金表示（自由記入・任意）</Label>
        <Input
          id="service-price"
          value={priceLabel}
          onChange={(e) => onPriceLabelChange(e.target.value)}
          placeholder="例: ¥5,500 / ¥6,600〜"
          maxLength={80}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="service-price-amount">料金（円・数値・任意）</Label>
        <p className="text-xs text-muted-foreground">
          予約画面の合計金額の計算に使われます。税込の整数で入力してください。
        </p>
        <Input
          id="service-price-amount"
          type="number"
          inputMode="numeric"
          min={0}
          max={1000000}
          step={1}
          value={priceAmountInput}
          onChange={(e) => handlePriceAmountChange(e.target.value)}
          placeholder="例: 1500"
          {...invalidFieldProps(editInvalid, "price", "service-edit-hint")}
        />
      </div>
      {showComboFields && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">組み合わせ割引（任意）</p>
          <p className="text-xs text-muted-foreground">
            選択したカテゴリのメニューと同時に予約されたとき、このメニューの料金が組み合わせ時料金に切り替わります。
          </p>
          <Label htmlFor="service-combo-prefix">対象カテゴリ</Label>
          <Select
            value={comboPrefix === "" ? "__none__" : comboPrefix}
            onValueChange={(value) => onComboPrefixChange(value === "__none__" ? "" : value)}
          >
            <SelectTrigger
              id="service-combo-prefix"
              {...invalidFieldProps(editInvalid, "comboPrefix", "service-edit-hint")}
            >
              <SelectValue placeholder="カテゴリを選択" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">（設定しない）</SelectItem>
              {comboSelectOptions.map((prefix) => (
                <SelectItem key={prefix} value={prefix}>
                  {prefix}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="service-combo-price">組み合わせ時料金（円）</Label>
          <Input
            id="service-combo-price"
            type="number"
            inputMode="numeric"
            min={0}
            max={1000000}
            step={1}
            value={comboPriceInput}
            onChange={(e) => onComboPriceChange(e.target.value)}
            placeholder="例: 1000"
            {...invalidFieldProps(editInvalid, "comboPrice", "service-edit-hint")}
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
              onChange={(e) => onDurationChange(Number(e.target.value))}
              className="w-24"
              {...invalidFieldProps(editInvalid, "duration", "service-edit-hint")}
            />
            <span className="text-sm text-muted-foreground">分</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onCustomDurationChange(false);
                onDurationChange(60);
              }}
            >
              プリセット
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Select
              value={String(durationMinutes)}
              onValueChange={(value) => onDurationChange(Number(value))}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATION_PRESETS.map((duration) => (
                  <SelectItem key={duration} value={String(duration)}>
                    {duration}分
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={() => onCustomDurationChange(true)}>
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
            onChange={(e) => onMensMenuChange(e.target.checked)}
          />
          <span>メンズ向けメニューにする</span>
        </label>
        <p className="text-xs text-muted-foreground">
          メンズ予約窓の対象店舗では、メンズメニューの予約枠を、火曜日は営業時間内すべて、水・土・日曜日は13時以降のみお客様に表示します（月・木曜日は表示しません）。
        </p>
      </div>
      <FormHint id="service-edit-hint" reason={editInvalid} />
      <div className="flex gap-2">
        <Button
          onClick={onSave}
          disabled={editInvalid !== null || pending}
          aria-describedby="service-edit-hint"
        >
          {pending ? "保存中..." : "保存"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}

function ServiceSummary({
  service,
  stalePrefix,
  storeName,
}: Readonly<{ service: Service; stalePrefix: string | null; storeName: string }>) {
  return (
    <div className="space-y-3">
      <Row label="メニュー名" value={service.name} />
      <Row label="所要時間" value={`${service.durationMinutes}分`} />
      <Row label="料金表示" value={service.priceLabel ?? "未設定"} />
      <Row
        label="料金（数値）"
        value={
          service.priceAmount != null
            ? `${service.priceAmount.toLocaleString("ja-JP")}円`
            : "未設定"
        }
      />
      {service.comboPriceAmount != null && service.comboWithPrefix != null && (
        <Row
          label="組み合わせ割引"
          value={`${service.comboWithPrefix}メニューと同時予約で ${service.comboPriceAmount.toLocaleString("ja-JP")}円`}
        />
      )}
      {stalePrefix != null && (
        <p className="text-sm text-amber-600 dark:text-amber-400" role="alert">
          組み合わせ割引の対象カテゴリ「{stalePrefix}」に一致するメニューが現在ありません。割引は適用されない状態です。
        </p>
      )}
      <Row label="店舗" value={storeName} />
      <Row label="状態" value={service.active ? "有効" : "無効"} />
      <Row label="メンズメニュー" value={service.mensMenu ? "はい" : "いいえ"} />
    </div>
  );
}

function ServiceActions({
  service,
  editing,
  privileged,
  pending,
  onEdit,
  onToggleActive,
  onDelete,
}: Readonly<{
  service: Service;
  editing: boolean;
  privileged: boolean;
  pending: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}>) {
  if (editing || !privileged) return null;
  return (
    <div className="flex gap-2">
      <Button variant="outline" onClick={onEdit}>
        編集
      </Button>
      <Button variant="outline" onClick={onToggleActive} disabled={pending}>
        {service.active ? "無効化" : "有効化"}
      </Button>
      <Button variant="destructive" onClick={onDelete}>
        削除
      </Button>
    </div>
  );
}

export function ServiceDetailPanel({ service, stores, services, canEdit, onClose }: Readonly<Props>) {
  const updateMutation = useServiceUpdate();
  const deleteMutation = useServiceDelete();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>(NO_CATEGORY);
  const [newCategory, setNewCategory] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [customDuration, setCustomDuration] = useState(false);
  const [priceLabel, setPriceLabel] = useState("");
  const [mensMenu, setMensMenu] = useState(false);
  const [priceAmountInput, setPriceAmountInput] = useState("");
  const [comboPriceInput, setComboPriceInput] = useState("");
  const [comboPrefix, setComboPrefix] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    setEditing(false);
    setDeleteConfirm(false);
  }, [service?.id]);

  const startEdit = () => {
    if (!service) return;
    // 保存名「カテゴリ｜名前」を分解して初期値にする (保存時に composeServiceName で復元)。
    setName(bodyOfName(service.name));
    setCategory(categoryOfName(service.name) ?? NO_CATEGORY);
    setNewCategory("");
    setDurationMinutes(service.durationMinutes);
    setCustomDuration(!DURATION_PRESETS.includes(service.durationMinutes));
    setPriceLabel(service.priceLabel ?? "");
    setMensMenu(service.mensMenu);
    setPriceAmountInput(service.priceAmount != null ? String(service.priceAmount) : "");
    setComboPriceInput(service.comboPriceAmount != null ? String(service.comboPriceAmount) : "");
    setComboPrefix(service.comboWithPrefix ?? "");
    setEditing(true);
  };

  const pricing = buildPricingPayload({ priceAmountInput, comboPriceInput, comboPrefix });
  const comboCategoryOptions = service ? prefixCandidates(services, service.storeId) : [];
  // メニュー自体のカテゴリ候補は combo 用と別に導出する (combo 側は40文字超を
  // サーバが拒否するため除外するが、カテゴリ自体に単体の長さ制限は無い)。
  // 編集中メニューの現在カテゴリが (改名などで) 候補に無い場合も選択肢に残す。
  const storeCategoryOptions = service ? categoryCandidates(services, service.storeId) : [];
  const menuCategoryOptions =
    category !== NO_CATEGORY && category !== NEW_CATEGORY && !storeCategoryOptions.includes(category)
      ? [category, ...storeCategoryOptions]
      : storeCategoryOptions;
  // 保存済みの prefix がカテゴリ改名などで既存メニューに一致しなくなっていても、
  // 編集中は選択肢に残して見えるようにする (候補に無い値が Select に入ると表示が空になるため)。
  const comboSelectOptions =
    comboPrefix !== "" && !comboCategoryOptions.includes(comboPrefix)
      ? [comboPrefix, ...comboCategoryOptions]
      : comboCategoryOptions;
  const showComboFields =
    typeof parseAmountInput(priceAmountInput) === "number" && comboSelectOptions.length > 0;
  const stalePrefix =
    service && isStalePrefix(service.comboWithPrefix, services, service.storeId, service.id)
      ? service.comboWithPrefix
      : null;

  // カテゴリも名前欄も初期分解値から触っていなければ、保存名は元の文字列を
  // そのまま送る。composeServiceName は trim を伴うため、区切り周辺に空白を
  // 持つ既存名が価格だけの編集で書き換わるのを防ぐ (round-trip の完全可逆性)。
  const nameUntouched =
    service !== null &&
    category === (categoryOfName(service.name) ?? NO_CATEGORY) &&
    name === bodyOfName(service.name);

  // 保存不可の理由を1ソースから導出 (create dialog と同じパターン)。disabled 判定・
  // フィールドの aria-invalid/aria-describedby・メッセージ表示がここから配線される。
  // 未変更保存は service.name をそのまま送るため名前・カテゴリ検証を免除する。
  // 旧UI・API 直経由の変則名 (複数｜・空本文など) は分解結果が新規則に通らないが、
  // それを理由に価格・所要時間だけの編集まで塞がないため。
  const editInvalid = nameUntouched
    ? computeServiceDetailsInvalid(durationMinutes, pricing)
    : computeCommonServiceInvalid(name, category, newCategory, durationMinutes, pricing);

  const saveEdit = () => {
    if (!service || editInvalid !== null || !pricing.ok) return;
    updateMutation.mutate(
      {
        id: service.id,
        storeId: service.storeId,
        name: nameUntouched
          ? service.name
          : composeServiceName(effectiveCategory(category, newCategory), name),
        durationMinutes,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceLabel: priceLabel.trim() || null,
        ...pricing.payload,
        active: service.active,
        mensMenu,
      },
      {
        onSuccess: () => {
          setEditing(false);
        },
      },
    );
  };

  const handleToggleActive = () => {
    if (!service) return;
    updateMutation.mutate(
      {
        id: service.id,
        storeId: service.storeId,
        name: service.name,
        durationMinutes: service.durationMinutes,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceLabel: service.priceLabel,
        priceAmount: service.priceAmount ?? null,
        comboPriceAmount: service.comboPriceAmount ?? null,
        comboWithPrefix: service.comboWithPrefix ?? null,
        active: !service.active,
        // mensMenu は送らない: サーバが未指定を「現在値を維持」として扱うので、
        // 有効/無効の切り替えだけでフラグが落ちることはない。
      },
    );
  };

  const handleDelete = () => {
    if (!service) return;
    deleteMutation.mutate(service.id, {
      onSuccess: () => {
        setDeleteConfirm(false);
        onClose();
      },
      onSettled: () => {
        setDeleteConfirm(false);
      },
    });
  };

  const storeName =
    stores.find((s) => s.id === service?.storeId)?.name ?? service?.storeId ?? "";

  return (
    <>
      <Sheet open={!!service} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          {!service ? (
            <div className="space-y-4 pt-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-6 pt-6">
              <ServiceHeader service={service} />

              <Separator />

              {editing ? (
                <ServiceEditForm
                  name={name}
                  category={category}
                  newCategory={newCategory}
                  categoryOptions={menuCategoryOptions}
                  durationMinutes={durationMinutes}
                  customDuration={customDuration}
                  priceLabel={priceLabel}
                  mensMenu={mensMenu}
                  onMensMenuChange={setMensMenu}
                  priceAmountInput={priceAmountInput}
                  comboPriceInput={comboPriceInput}
                  comboPrefix={comboPrefix}
                  comboSelectOptions={comboSelectOptions}
                  showComboFields={showComboFields}
                  editInvalid={editInvalid}
                  pending={updateMutation.isPending}
                  onNameChange={setName}
                  onCategoryChange={setCategory}
                  onNewCategoryChange={setNewCategory}
                  onDurationChange={setDurationMinutes}
                  onCustomDurationChange={setCustomDuration}
                  onPriceLabelChange={setPriceLabel}
                  onPriceAmountChange={setPriceAmountInput}
                  onComboPriceChange={setComboPriceInput}
                  onComboPrefixChange={setComboPrefix}
                  onSave={saveEdit}
                  onCancel={() => setEditing(false)}
                />
              ) : (
                <ServiceSummary service={service} stalePrefix={stalePrefix} storeName={storeName} />
              )}

              <ServiceActions
                service={service}
                editing={editing}
                privileged={canEdit}
                pending={updateMutation.isPending}
                onEdit={startEdit}
                onToggleActive={handleToggleActive}
                onDelete={() => setDeleteConfirm(true)}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <PendingConfirmDialog
        open={deleteConfirm}
        pending={deleteMutation.isPending}
        title="メニューを削除"
        description={`「${service?.name ?? ""}」を削除しますか？将来の予約がある場合は削除できません。`}
        confirmLabel="削除する"
        onOpenChange={setDeleteConfirm}
        onConfirm={handleDelete}
      />
    </>
  );
}

export function Row({ label, value }: Readonly<{ label: string; value: string }>) {
  return <DetailRow label={label} value={value} className="flex items-center justify-between text-sm" />;
}
