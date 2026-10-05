import { useState, useMemo, useEffect, useRef } from "react";
import { Field } from "@/components/ui/field";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { badgeVariants } from "@/components/ui/badge-variants";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PendingConfirmDialog,
} from "@/components/ui/pending-confirm-dialog";
import { useCreateReservation, useAvailableSlots } from "@/hooks/use-reservations";
import { useSettings } from "@/hooks/use-settings";
import { useCustomerSearch } from "@/hooks/use-customers";
import { formatJstDate, formatTime } from "@/lib/timeline";
import { buildCustomerPart, type CreateMode } from "@/lib/reservation-create-mode";
import {
  createReservationPayloadSignature,
  resolveReservationCreateKey,
  type ReservationCreateKeyState,
  type ReservationCreatePayloadWithoutKey,
} from "@/lib/reservation-create-idempotency";
import { cn } from "@/lib/utils";
import { displayServiceName } from "@/lib/service-pricing";
import { RESERVATION_ORIGIN_OPTIONS } from "@/lib/reservation-origin";
import {
  MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES,
  MAX_SERVICE_SELECTIONS,
  buildServiceSelectionPayload,
  canAddService,
  isOverSelectionLimit,
  nextTimeAfterServiceChange,
  splitRebookServiceIds,
  totalServiceDuration,
  type SelectableService,
} from "@/lib/service-selection";
import type { AvailableSlot, CustomerSearchItem, CreateReservationPayload, CreateReservationOrigin } from "@/types/api";

type ReservationCreatePanelProps = {
  open: boolean;
  onClose: () => void;
  defaultStoreId: string | null;
  defaultResourceId: string | null;
  defaultDate: Date;
  defaultMinutes: number | null;
  defaultServiceIds?: string[] | null;
  defaultCustomer?: {
    id?: string | null;
    displayName: string;
    displayNameKana?: string | null;
    phone?: string | null;
  } | null;
};

type SelectedCustomer = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalized: string | null;
};

type ServiceChoice = SelectableService & { name: string };

// Candidate list shows only the last 4 digits; selecting a customer books against
// their customerId, so the raw phone never needs to enter the form.
const maskPhone = (phone: string | null): string =>
  phone && phone.length >= 4 ? `***${phone.slice(-4)}` : "電話なし";

// 空き枠フィールドの表示分岐（取得中/取得失敗/0件/一覧）をネスト三項演算子から関数化。
function renderSlotsField({
  fetching,
  failed,
  slotsByResource,
  resourceId,
  time,
  onSlotClick,
}: {
  fetching: boolean;
  failed: boolean;
  slotsByResource: Map<string, { name: string; slots: AvailableSlot[] }>;
  resourceId: string;
  time: string;
  onSlotClick: (slot: { resourceId: string; startAt: string }) => void;
}) {
  if (fetching) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-3/4" />
      </div>
    );
  }
  if (failed) {
    return (
      <p className="text-sm text-destructive" role="alert">
        空き枠を取得できませんでした。時間をおいて再度お試しください。
      </p>
    );
  }
  if (slotsByResource.size === 0) {
    return <p className="text-sm text-muted-foreground">空き枠なし</p>;
  }
  return (
    <div className="space-y-3">
      {Array.from(slotsByResource.entries()).map(([resId, { name, slots }]) => (
        <div key={resId} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{name}</p>
          <div className="flex flex-wrap gap-1">
            {slots.filter((s) => s.available).map((slot) => {
              const selected = resourceId === slot.resourceId &&
                time === formatTime(slot.startAt);
              return (
                <button
                  key={`${slot.resourceId}-${slot.startAt}`}
                  type="button"
                  className={cn(
                    badgeVariants({ variant: selected ? "default" : "outline" }),
                    "min-h-11 min-w-11 cursor-pointer justify-center text-xs",
                  )}
                  onClick={() => onSlotClick(slot)}
                >
                  {formatTime(slot.startAt)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// 既存顧客検索結果の表示分岐（検索中/取得失敗/0件/一覧）をネスト三項演算子から関数化。
// 検索失敗を「該当なし」と同じ文言にすると、既存顧客がいるのに新規として作り直され
// 顧客が重複する。空き枠取得と同じ形で失敗と 0 件を区別する (cubic P2)。
function renderCustomerResults({
  loading,
  error,
  results,
  onSelect,
}: {
  loading: boolean;
  error: boolean;
  results: CustomerSearchItem[];
  onSelect: (c: CustomerSearchItem) => void;
}) {
  if (loading) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">検索中...</p>;
  }
  if (error) {
    return (
      <p className="px-3 py-2 text-xs text-destructive" role="alert">
        顧客を検索できませんでした。時間をおいて再度お試しください。
      </p>
    );
  }
  if (results.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        該当する顧客がいません。
      </p>
    );
  }
  return (
    <ul aria-label="顧客候補">
      {results.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent"
            onClick={() => onSelect(c)}
          >
            <span className="text-sm font-medium">{c.displayName}</span>
            <span className="text-xs text-muted-foreground">
              {[c.displayNameKana, maskPhone(c.phoneNormalized)].filter(Boolean).join(" / ")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ServiceSelectionFieldset({
  storeId,
  services,
  selectedIds,
  totalMinutes,
  limitHintVisible,
  overLimit,
  unavailableNotice,
  hintIds,
  onToggle,
}: Readonly<{
  storeId: string;
  services: ServiceChoice[];
  selectedIds: string[];
  totalMinutes: number;
  limitHintVisible: boolean;
  overLimit: boolean;
  unavailableNotice: string | null;
  hintIds: string | undefined;
  onToggle: (id: string) => void;
}>) {
  return (
    <fieldset className="space-y-1" aria-describedby={hintIds}>
      <legend className="text-xs font-medium text-muted-foreground">メニュー（複数選択可）</legend>
      {services.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {storeId ? "選択できるメニューがありません" : "店舗を選択してください"}
        </p>
      ) : (
        <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-2">
          {services.map((service) => {
            const checked = selectedIds.includes(service.id);
            const disabled = !checked && !canAddService(service, selectedIds, services);
            return (
              <label
                key={service.id}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(service.id)}
                />
                <span>{service.name} ({service.durationMinutes}分)</span>
              </label>
            );
          })}
        </div>
      )}
      {selectedIds.length > 0 && (
        <p id="rcp-service-summary" className="text-xs text-muted-foreground">
          選択中 {selectedIds.length}件・施術 合計{totalMinutes}分
        </p>
      )}
      {limitHintVisible && (
        <p id="rcp-service-limit-hint" className="text-xs text-muted-foreground">
          メニューは最大{MAX_SERVICE_SELECTIONS}件・施術時間の合計{MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES}分まで選択できます
        </p>
      )}
      {overLimit && (
        <p id="rcp-service-over-limit" className="text-xs text-destructive" role="alert">
          メニューは最大{MAX_SERVICE_SELECTIONS}件・施術時間の合計{MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES}分以内になるように選択を減らしてください
        </p>
      )}
      {unavailableNotice && (
        <p id="rcp-service-unavailable" className="text-xs text-muted-foreground" role="status">{unavailableNotice}</p>
      )}
    </fieldset>
  );
}

function CustomerFields({
  mode,
  selectedCustomer,
  customerSearch,
  searchOpen,
  searchLoading,
  searchError,
  customerResults,
  customerName,
  customerKana,
  customerPhone,
  onExistingMode,
  onNewMode,
  onCustomerSearchChange,
  onCustomerSelect,
  onCustomerClear,
  onCustomerNameChange,
  onCustomerKanaChange,
  onCustomerPhoneChange,
}: Readonly<{
  mode: CreateMode;
  selectedCustomer: SelectedCustomer | null;
  customerSearch: string;
  searchOpen: boolean;
  searchLoading: boolean;
  searchError: boolean;
  customerResults: CustomerSearchItem[];
  customerName: string;
  customerKana: string;
  customerPhone: string;
  onExistingMode: () => void;
  onNewMode: () => void;
  onCustomerSearchChange: (value: string) => void;
  onCustomerSelect: (customer: CustomerSearchItem) => void;
  onCustomerClear: () => void;
  onCustomerNameChange: (value: string) => void;
  onCustomerKanaChange: (value: string) => void;
  onCustomerPhoneChange: (value: string) => void;
}>) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-muted-foreground">顧客情報</h4>

      <div className="flex gap-2" role="tablist" aria-label="顧客の指定方法">
        <Button
          type="button"
          variant={mode === "existing" ? "default" : "outline"}
          className="flex-1"
          role="tab"
          aria-selected={mode === "existing"}
          onClick={onExistingMode}
        >
          既存のお客様
        </Button>
        <Button
          type="button"
          variant={mode === "new" ? "default" : "outline"}
          className="flex-1"
          role="tab"
          aria-selected={mode === "new"}
          onClick={onNewMode}
        >
          新規のお客様
        </Button>
      </div>

      {mode === "existing" ? (
        <div className="space-y-2">
          {selectedCustomer ? (
            <div className="rounded-md border bg-accent/30 p-3">
              <p className="text-sm font-medium">{selectedCustomer.displayName} 様で予約</p>
              <p className="text-xs text-muted-foreground">
                {[selectedCustomer.displayNameKana, maskPhone(selectedCustomer.phoneNormalized)]
                  .filter(Boolean)
                  .join(" / ")}
              </p>
              <Button
                type="button"
                variant="ghost"
                className="mt-1 h-auto p-0 text-xs"
                onClick={onCustomerClear}
              >
                選び直す
              </Button>
            </div>
          ) : (
            <Field id="rcp-customer-search" label="既存顧客を検索">
              <div className="relative">
                <Input
                  id="rcp-customer-search"
                  type="search"
                  aria-describedby="rcp-customer-search-help"
                  aria-controls={searchOpen ? "rcp-customer-results" : undefined}
                  value={customerSearch}
                  onChange={(event) => onCustomerSearchChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") onCustomerSearchChange("");
                  }}
                  placeholder="名前・カナ・電話で検索"
                  autoComplete="off"
                />
                <p id="rcp-customer-search-help" className="sr-only">
                  2文字以上入力すると候補が表示されます。Tabキーで候補へ移動して選択できます。
                </p>
                {searchOpen && (
                  <div
                    id="rcp-customer-results"
                    className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover shadow-md"
                    aria-live="polite"
                  >
                    {renderCustomerResults({
                      loading: searchLoading,
                      error: searchError,
                      results: customerResults,
                      onSelect: onCustomerSelect,
                    })}
                  </div>
                )}
              </div>
            </Field>
          )}
        </div>
      ) : (
        <>
          <Field id="rcp-customer-name" label="氏名">
            <Input
              id="rcp-customer-name"
              value={customerName}
              onChange={(event) => onCustomerNameChange(event.target.value)}
              placeholder="山田 花子"
            />
          </Field>
          <Field id="rcp-customer-kana" label="カナ">
            <Input
              id="rcp-customer-kana"
              value={customerKana}
              onChange={(event) => onCustomerKanaChange(event.target.value)}
              placeholder="ヤマダ ハナコ"
            />
          </Field>
          <Field id="rcp-customer-phone" label="電話番号">
            <Input
              id="rcp-customer-phone"
              type="tel"
              value={customerPhone}
              onChange={(event) => onCustomerPhoneChange(event.target.value)}
              placeholder="090-1234-5678"
            />
          </Field>
        </>
      )}
    </div>
  );
}

function ReservationConfirmationDialog({
  open,
  pending,
  customerName,
  storeName,
  serviceNames,
  totalMinutes,
  resourceName,
  date,
  time,
  onClose,
  onConfirm,
}: Readonly<{
  open: boolean;
  pending: boolean;
  customerName: string;
  storeName: string;
  serviceNames: string[];
  totalMinutes: number;
  resourceName: string;
  date: string;
  time: string;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  const description = (
    <span className="space-y-1 text-sm text-foreground">
      <span className="block">
        <span className="text-muted-foreground">お客様：</span>
        {customerName} 様
      </span>
      <span className="block">
        <span className="text-muted-foreground">店舗：</span>
        {storeName}
      </span>
      <span className="block">
        <span className="text-muted-foreground">メニュー：</span>
        {serviceNames.join(" / ")}
        {serviceNames.length > 1 && (
          <span className="text-muted-foreground">（施術 合計{totalMinutes}分）</span>
        )}
      </span>
      <span className="block">
        <span className="text-muted-foreground">担当：</span>
        {resourceName}
      </span>
      <span className="block">
        <span className="text-muted-foreground">日時：</span>
        {date} {time}
      </span>
    </span>
  );
  return (
    <PendingConfirmDialog
      open={open}
      pending={pending}
      title="この内容で予約を作成しますか？"
      description={description}
      confirmLabel="この内容で予約"
      pendingLabel="作成中..."
      cancelLabel="戻る"
      onOpenChange={onClose}
      onConfirm={onConfirm}
    />
  );
}

function confirmationCustomerName(
  mode: CreateMode,
  selectedCustomer: SelectedCustomer | null,
  customerName: string,
): string {
  return mode === "existing" ? selectedCustomer?.displayName ?? "" : customerName.trim();
}

function confirmationServiceNames(
  selectedServices: ServiceChoice[],
  selectedIds: string[],
): string[] {
  // 確認ダイアログはカテゴリ prefix を落とした表示名で出す（選択リスト自体は
  // カテゴリ分類が要るので生名のまま）。ID フォールバックはそのまま。
  return selectedServices.length > 0
    ? selectedServices.map((service) => displayServiceName(service.name))
    : selectedIds;
}


export function ReservationCreatePanel({
  open,
  onClose,
  defaultStoreId,
  defaultResourceId,
  defaultDate,
  defaultMinutes,
  defaultServiceIds,
  defaultCustomer,
}: Readonly<ReservationCreatePanelProps>) {
  const { data: settingsData } = useSettings();
  const { mutate: create, isPending } = useCreateReservation();

  // 応答喪失後に同じ内容を再送するときだけ key を保ち、フォーム内容を変えた
  // 次の作成は別操作として新しい key にする。
  const idempotencyStateRef = useRef<ReservationCreateKeyState | null>(null);

  const settings = settingsData?.ok ? settingsData.settings : null;

  const [storeId, setStoreId] = useState(defaultStoreId ?? "");
  const [serviceIds, setServiceIds] = useState<string[]>(defaultServiceIds ?? []);
  const [resourceId, setResourceId] = useState(defaultResourceId ?? "");
  const [date, setDate] = useState(() => formatJstDate(defaultDate));
  const [time, setTime] = useState(() => {
    if (defaultMinutes == null) return "10:00";
    const h = String(Math.floor(defaultMinutes / 60)).padStart(2, "0");
    const m = String(defaultMinutes % 60).padStart(2, "0");
    return `${h}:${m}`;
  });
  // 空き枠クリック由来の時刻か（メニュー変更時にリセットするかの判定に使う）。
  const [timeFromSlot, setTimeFromSlot] = useState(false);
  // rebook 初期値のうち現在選択できないメニューを外したときの警告。
  const [unavailableNotice, setUnavailableNotice] = useState<string | null>(null);

  // 既定は既存客モード（カルテ「次回予約」由来 or 検索）。新規客はタブで切り替える。
  // 既存客は role を問わず customerId で予約する（staff には電話番号がマスク表示
  // されるため、手入力経路では既存客を指定できない）。
  const [mode, setMode] = useState<CreateMode>("existing");
  const [origin, setOrigin] = useState<CreateReservationOrigin>("minimo");

  // 既存客モード: 選択済みの既存客（customerId で予約）。
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(
    defaultCustomer?.id
      ? {
          id: defaultCustomer.id,
          displayName: defaultCustomer.displayName,
          displayNameKana: defaultCustomer.displayNameKana ?? null,
          phoneNormalized: defaultCustomer.phone ?? null,
        }
      : null,
  );

  // 新規客モード: 手入力。rebook 由来（customerId あり）は既存客モードで送るため
  // この prefill は使われない。customerId の無い rebook（外部取込等）が新規モードに
  // 落ちたときの再入力を防ぐ。パネルは createDefaults を key に remount されるため、
  // prop 変更は再マウントで反映される（同期 useEffect は不要）。
  const [customerName, setCustomerName] = useState(defaultCustomer?.displayName ?? "");
  const [customerKana, setCustomerKana] = useState(defaultCustomer?.displayNameKana ?? "");
  const [customerPhone, setCustomerPhone] = useState(defaultCustomer?.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  // 確認ダイアログ。検証済み payload を保持し、null でない間ダイアログを開く。
  const [pendingPayload, setPendingPayload] = useState<CreateReservationPayload | null>(null);

  const [customerSearch, setCustomerSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(customerSearch, 250);
  const customerSearchQuery = useCustomerSearch(mode === "existing" ? debouncedSearch : "");
  const customerResults = customerSearchQuery.data?.ok ? customerSearchQuery.data.customers : [];

  const selectCustomer = (c: CustomerSearchItem) => {
    setSelectedCustomer({
      id: c.id,
      displayName: c.displayName,
      displayNameKana: c.displayNameKana,
      phoneNormalized: c.phoneNormalized,
    });
    setCustomerSearch("");
    setError(null);
  };

  const storeResources = useMemo(
    () => settings?.resources.filter((r) => r.active && r.storeId === storeId) ?? [],
    [settings, storeId],
  );

  const storeServices = useMemo(
    () => settings?.services.filter((s) => s.active && s.storeId === storeId) ?? [],
    [settings, storeId],
  );

  // rebook 初期値のうち現在の店舗メニュー（active）に無い ID は state に残さない
  // （残すと合算から漏れ、送信時に service_not_available で失敗する）。settings は
  // 非同期到着のため、最初に一覧が確定したタイミングで一度だけ分離する。
  const defaultsPruned = useRef(false);
  useEffect(() => {
    if (defaultsPruned.current || !settings) return;
    defaultsPruned.current = true;
    if (!defaultServiceIds?.length) return;
    const { available, unavailable } = splitRebookServiceIds(defaultServiceIds, storeServices);
    if (unavailable.length > 0) {
      setServiceIds(available);
      setUnavailableNotice(
        `以前の予約のメニュー${unavailable.length}件は現在選択できないため、選択から外しました。`,
      );
    }
  }, [settings, storeServices, defaultServiceIds]);

  const selectedServices = useMemo(
    () =>
      serviceIds
        .map((id) => storeServices.find((s) => s.id === id))
        .filter((s): s is (typeof storeServices)[number] => s !== undefined),
    [serviceIds, storeServices],
  );
  const totalMinutes = totalServiceDuration(serviceIds, storeServices);
  const overLimit = isOverSelectionLimit(serviceIds, storeServices);
  // 上限超過中（rebook 初期値の超過など）は空き枠取得を抑止する。
  const durationMinutes = totalMinutes > 0 && !overLimit ? totalMinutes : undefined;

  const limitHintVisible =
    !overLimit &&
    storeServices.some(
      (s) => !serviceIds.includes(s.id) && !canAddService(s, serviceIds, storeServices),
    );
  const serviceHintIds =
    [
      serviceIds.length > 0 ? "rcp-service-summary" : null,
      limitHintVisible ? "rcp-service-limit-hint" : null,
      overLimit ? "rcp-service-over-limit" : null,
      unavailableNotice ? "rcp-service-unavailable" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  const toggleService = (id: string) => {
    setServiceIds((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );
    // 合算時間が変わると空き枠クリックで選んだ時刻は無効になり得るためリセットする。
    setTime((prev) => nextTimeAfterServiceChange(prev, timeFromSlot));
    setTimeFromSlot(false);
    setError(null);
  };

  // メニュー未選択・上限超過中は storeId を渡さず取得自体を止める
  // （durationMinutes 省略だけだと既定時間で無駄な照会が走る）。
  // 既存客モードでは customerId を渡し、その顧客の他店舗/他リソース予約と
  // 重なる枠を候補から除外する（送信時 customer_time_conflict の事前回避）。
  const {
    data: slotsData,
    isFetching: slotsFetching,
    isError: slotsError,
  } = useAvailableSlots(
    durationMinutes !== undefined ? storeId || null : null,
    date || null,
    {
      durationMinutes,
      customerId: mode === "existing" ? selectedCustomer?.id ?? null : null,
    },
  );

  const slotsByResource = useMemo(() => {
    const availableSlots = slotsData?.ok ? slotsData.slots : [];
    const map = new Map<string, { name: string; slots: typeof availableSlots }>();
    for (const slot of availableSlots) {
      if (!map.has(slot.resourceId)) {
        map.set(slot.resourceId, { name: slot.resourceName, slots: [] });
      }
      map.get(slot.resourceId)!.slots.push(slot);
    }
    return map;
  }, [slotsData]);

  const handleSlotClick = (slot: { resourceId: string; startAt: string }) => {
    setResourceId(slot.resourceId);
    const d = new Date(slot.startAt);
    const jstHours = (d.getUTCHours() + 9) % 24;
    const h = String(jstHours).padStart(2, "0");
    const m = String(d.getUTCMinutes()).padStart(2, "0");
    setTime(`${h}:${m}`);
    setTimeFromSlot(true);
  };

  const resetForm = () => {
    setServiceIds([]);
    setUnavailableNotice(null);
    setSelectedCustomer(null);
    setCustomerName("");
    setCustomerKana("");
    setCustomerPhone("");
    setCustomerSearch("");
    setOrigin("minimo");
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);
    const baseValid = storeId && serviceIds.length > 0 && resourceId && date && time;
    if (!baseValid) {
      setError("必須項目を入力してください");
      return;
    }
    if (overLimit) {
      setError(
        `メニューは最大${MAX_SERVICE_SELECTIONS}件・施術時間の合計${MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES}分以内になるように選択を減らしてください`,
      );
      return;
    }

    const startAt = `${date}T${time}:00+09:00`;
    const servicePayload = buildServiceSelectionPayload(serviceIds);
    const customerPart = buildCustomerPart(mode, selectedCustomer?.id ?? null, {
      name: customerName,
      kana: customerKana,
      phone: customerPhone,
    });
    if (!customerPart.ok) {
      setError(customerPart.error);
      return;
    }
    const payloadWithoutKey = {
      storeId,
      ...servicePayload,
      resourceId,
      startAt,
      origin,
      ...customerPart.part,
    } satisfies ReservationCreatePayloadWithoutKey;
    const signature = createReservationPayloadSignature(payloadWithoutKey);
    const keyState = resolveReservationCreateKey(
      idempotencyStateRef.current,
      signature,
      () => crypto.randomUUID(),
    );
    idempotencyStateRef.current = keyState;
    const payload: CreateReservationPayload = {
      idempotencyKey: keyState.key,
      ...payloadWithoutKey,
    };

    // 手動予約は誤操作の影響が大きい(顧客に確定通知が飛ぶ)ため、送信前に内容確認を挟む。
    // 検証済みの payload を保持してダイアログを開き、確定は handleConfirm で行う。
    setPendingPayload(payload);
  };

  const handleConfirm = () => {
    if (!pendingPayload) return;
    create(pendingPayload, {
      onSuccess: () => {
        idempotencyStateRef.current = null;
        setPendingPayload(null);
        resetForm();
        onClose();
      },
      // API エラーのトーストは useCreateReservation フックの onError が表示する
      // (ここで重ねて showErrorToast すると二重表示になる)。失敗時は key を
      // 保持する(手動リトライで同じ内容を再送すれば replay される)。
    });
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md" aria-describedby={undefined}>
        <SheetTitle className="sr-only">予約作成</SheetTitle>
        <div className="space-y-4 pt-4">
          {/* pr-8: 44px Close (右端 52px 占有) と見出しブロックの重なり回避。 */}
          <h3 className="pr-8 text-lg font-semibold">新規予約</h3>

          <Separator />

          <div className="space-y-3">
            <Field id="rcp-store" label="店舗">
              <Select value={storeId} onValueChange={(v) => { setStoreId(v); setServiceIds([]); setUnavailableNotice(null); setResourceId(""); setSelectedCustomer(null); setCustomerSearch(""); }}>
                <SelectTrigger id="rcp-store"><SelectValue placeholder="店舗を選択" /></SelectTrigger>
                <SelectContent>
                  {settings?.stores.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <ServiceSelectionFieldset
              storeId={storeId}
              services={storeServices}
              selectedIds={serviceIds}
              totalMinutes={totalMinutes}
              limitHintVisible={limitHintVisible}
              overLimit={overLimit}
              unavailableNotice={unavailableNotice}
              hintIds={serviceHintIds}
              onToggle={toggleService}
            />

            <Field id="rcp-resource" label="リソース">
              <Select value={resourceId} onValueChange={setResourceId}>
                <SelectTrigger id="rcp-resource"><SelectValue placeholder="リソースを選択" /></SelectTrigger>
                <SelectContent>
                  {storeResources.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field id="rcp-date" label="日付">
                <Input id="rcp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field id="rcp-time" label="時間">
                <Input id="rcp-time" type="time" value={time} onChange={(e) => { setTime(e.target.value); setTimeFromSlot(false); }} step="300" />
              </Field>
            </div>
          </div>

          {storeId && date && serviceIds.length > 0 && !overLimit && (
            <>
              <Separator />
              <Field label="空き枠">
                {renderSlotsField({
                  fetching: slotsFetching,
                  failed: slotsError || slotsData?.ok === false,
                  slotsByResource,
                  resourceId,
                  time,
                  onSlotClick: handleSlotClick,
                })}
              </Field>
            </>
          )}

          <Separator />

          <Field id="rcp-origin" label="予約経路">
            <Select value={origin} onValueChange={(v) => setOrigin(v as CreateReservationOrigin)}>
              <SelectTrigger id="rcp-origin"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RESERVATION_ORIGIN_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Separator />

          <CustomerFields
            mode={mode}
            selectedCustomer={selectedCustomer}
            customerSearch={customerSearch}
            searchOpen={customerSearch.trim().length >= 2}
            searchLoading={
              customerSearchQuery.isFetching || debouncedSearch !== customerSearch.trim()
            }
            searchError={customerSearchQuery.isError}
            customerResults={customerResults}
            customerName={customerName}
            customerKana={customerKana}
            customerPhone={customerPhone}
            onExistingMode={() => {
              setMode("existing");
              setError(null);
            }}
            onNewMode={() => {
              setMode("new");
              setSelectedCustomer(null);
              setError(null);
            }}
            onCustomerSearchChange={setCustomerSearch}
            onCustomerSelect={selectCustomer}
            onCustomerClear={() => setSelectedCustomer(null)}
            onCustomerNameChange={setCustomerName}
            onCustomerKanaChange={setCustomerKana}
            onCustomerPhoneChange={setCustomerPhone}
          />

          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose} disabled={isPending}>
              キャンセル
            </Button>
            <Button className="flex-1" onClick={handleSubmit} disabled={isPending}>
              {isPending ? "作成中..." : "予約作成"}
            </Button>
          </div>

          <ReservationConfirmationDialog
            open={pendingPayload !== null}
            pending={isPending}
            customerName={confirmationCustomerName(mode, selectedCustomer, customerName)}
            storeName={settings?.stores.find((store) => store.id === storeId)?.name ?? storeId}
            serviceNames={confirmationServiceNames(selectedServices, serviceIds)}
            totalMinutes={totalMinutes}
            resourceName={
              storeResources.find((resource) => resource.id === resourceId)?.name ?? resourceId
            }
            date={date}
            time={time}
            onClose={() => setPendingPayload(null)}
            onConfirm={handleConfirm}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
