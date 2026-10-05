import { useState, useEffect, useEffectEvent, useId, useRef } from "react";
import type { CustomerConsent, CustomerDetail, Reservation } from "@/types/api";
import { useNavigate } from "react-router";
import { ApiError } from "@/lib/api-client";
import { ChartConflictNotice } from "./chart-conflict-notice";
import { displayServiceName } from "@/lib/service-pricing";
import { reservationOriginLabel, reservationSourceLabel } from "@/lib/reservation-origin";
import { ArrowLeft, CalendarDays, Phone, Users, TriangleAlert, ChevronDown } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CustomerGateCard } from "./customer-gate-card";
import { ReservationDetailPanel } from "@/components/schedule/reservation-detail-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useCustomerDetail,
  useCustomerConsentsPage,
  useCustomerVisitsPage,
  useCustomerReservationsPage,
  useCustomerMemoUpdate,
  useCustomerReferrerUpdate,
  useCustomerProfileUpdate,
  useCustomerBlockAction,
  useCustomerArchiveAction,
  useVisitNotesUpdate,
  useAddCustomerVisit,
  useUpdateCustomerVisit,
  useDeleteCustomerVisit,
  useCustomerDelete,
} from "@/hooks/use-customers";
import { useStores } from "@/hooks/use-stores";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { statusColor, statusLabel, visitStatusLabel, formatFullJstDate, formatJstDate, formatTime } from "@/lib/timeline";
import { lineFriendStatusLabel } from "@/lib/line-friend-label";
import { LinkLineFromCardDialog } from "@/components/customers/link-line-from-card-dialog";
import { DetailRow as Row } from "@/components/ui/detail-row";
import { PendingConfirmDialog } from "@/components/ui/pending-confirm-dialog";

type Props = {
  customerId: string | null;
  onClose: () => void;
  suspended?: boolean;
  originReservationId?: string | null;
};

const CONSENT_TYPE_LABELS: Record<string, string> = {
  notice: "予約前確認事項",
  cancellation_policy: "キャンセルポリシー",
  privacy_policy: "プライバシーポリシー",
  minor_guardian: "保護者同意",
};

function blockDialogCopy(action: "block" | "unblock" | null) {
  if (action === "block") {
    return {
      title: "顧客をブロック",
      description: "この顧客をブロックしますか？予約ができなくなります。",
    };
  }
  return {
    title: "ブロック解除",
    description: "この顧客のブロックを解除しますか？",
  };
}

function archiveDialogCopy(action: "archive" | "unarchive" | null, hasUnsavedDraft: boolean) {
  if (action === "archive") {
    return {
      title: "顧客をアーカイブ",
      // アーカイブすると編集中の下書きは失われる。Esc / 外側クリックのような
      // 誤操作ではないので破棄確認は挟まないが、実行前にここで伝える。
      // (アーカイブ後はサーバー側が archived_at IS NULL を要求するので、
      //  下書きはそもそも保存できなくなる。)
      description: hasUnsavedDraft
        ? "この顧客を一覧・検索から隠します。データは削除されず、後でいつでも復元できます。編集中の内容は保存されずに破棄されます。"
        : "この顧客を一覧・検索から隠します。データは削除されず、後でいつでも復元できます。",
    };
  }
  return {
    title: "顧客を復元",
    description: "この顧客を一覧・検索に戻しますか？",
  };
}

// ブロック / アーカイブは全 role（スタッフは自店舗の顧客だけ。サーバー側で判定）。
// LINE 紐付けと完全削除は owner+ のままなので privileged で分ける。
// ブロック切替はアーカイブ済みでは出さない: サーバーの block/unblock は
// archived_at IS NULL を要求するため、押しても必ず失敗する行き止まりになる。
function CustomerAdminActions({
  active,
  hasLineIdentity,
  archived,
  onBlock,
  onUnblock,
  onLinkLine,
  onArchive,
  onUnarchive,
  onDelete,
}: Readonly<{
  active: boolean;
  hasLineIdentity: boolean;
  archived: boolean;
  onBlock: () => void;
  onUnblock: () => void;
  onLinkLine: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}>) {
  const { isPrivileged: privileged } = useAuth();
  const blockToggle = active ? (
    <Button variant="destructive" size="sm" onClick={onBlock}>
      ブロック
    </Button>
  ) : (
    <Button variant="outline" size="sm" onClick={onUnblock}>
      ブロック解除
    </Button>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {!archived && blockToggle}
      {privileged && active && !hasLineIdentity && !archived && (
        <Button variant="outline" size="sm" onClick={onLinkLine}>
          LINEと紐付け
        </Button>
      )}
      {archived ? (
        <Button variant="outline" size="sm" onClick={onUnarchive}>
          復元
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={onArchive}>
          アーカイブ
        </Button>
      )}
      {privileged && (
        <Button variant="destructive" size="sm" onClick={onDelete}>
          完全に削除
        </Button>
      )}
    </div>
  );
}

export function CustomerDetailPanel({ customerId, onClose, suspended = false, originReservationId = null }: Readonly<Props>) {
  const { isPrivileged } = useAuth();
  const navigate = useNavigate();
  const detailQuery = useCustomerDetail(customerId);
  const { data, isPending, isError } = detailQuery;
  const memoMutation = useCustomerMemoUpdate();
  const referrerMutation = useCustomerReferrerUpdate();
  const profileMutation = useCustomerProfileUpdate();
  const blockMutation = useCustomerBlockAction();
  const archiveMutation = useCustomerArchiveAction();
  const notesMutation = useVisitNotesUpdate();
  const addVisitMutation = useAddCustomerVisit();
  const updateVisitMutation = useUpdateCustomerVisit();
  const deleteVisitMutation = useDeleteCustomerVisit();
  const deleteMutation = useCustomerDelete();
  const visitsPageMutation = useCustomerVisitsPage();
  const consentsPageMutation = useCustomerConsentsPage();
  const reservationsPageMutation = useCustomerReservationsPage();
  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [gateRequired, setGateRequired] = useState(false);
  const { stores } = useStores();

  const todayKey = formatJstDate(new Date());

  const [editingMemo, setEditingMemo] = useState(false);
  const [memoValue, setMemoValue] = useState("");
  const [memoBaseline, setMemoBaseline] = useState<string | null>(null);
  const [memoConflict, setMemoConflict] = useState(false);
  const [editingReferrer, setEditingReferrer] = useState(false);
  const [referrerValue, setReferrerValue] = useState("");
  const [referrerBaseline, setReferrerBaseline] = useState<string | null>(null);
  const [referrerConflict, setReferrerConflict] = useState(false);
  const [historyTab, setHistoryTab] = useState("visits");
  // 基本情報(名前・フリガナ・電話)のインライン編集。
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ displayName: "", displayNameKana: "", phone: "" });
  const [blockConfirm, setBlockConfirm] = useState<"block" | "unblock" | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<"archive" | "unarchive" | null>(null);
  // Hard-delete is gated behind a type-to-confirm step: the operator must type
  // the customer's exact display name, so an irreversible delete can't be a
  // single mis-click.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingVisitSnapshot, setEditingVisitSnapshot] = useState<{ customerId: string; visit: CustomerDetail["visits"][number]; pageOffset: number } | null>(null);
  const [noteValue, setNoteValue] = useState("");
  // 編集を開いたときの値。「開いている」ではなく「変わっている」を下書きの条件にするため。
  const [noteBaseline, setNoteBaseline] = useState<string | null>(null);
  const [notesConflict, setNotesConflict] = useState(false);
  // 保存済みの施術メモを空にして上書きしようとしたとき。カルテが消える操作なので確認する。
  const [clearNoteVisitId, setClearNoteVisitId] = useState<string | null>(null);
  // 下書きを持ったまま Esc / 一覧へ戻る操作でカルテを閉じようとしたとき。
  // 破棄確認のあとに何をするか。閉じる以外に「次回予約へ移動する」があるので真偽値では足りない。
  const [discardDraftNext, setDiscardDraftNext] = useState<"close" | "quickBook" | null>(null);
  // 来店日のインライン編集 (手動 visit のみ)。idempotencyKey は編集開始時に採番。
  const [editingDateId, setEditingDateId] = useState<string | null>(null);
  const [dateValue, setDateValue] = useState("");
  const [dateBaseline, setDateBaseline] = useState("");
  const [dateIdemKey, setDateIdemKey] = useState("");
  // 削除確認中の visitId。
  const [deleteVisitId, setDeleteVisitId] = useState<string | null>(null);
  const [linkLineOpen, setLinkLineOpen] = useState(false);

  // 来店履歴追加フォームのラベル接続用 id
  const visitedAtId = useId();
  const visitStoreId = useId();
  const visitNotesId = useId();
  // 削除確認フォームのラベル接続用 id
  const deleteConfirmInputId = useId();

  // idempotencyKey is generated when the form opens and reused across retries
  // (kept until success), so a lost-response retry does not append a duplicate
  // manual visit. (codex advisory)
  const [visitForm, setVisitForm] = useState<{ open: boolean; visitedAt: string; storeId: string; notes: string; idempotencyKey: string }>({
    open: false,
    visitedAt: todayKey,
    storeId: "",
    notes: "",
    idempotencyKey: "",
  });

  const customer = data?.ok ? data.customer : null;
  const gateBlocked = suspended || gateRequired || [detailQuery.error, detailQuery.failureReason].some(isCustomerGateRequired);
  const handleWriteError = (error: unknown, conflict?: () => void) => {
    if (isCustomerGateRequired(error)) setGateRequired(true);
    if (isStaleSnapshot(error)) conflict?.();
  };

  // 顧客詳細が返すのは来店履歴の先頭 1 ページだけ。それより古い施術メモを読むために
  // 続きを足せるようにする (issue #650)。ちょうど 1 ページぶん返ってきたときだけ
  // 続きがあり得るので、それを次の offset にする。
  const customerIdRef = useRef(customerId);
  customerIdRef.current = customerId;
  const [extraVisits, setExtraVisits] = useState<CustomerDetail["visits"]>([]);
  const [nextVisitOffset, setNextVisitOffset] = useState<number | null>(null);
  // 読み込み済みの続きを捨てるたびに増やす世代番号。捨てたあとに前の世代の応答が
  // 届くと、空になった一覧の後ろに古いページが足され、offset だけ先へ進む
  // (51〜100 件目が二度と読めなくなる)。応答は自分の世代のときだけ受け取る。
  const visitPagesEpoch = useRef(0);
  // 依存は件数ではなく配列そのもの。来店の編集や削除は 1 ページ目を取り直すだけで
  // `extraVisits` に触らないので、件数で見ていると 51 件目以降が古いまま残る (消した
  // はずの行が編集できる状態で出続ける)。react-query は中身が同じなら同じ配列を返す
  // ので、内容が変わらない再取得では消えない。
  //
  // 来店を書き換えたときも同じ処理が要る。無効化が取り直すのは詳細クエリ (先頭 1 ページ)
  // だけで、51 件目以降は誰も取り直さない。しかも 51 件目を直した回は 1 ページ目の中身が
  // 変わらず、react-query の structural sharing で配列の同一性まで保たれるので、上の効果も
  // 走らない。消したはずの行が編集できる状態で残るため、mutation の成功時から明示的に呼ぶ。
  const dropLoadedVisitPages = () => {
    visitPagesEpoch.current += 1;
    setExtraVisits([]);
    setNextVisitOffset(
      customer?.visits.length === CUSTOMER_VISITS_PAGE_SIZE ? CUSTOMER_VISITS_PAGE_SIZE : null,
    );
  };
  // 顧客を切り替えたあとに前の顧客の mutation が返ることがある。その回の
  // dropLoadedVisitPages は**前の顧客**の `customer.visits` から次の offset を導くので、
  // いま開いている顧客の続きが読めなくなる (前の顧客が 1 ページ未満だったとき) か、
  // 空振りする「続きを読む」が出る。
  //
  // 呼び出し元 (commitNotes / commitDate / confirmDeleteVisit / submitVisit の onSuccess)
  // の閉包は mutate した時点の `customer` を捕まえているので、顧客が変わっていれば
  // 前の顧客のページ長を読む。loadMoreVisits の応答と同じく、相手が変わっていたら捨てる。
  const dropLoadedVisitPagesFor = (requestedFor: string) => {
    if (requestedFor !== customerIdRef.current) return;
    dropLoadedVisitPages();
  };
  useEffect(dropLoadedVisitPages, [customerId, customer?.visits]);
  const loadedVisits = customer ? [...customer.visits, ...extraVisits] : [];
  const retainedEditingVisit = editingNoteId && editingVisitSnapshot?.customerId === customerId &&
    !loadedVisits.some((row) => row.id === editingNoteId) ? editingVisitSnapshot.visit : null;
  const visits = retainedEditingVisit ? [...loadedVisits, retainedEditingVisit] : loadedVisits;
  const [visitsPageError, setVisitsPageError] = useState(false);
  const initialReservationPage = {
    customerId, firstPage: customer?.reservations, firstOffset: customer?.reservationsNextOffset,
    entries: [] as CustomerDetail["reservations"], nextOffset: customer?.reservationsNextOffset ?? null,
    pending: false, error: false,
  };
  const [reservationPage, setReservationPage] = useState(initialReservationPage);
  if (reservationPage.customerId !== customerId || reservationPage.firstPage !== customer?.reservations ||
      reservationPage.firstOffset !== customer?.reservationsNextOffset) {
    setReservationPage(initialReservationPage);
  }
  const reservations = customer ? [...customer.reservations, ...reservationPage.entries] : [];
  const loadMoreReservations = () => {
    if (!customerId || reservationPage.nextOffset === null || reservationPage.pending) return;
    const request = { ...reservationPage, pending: true, error: false };
    setReservationPage(request);
    reservationsPageMutation.mutate({ customerId, offset: reservationPage.nextOffset }, {
      onSuccess: (page) => setReservationPage((current) => {
        if (current !== request) return current;
        const seen = new Set([...(current.firstPage ?? []), ...current.entries].map((row) => row.id));
        return { ...current, entries: [...current.entries, ...page.reservations.filter((row) => !seen.has(row.id))],
          nextOffset: page.nextOffset, pending: false };
      }),
      onError: (error) => {
        if (customerIdRef.current !== customerId) return;
        handleWriteError(error);
        setReservationPage((current) => current === request ? { ...current, pending: false, error: true } : current);
      },
    });
  };

  const initialConsentPage = {
    customerId,
    firstPage: customer?.consentHistory,
    firstOffset: customer?.consentHistoryNextOffset,
    entries: [] as CustomerConsent[],
    nextOffset: customer?.consentHistoryNextOffset ?? null,
    error: false,
    pending: false,
  };
  const [consentPage, setConsentPage] = useState(initialConsentPage);
  // Reset before commit: a passive effect would briefly paint the previous
  // customer's rows, error and pending state. A new first page also invalidates
  // responses still in flight for the old page, including A -> B -> A switches.
  if (consentPage.customerId !== customerId ||
      consentPage.firstPage !== customer?.consentHistory ||
      consentPage.firstOffset !== customer?.consentHistoryNextOffset) {
    setConsentPage(initialConsentPage);
  }
  const consents = customer ? [...(customer.consentHistory ?? []), ...consentPage.entries] : [];

  const loadMoreConsents = () => {
    if (consentPage.nextOffset === null || !customerId || consentPage.pending) return;
    const request = { ...consentPage, error: false, pending: true };
    setConsentPage(request);
    consentsPageMutation.mutate(
      { customerId, offset: consentPage.nextOffset },
      {
        onSuccess: (page) => {
          setConsentPage((current) => {
            if (current !== request) return current;
            const seen = new Set([...(current.firstPage ?? []), ...current.entries].map((entry) => entry.id));
            return {
              ...current,
              entries: [...current.entries, ...page.consents.filter((entry) => !seen.has(entry.id))],
              nextOffset: page.nextOffset,
              pending: false,
            };
          });
        },
        onError: (error) => {
          if (customerIdRef.current === customerId) handleWriteError(error);
          setConsentPage((current) => current === request ? { ...current, error: true, pending: false } : current);
        },
      },
    );
  };

  const loadMoreVisits = () => {
    if (nextVisitOffset === null || !customerId || visitsPageMutation.isPending) return;
    setVisitsPageError(false);
    // このパネルは顧客を切り替えても作り直されない。読み込み中に別の顧客を開くと、
    // 遅れて返ってきた前の顧客の来店 (施術メモを含む) を今開いている顧客の履歴に
    // 足してしまうので、返ってきた時点で相手が変わっていたら捨てる。
    // 応答が自分のものか確かめる条件が 2 つあるのは、**塞ぐ窓が別**だから。
    // `customerIdRef` は render 中に更新されるので顧客が変わった瞬間に新しい値になるが、
    // `visitPagesEpoch` を上げるのは passive effect なので commit と paint のあとになる。
    // つまり「ref はもう次の顧客を指しているのに世代はまだ上がっていない」時間が実在する。
    // React はその後の render の先頭で保留中の passive effect を流すため、片方だけでも
    // 最終状態は結果的に正しくなるが、それは React の内部順序に寄りかかった説明になる。
    // ここは両方を見て、このファイルの中だけで閉じた不変条件にしておく。
    // (⚠️ この 2 つは冗長に見えるが、testing-library の render は act() が passive effect を
    //  同期で流すので、テストでは上の時間差そのものを再現できない。片方を消しても
    //  テストは緑のままになる — 緑を根拠にまとめないこと。)
    const requestedFor = customerId;
    const requestedEpoch = visitPagesEpoch.current;
    visitsPageMutation.mutate(
      { customerId, offset: nextVisitOffset },
      {
        onSuccess: (page) => {
          if (requestedFor !== customerIdRef.current || requestedEpoch !== visitPagesEpoch.current) return;
          // ponytail: offset ページングなので、読み込みの合間に来店が増減すると
          // 境界がずれて 1 件重複または 1 件抜けが起こり得る。id で重複だけ落とし、
          // 抜けはパネルを開き直せば直る範囲に留める。本番の最大は 1 顧客 16 件で
          // 1 ページ 50 件なので当面到達しない。到達するなら offset をやめて
          // (並び替えキー, created_at, id) のカーソルに変える。
          setExtraVisits((current) => {
            const seen = new Set([...(customer?.visits ?? []), ...current].map((visit) => visit.id));
            return [...current, ...page.visits.filter((visit) => !seen.has(visit.id))];
          });
          setNextVisitOffset(page.nextOffset);
        },
        onError: (error) => {
          if (requestedFor !== customerIdRef.current || requestedEpoch !== visitPagesEpoch.current) return;
          setVisitsPageError(true);
          handleWriteError(error);
        },
      },
    );
  };

  // アーカイブ済みは全 role で読み取り専用 (memo / profile / 施術メモ / 来店追加の
  // API はどれも archived_at IS NULL を要求する)。押せば必ず失敗するボタンを出さない。
  const isArchived = !!customer?.archivedAt;

  // 下書きの条件は「編集を開いている」ではなく「開いたときの値から変わっている」。
  // 開いただけで閉じられなくなる確認は、邪魔になるだけで何も守らない。
  const hasUnsavedDraft = () =>
    (editingMemo && memoValue !== (memoBaseline ?? "")) ||
    (editingReferrer && referrerValue !== (referrerBaseline ?? "")) ||
    (editingProfile &&
      (profileForm.displayName !== (customer?.displayName ?? "") ||
        profileForm.displayNameKana !== (customer?.displayNameKana ?? "") ||
        profileForm.phone !== (customer?.phoneNormalized ?? ""))) ||
    (editingNoteId !== null && noteValue !== (noteBaseline ?? "")) ||
    (editingDateId !== null && dateValue !== dateBaseline) ||
    (visitForm.open && (visitForm.notes !== "" || visitForm.storeId !== "" || visitForm.visitedAt !== todayKey));

  const closePanel = () => {
    setDiscardDraftNext(null);
    onClose();
  };

  useEffect(() => {
    setEditingMemo(false);
    setMemoValue("");
    setMemoConflict(false);
    setEditingReferrer(false);
    setReferrerConflict(false);
    setEditingProfile(false);
    setBlockConfirm(null);
    setArchiveConfirm(null);
    setDeleteOpen(false);
    setDeleteConfirmText("");
    setEditingNoteId(null);
    setEditingVisitSnapshot(null);
    setNoteValue("");
    setNoteBaseline(null);
    setNotesConflict(false);
    setClearNoteVisitId(null);
    setDiscardDraftNext(null);
    setHistoryTab("visits");
    setVisitsPageError(false);
    setGateRequired(false);
    setSelectedReservationId(null);
    setEditingDateId(null);
    setDateValue("");
    setDateBaseline("");
    setDateIdemKey("");
    setDeleteVisitId(null);
    // Seed visitedAt from a fresh JST "today" computed inside the effect, not the
    // render-scoped todayKey, so this reset effect depends on customerId alone.
    // Keeping todayKey in the deps made the effect re-fire at JST midnight and
    // silently discard the operator's in-progress edits (visit form, memo, etc).
    setVisitForm({
      open: false,
      visitedAt: formatJstDate(new Date()),
      storeId: "",
      notes: "",
      idempotencyKey: "",
    });
    setLinkLineOpen(false);
  }, [customerId]);

  // アーカイブされたら、開いている編集フォームと確認ダイアログを畳む。入口ボタンは
  // isArchived で消えるが、既に開いているものは残り、その実行は必ず失敗する
  // (memo / profile / 施術メモ / 来店追加 と block/unblock の API はどれも
  // archived_at IS NULL を要求する)。別の操作者がアーカイブして再取得が届いた場合に
  // 起きる。アーカイブ確認も畳む: 先にアーカイブされていれば invalid_transition。
  // 削除ダイアログだけはここで閉じない: 実行中の hard delete を握り潰さないため
  // (AlertDialog の onOpenChange が isPending 中の close を拒否しているのと同じ理由。
  // 完全削除はアーカイブ済みでも owner に出したままで、取り消せない操作なので
  // 「削除中...」の表示がそのまま唯一のフィードバックになる)。
  useEffect(() => {
    if (!isArchived) return;
    setEditingMemo(false);
    setEditingReferrer(false);
    setEditingProfile(false);
    setEditingNoteId(null);
    setEditingDateId(null);
    setBlockConfirm(null);
    setArchiveConfirm((pending) => (pending === "unarchive" ? pending : null));
    setVisitForm((form) => (form.open ? { ...form, open: false } : form));
    // 施術メモを空にする確認も畳む。編集そのものは上で畳んでいるのに、この確認だけ
    // 残ると、押した先の PUT が archived_at IS NULL で必ず失敗するボタンになる。
    setClearNoteVisitId(null);
    // 下書き破棄の確認も畳む。畳む対象の下書きが上で消えているので、残しても
    // 「破棄しますか」と聞いて何も破棄しないダイアログになる。
    setDiscardDraftNext(null);
  }, [isArchived]);

  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !customerId || gateBlocked ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    if (hasUnsavedDraft()) setDiscardDraftNext("close"); else onClose();
  });
  useEffect(() => {
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);

  const startEditMemo = () => {
    if (memoMutation.isPending) return;
    setMemoValue(customer?.memo ?? "");
    setMemoBaseline(customer?.memo ?? null);
    setMemoConflict(false);
    setEditingMemo(true);
  };

  const startEditProfile = () => {
    setProfileForm({
      displayName: customer?.displayName ?? "",
      displayNameKana: customer?.displayNameKana ?? "",
      phone: customer?.phoneNormalized ?? "",
    });
    setEditingProfile(true);
  };

  const saveProfile = () => {
    if (!customerId) return;
    const displayName = profileForm.displayName.trim();
    if (!displayName) return; // 名前は必須
    profileMutation.mutate(
      {
        customerId,
        displayName,
        displayNameKana: profileForm.displayNameKana.trim() || null,
        phone: profileForm.phone.trim() || null,
      },
      { onSuccess: () => setEditingProfile(false), onError: (error) => handleWriteError(error) },
    );
  };

  const saveMemo = () => {
    if (!customerId) return;
    memoMutation.mutate(
      { customerId, memo: memoValue.trim() || null, expectedMemo: memoBaseline },
      {
        onSuccess: () => setEditingMemo(false),
        onError: (error) => { handleWriteError(error, () => setMemoConflict(true)); },
      },
    );
  };

  const startEditReferrer = () => {
    if (referrerMutation.isPending || customer?.referrerName === undefined) return;
    setReferrerValue(customer.referrerName ?? "");
    setReferrerBaseline(customer.referrerName);
    setReferrerConflict(false);
    setEditingReferrer(true);
  };

  const saveReferrer = () => {
    if (!customerId || customer?.referrerName === undefined || referrerConflict) return;
    referrerMutation.mutate(
      { customerId, referrerName: referrerValue.trim() || null, expectedReferrerName: referrerBaseline },
      {
        onSuccess: () => setEditingReferrer(false),
        onError: (error) => { handleWriteError(error, () => setReferrerConflict(true)); },
      },
    );
  };

  const reloadCustomer = async () => {
    const result = await detailQuery.refetch();
    if (!result.data?.ok || result.error) {
      handleWriteError(result.error);
      throw new Error("customer_refresh_failed");
    }
    return result.data.customer;
  };

  const handleBlockAction = () => {
    if (!customerId || !blockConfirm) return;
    blockMutation.mutate(
      { customerId, action: blockConfirm },
      { onSuccess: () => setBlockConfirm(null) },
    );
  };

  const handleDelete = () => {
    if (!customerId || !customer) return;
    // trim both sides so an accidentally space-padded stored name is still
    // matchable by the visible name the operator types.
    if (deleteConfirmText.trim() !== customer.displayName.trim()) return;
    deleteMutation.mutate(
      { customerId },
      {
        onSuccess: () => {
          // 顧客は完全に消えたのでパネルを閉じる（一覧/検索は invalidate 済み）。
          setDeleteOpen(false);
          setDeleteConfirmText("");
          onClose();
        },
      },
    );
  };

  const handleArchiveAction = () => {
    if (!customerId || !archiveConfirm) return;
    archiveMutation.mutate(
      { customerId, action: archiveConfirm },
      {
        onSuccess: () => {
          // アーカイブすると active 一覧/検索からこの顧客が消えるため、
          // 隠れた行の上にパネルが残ると混乱する。閉じる。
          setArchiveConfirm(null);
          onClose();
        },
      },
    );
  };

  const startEditNotes = (visit: CustomerDetail["visits"][number]) => {
    if (notesMutation.isPending || !customerId) return;
    setEditingNoteId(visit.id);
    setEditingVisitSnapshot({
      customerId, visit,
      pageOffset: Math.floor(visits.findIndex((row) => row.id === visit.id) / CUSTOMER_VISITS_PAGE_SIZE) * CUSTOMER_VISITS_PAGE_SIZE,
    });
    setNoteValue(visit.treatmentNotes ?? "");
    setNoteBaseline(visit.treatmentNotes);
    setNotesConflict(false);
  };

  const saveNotes = () => {
    if (!customerId || !editingNoteId) return;
    // 保存済みのカルテを空で上書きしようとしている場合だけ確認を挟む。
    if (noteBaseline?.trim() && !noteValue.trim()) {
      setClearNoteVisitId(editingNoteId);
      return;
    }
    commitNotes(editingNoteId);
  };

  const commitNotes = (visitId: string) => {
    if (!customerId) return;
    notesMutation.mutate(
      { customerId, visitId, treatmentNotes: noteValue.trim() || null, expectedTreatmentNotes: noteBaseline },
      {
        onSuccess: () => {
          setEditingNoteId(null);
          setClearNoteVisitId(null);
          dropLoadedVisitPagesFor(customerId);
        },
        onError: (error) => { handleWriteError(error, () => setNotesConflict(true)); },
      },
    );
  };

  const startEditDate = (visitId: string, currentVisitedAt: string) => {
    setEditingDateId(visitId);
    // currentVisitedAt は手動 visit なら 'YYYY-MM-DD'、旧 seed は ISO。JST 日付へ正規化。
    const normalized = formatJstDate(new Date(currentVisitedAt));
    setDateValue(normalized);
    setDateBaseline(normalized);
    setDateIdemKey(crypto.randomUUID());
  };

  const saveDate = () => {
    if (!customerId || !editingDateId || !dateValue) return;
    updateVisitMutation.mutate(
      { customerId, visitId: editingDateId, idempotencyKey: dateIdemKey, visitedAt: dateValue },
      {
        onSuccess: () => {
          setEditingDateId(null);
          dropLoadedVisitPagesFor(customerId);
        },
      },
    );
  };

  const handleDeleteVisit = () => {
    if (!customerId || !deleteVisitId) return;
    deleteVisitMutation.mutate(
      { customerId, visitId: deleteVisitId },
      {
        onSuccess: () => {
          setDeleteVisitId(null);
          dropLoadedVisitPagesFor(customerId);
        },
      },
    );
  };

  const submitVisit = () => {
    if (!customerId || !visitForm.storeId || !visitForm.visitedAt) return;
    addVisitMutation.mutate(
      {
        customerId,
        idempotencyKey: visitForm.idempotencyKey,
        visitedAt: visitForm.visitedAt,
        storeId: visitForm.storeId,
        treatmentNotes: visitForm.notes.trim() || null,
      },
      {
        onSuccess: () => {
          setVisitForm({ open: false, visitedAt: todayKey, storeId: "", notes: "", idempotencyKey: "" });
          dropLoadedVisitPagesFor(customerId);
        },
      },
    );
  };

  const handleQuickBook = () => {
    if (!customer) return;
    // このボタンは onClose() を直接呼ぶので Radix の onOpenChange を通らない。
    // 書きかけのまま押されたときに黙って捨てないよう、閉じる経路と同じ確認を挟む。
    if (hasUnsavedDraft()) {
      setDiscardDraftNext("quickBook");
      return;
    }
    quickBook();
  };

  const quickBook = () => {
    if (!customer) return;
    // スケジュール画面の予約作成パネルへ顧客情報を渡して開く。
    // schedule.tsx が location.state.rebook を読み取り createDefaults に反映する。
    navigate("/", {
      state: {
        rebook: {
          id: customer.id,
          displayName: customer.displayName,
          displayNameKana: customer.displayNameKana,
          phone: customer.phoneNormalized,
        },
      },
    });
    onClose();
  };


  const blockDialog = blockDialogCopy(blockConfirm);
  const archiveDialog = archiveDialogCopy(archiveConfirm, hasUnsavedDraft());

  const renderProfileSection = () => customer && (
              <Section title="基本情報">
                {editingProfile ? (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-xs">名前</Label>
                      <Input
                        value={profileForm.displayName}
                        onChange={(e) => setProfileForm((f) => ({ ...f, displayName: e.target.value }))}
                        maxLength={120}
                        aria-label="名前"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">フリガナ</Label>
                      <Input
                        value={profileForm.displayNameKana}
                        onChange={(e) => setProfileForm((f) => ({ ...f, displayNameKana: e.target.value }))}
                        maxLength={120}
                        aria-label="フリガナ"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">電話番号</Label>
                      <Input
                        type="tel"
                        value={profileForm.phone}
                        onChange={(e) => setProfileForm((f) => ({ ...f, phone: e.target.value }))}
                        placeholder="例: 090-1234-5678"
                        aria-label="電話番号"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={saveProfile}
                        disabled={profileMutation.isPending || !profileForm.displayName.trim()}
                      >
                        {profileMutation.isPending ? "保存中..." : "保存"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingProfile(false)}
                        disabled={profileMutation.isPending}
                      >
                        キャンセル
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {customer.phoneNormalized && (
                      <Row label="電話" value={customer.phoneNormalized} />
                    )}
                    <Row label="LINE" value={lineFriendStatusLabel(customer.lineIdentities[0]?.officialFriendStatus ?? null)} />
                    {customer.birthDate && <Row label="生年月日" value={customer.birthDate} />}
                    {customer.gender && (
                      <Row label="性別" value={{ male: "男性", female: "女性", other: "その他", unspecified: "未指定" }[customer.gender] ?? customer.gender} />
                    )}
                    {customer.allergyNotes && (
                      <Row label="アレルギー" value={customer.allergyNotes} />
                    )}
                  </>
                )}
              </Section>
  );

  const renderChartSummary = () => {
    if (!customer) return null;
    const referrerAddButton = !isArchived && <Button size="sm" variant="ghost" onClick={startEditReferrer}>紹介者を追加</Button>;
    const referrerSummary = customer.referrerName ? <div>
      <p className="break-words text-sm">{customer.referrerName}</p>
      <p className="text-xs text-muted-foreground">紹介でご来店</p>
      {!isArchived && <Button size="sm" variant="ghost" onClick={startEditReferrer}>紹介者を編集</Button>}
    </div> : referrerAddButton;
    return (
                <aside className="min-w-0 space-y-5 rounded-lg border bg-card p-4 sm:p-5">
                  <Section title="注意事項">
                    {customer.allergyNotes ? <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                      <TriangleAlert className="size-5 shrink-0" aria-hidden="true" /><span className="whitespace-pre-wrap break-words">{customer.allergyNotes}</span>
                    </p> : <p className="text-sm text-muted-foreground">登録された注意事項はありません</p>}
                  </Section>
                  <Separator />
              <Section title="顧客メモ">
                {editingMemo ? (
                  <div className="space-y-2">
                    <Textarea
                      aria-label="顧客メモ"
                      value={memoValue}
                      onChange={(e) => setMemoValue(e.target.value)}
                      rows={4}
                      maxLength={1000}
                      disabled={memoMutation.isPending}
                    />
                    <CharCount value={memoValue} max={1000} />
                    {memoConflict && <ChartConflictNotice
                      onReload={async () => (await reloadCustomer()).memo}
                      onResume={(latest) => { setMemoBaseline(latest); setMemoConflict(false); }}
                    />}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveMemo} disabled={memoMutation.isPending || memoConflict}>
                        {memoMutation.isPending ? "保存中..." : "保存"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditingMemo(false)}
                        disabled={memoMutation.isPending}
                      >
                        キャンセル
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="whitespace-pre-wrap text-sm">
                      {customer.memo || "メモなし"}
                    </p>
                    {/* Memo editing is allowed for staff too: this panel only ever
                        renders for an own-store customer (the backend 403s staff on
                        out-of-scope detail), so any staff who can see it may edit the
                        memo. Owner-only actions (LINE link / hard delete / visit-add)
                        remain gated by isPrivileged below. Archived customers are
                        read-only for every role (the API requires archived_at IS NULL). */}
                    {!isArchived && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-1"
                        onClick={startEditMemo}
                        disabled={memoMutation.isPending}
                      >
                        編集
                      </Button>
                    )}
                  </div>
                )}
              </Section>

              <Separator />

              {customer.referrerName !== undefined && <>
                <Section title="紹介者">
                  {editingReferrer ? <div className="space-y-2">
                    <Input aria-label="紹介者名" value={referrerValue} maxLength={120}
                      disabled={referrerMutation.isPending} onChange={(event) => setReferrerValue(event.target.value)} />
                    <p className="text-xs text-muted-foreground">紹介でご来店のお客様のみ。空欄で保存すると紹介者を解除します。</p>
                    {referrerConflict && <ChartConflictNotice
                      onReload={async () => (await reloadCustomer()).referrerName ?? null}
                      onResume={(latest) => { setReferrerBaseline(latest); setReferrerConflict(false); }}
                    />}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveReferrer} disabled={referrerMutation.isPending || referrerConflict}>
                        {referrerMutation.isPending ? "保存中..." : "保存"}
                      </Button>
                      <Button size="sm" variant="outline" disabled={referrerMutation.isPending} onClick={() => setEditingReferrer(false)}>キャンセル</Button>
                    </div>
                  </div> : referrerSummary}
                </Section>
                <Separator />
              </>}

                  <Section title="次の予約">
                    {customer.nextReservation ? <div className={`space-y-2 rounded-lg border p-3 ${statusColor(customer.nextReservation.status)}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-semibold">{formatFullJstDate(new Date(customer.nextReservation.startAt))} {formatTime(customer.nextReservation.startAt)}</p>
                        <Badge variant="outline">{statusLabel(customer.nextReservation.status)}</Badge>
                      </div>
                      <p className="break-words font-medium">{chartServiceName(customer.nextReservation.serviceName, customer.nextReservation.serviceNameSource)}</p>
                      <p className="text-sm">{customer.nextReservation.storeName}</p>
                      <Button size="sm" variant="ghost" className="px-0 text-primary underline underline-offset-4" onClick={() => setSelectedReservationId(customer.nextReservation!.id)}>予約詳細を見る →</Button>
                    </div> : <p className="text-sm text-muted-foreground">{customer.nextReservation === undefined ? "次の予約を確認できません。予約履歴をご確認ください。" : "次の予約はありません"}</p>}
                  </Section>
                </aside>
    );
  };

  const renderManualVisitForm = () => {
    return (
      <>
                {isPrivileged && !isArchived && (
                  <div className="rounded-md border border-dashed p-2">
                    {visitForm.open ? (
                      <div className="space-y-2">
                        <div className="space-y-1">
                          <Label htmlFor={visitedAtId} className="text-xs">来店日</Label>
                          <Input
                            id={visitedAtId}
                            type="date"
                            max={todayKey}
                            value={visitForm.visitedAt}
                            onChange={(e) => setVisitForm((f) => ({ ...f, visitedAt: e.target.value }))}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={visitStoreId} className="text-xs">店舗</Label>
                          <Select
                            value={visitForm.storeId}
                            onValueChange={(v) => setVisitForm((f) => ({ ...f, storeId: v }))}
                          >
                            <SelectTrigger id={visitStoreId}>
                              <SelectValue placeholder="店舗を選択" />
                            </SelectTrigger>
                            <SelectContent>
                              {stores?.map((s) => (
                                <SelectItem key={s.id} value={s.id}>
                                  {s.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={visitNotesId} className="text-xs">施術メモ（任意）</Label>
                          <Textarea
                            id={visitNotesId}
                            value={visitForm.notes}
                            onChange={(e) => setVisitForm((f) => ({ ...f, notes: e.target.value }))}
                            rows={2}
                            maxLength={2000}
                          />
                          <CharCount value={visitForm.notes} max={2000} />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={submitVisit}
                            disabled={addVisitMutation.isPending || !visitForm.storeId || !visitForm.visitedAt}
                          >
                            {addVisitMutation.isPending ? "追加中..." : "追加"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setVisitForm((f) => ({ ...f, open: false }))}
                            disabled={addVisitMutation.isPending}
                          >
                            キャンセル
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setVisitForm((f) => ({
                            ...f,
                            open: true,
                            // Refresh to the current JST date on open so a sheet left open
                            // across midnight does not default a new visit to yesterday.
                            visitedAt: formatJstDate(new Date()),
                            idempotencyKey: crypto.randomUUID(),
                          }))
                        }
                      >
                        来店履歴を追加
                      </Button>
                    )}
                  </div>
                )}
      </>
    );
  };

  const renderReservationHistory = () => {
    if (!customer) return null;
    return (
                      <Section title={`予約履歴 (${reservations.length}件${reservationPage.nextOffset !== null ? "以上" : ""})`}>
                        <p className="text-xs text-muted-foreground">予約の予定と状態です。実際の来店は「来店・施術記録」で確認できます。</p>
                        {reservations.length === 0 && <p className="text-sm text-muted-foreground">予約記録なし</p>}
                        <p className="text-xs text-muted-foreground">登録日時は、このシステムに予約を登録した日時です。</p>
                        {reservations.map((reservation) => <ChartReservationCard key={reservation.id} reservation={reservation} onSelect={setSelectedReservationId} />)}
                        {reservationPage.error && <p className="text-sm text-destructive" role="alert">続きの予約履歴を読み込めませんでした。もう一度お試しください。</p>}
                        {reservationPage.nextOffset !== null && <Button variant="outline" className="w-full" disabled={reservationPage.pending} onClick={loadMoreReservations}>
                          {reservationPage.pending ? "予約履歴を読み込み中" : "過去の予約をさらに読み込む"}
                        </Button>}
                        {customer.reservationsNextOffset === undefined && <p className="text-xs text-muted-foreground">すべての予約履歴を確認できません。画面を更新してお試しください。</p>}
                        {customer.reservationsNextOffset !== undefined && reservationPage.nextOffset === null && reservations.length > 0 && <p className="text-center text-xs text-muted-foreground">予約履歴の終端です</p>}
                      </Section>
    );
  };

  const renderConsentHistory = () => {
    if (!customer) return null;
    return (
              <Section title="予約時の同意履歴">
                <p className="text-pretty text-xs text-muted-foreground">
                  予約時に保存された文書の版と同意日時です。
                </p>
                {!customer.consentHistory ? (
                  <output className="block text-pretty text-sm text-muted-foreground">
                    同意履歴を表示できません。画面を更新してお試しください。
                  </output>
                ) : consents.length === 0 && (
                  <p className="text-sm text-muted-foreground">保存された同意記録はありません</p>
                )}
                {consents.map((entry) => (
                  <div key={entry.id} className="flex items-start justify-between gap-3 text-sm">
                    <div>
                      <p className="font-medium">{CONSENT_TYPE_LABELS[entry.type] ?? "同意記録"}</p>
                      <p className="text-xs text-muted-foreground">{entry.version}</p>
                    </div>
                    <time
                      dateTime={entry.consentedAt}
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                      {formatFullJstDate(new Date(entry.consentedAt))} {formatTime(entry.consentedAt)}
                    </time>
                  </div>
                ))}
                {consentPage.error && (
                  <p className="text-pretty text-sm text-destructive" role="alert">
                    続きの同意履歴を読み込めませんでした。もう一度お試しください。
                  </p>
                )}
                {consentPage.nextOffset !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={loadMoreConsents}
                    disabled={consentPage.pending}
                  >
                    {consentPage.pending
                      ? "同意履歴を読み込み中"
                      : "同意履歴をさらに読み込む"}
                  </Button>
                )}
              </Section>
    );
  };

  return (
    <>
      {!!customerId && <section aria-label="顧客カルテ" className="min-w-0">
        {gateBlocked && !suspended && <CustomerGateCard onVerified={() => {
          void detailQuery.refetch().then((result) => { if (result.data?.ok && !result.error) setGateRequired(false); });
        }} />}
        <div hidden={gateBlocked}>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => { if (hasUnsavedDraft()) setDiscardDraftNext("close"); else closePanel(); }}>
              <ArrowLeft aria-hidden="true" /> 顧客一覧に戻る
            </Button>
            {originReservationId && <Button variant="outline" onClick={() => setSelectedReservationId(originReservationId)}>予約詳細に戻る</Button>}
            <span className="text-sm text-muted-foreground">顧客 / 顧客カルテ</span>
          </div>
          {isPending && <DetailSkeleton />}
          {isError && (
            <p className="p-4 text-sm text-destructive">顧客情報の取得に失敗しました。</p>
          )}
          {customer && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
                  <h1 className="break-words text-3xl font-bold tracking-tight sm:text-4xl">{customer.displayName}</h1>
                  {customer.displayNameKana && <p className="text-muted-foreground">{customer.displayNameKana}</p>}
                  {customer.lineIdentities.length > 0 && <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700" variant="outline">LINE連携済み</Badge>}
                  {customer.blockStatus === "blocked" && <Badge variant="destructive">ブロック中</Badge>}
                  {isArchived && <Badge variant="outline">アーカイブ済み</Badge>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {!isArchived && <Button variant="outline" onClick={startEditProfile}>基本情報を編集</Button>}
                  {customer.blockStatus !== "blocked" && !isArchived && <Button onClick={handleQuickBook}>＋ 予約を追加</Button>}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm sm:text-base">
                <span className="flex items-center gap-2"><Users className="size-5 text-muted-foreground" aria-hidden="true" />来店 <strong>{customer.validVisitCount}回</strong></span>
                <span className="flex items-center gap-2"><CalendarDays className="size-5 text-muted-foreground" aria-hidden="true" />最終来店 <strong>{chartLastVisitLabel(customer.lastVisitAt)}</strong></span>
                {customer.phoneNormalized && <span className="flex items-center gap-2"><Phone className="size-5 text-muted-foreground" aria-hidden="true" />電話 <strong>{customer.phoneNormalized}</strong></span>}
              </div>
              {editingProfile && <div className="rounded-lg border bg-card p-4 sm:p-5">{renderProfileSection()}</div>}
              <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
                {renderChartSummary()}
                <div className="min-w-0 rounded-lg border bg-card p-4 sm:p-5">
                  <h2 className="mb-3 text-xl font-bold">履歴</h2>
                  <Tabs value={historyTab} onValueChange={setHistoryTab}>
                    <TabsList className="mb-3 grid w-full max-w-sm grid-cols-2 border bg-transparent p-0">
                      <TabsTrigger value="visits" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">来店・施術記録</TabsTrigger>
                      <TabsTrigger value="reservations" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">予約履歴</TabsTrigger>
                    </TabsList>
                    <TabsContent value="visits">
              <Section title={`来店履歴 (${customer.validVisitCount}件)`}>
                {renderManualVisitForm()}
                {visits.length === 0 && (
                  <p className="text-sm text-muted-foreground">来店記録なし</p>
                )}
                {visits.map((visit, index) => (
                  <details
                    key={visit.id}
                    open={index === 0 || editingNoteId === visit.id || editingDateId === visit.id}
                    className={`group space-y-3 rounded-lg border p-4${
                      visit.status === "voided" ? " border-dashed text-muted-foreground opacity-60" : ""
                    }`}
                  >
                    <summary className="cursor-pointer list-none space-y-2 [&::-webkit-details-marker]:hidden">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <time dateTime={visit.visitedAt} className="font-semibold">{formatFullJstDate(new Date(visit.visitedAt))}</time>
                          <Badge variant="outline" className={visit.status === "valid" ? statusColor("completed") : ""}>{visit.status === "valid" ? "来店済み" : visitStatusLabel(visit.status)}</Badge>
                        </div>
                        <ChevronDown className="size-4 shrink-0 group-open:rotate-180" aria-hidden="true" />
                      </div>
                      <p className="break-words font-semibold">{chartServiceName(visit.serviceName, visit.serviceNameSource)}</p>
                      <p className="text-xs text-muted-foreground">{visit.storeName ?? stores.find((store) => store.id === visit.storeId)?.name ?? "店舗名未記録"} · <span>登録: {visit.recordedBy ?? "不明"}</span>{isManualVisit(visit) ? " · 紙・手動の記録" : ""}</p>
                    </summary>
                    <div className="space-y-3 border-t pt-3">
                    {retainedEditingVisit?.id === visit.id && <output className="block text-xs text-muted-foreground">編集中の来店記録と下書きを保持しています。</output>}
                    <div className="flex items-center justify-between gap-2 text-sm">
                      {editingDateId === visit.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="date"
                            max={todayKey}
                            aria-label="来店日"
                            value={dateValue}
                            onChange={(e) => setDateValue(e.target.value)}
                            className="w-auto"
                          />
                          <Button
                            size="sm"
                            onClick={saveDate}
                            disabled={updateVisitMutation.isPending || !dateValue}
                          >
                            {updateVisitMutation.isPending ? "保存中..." : "保存"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingDateId(null)}
                            disabled={updateVisitMutation.isPending}
                          >
                            キャンセル
                          </Button>
                        </div>
                      ) : <h3 className="text-sm font-semibold">施術メモ</h3>}
                    </div>
                    {editingNoteId === visit.id && visit.status === "valid" ? (
                      <div className="space-y-1">
                        <Textarea
                          aria-label="施術メモ"
                          value={noteValue}
                          onChange={(e) => setNoteValue(e.target.value)}
                          rows={3}
                          maxLength={2000}
                          disabled={notesMutation.isPending}
                        />
                        <CharCount value={noteValue} max={2000} />
                        {notesConflict && <ChartConflictNotice
                          onReload={async () => {
                            const fresh = await reloadCustomer();
                            let latest = fresh.visits.find((row) => row.id === visit.id);
                            if (!latest) {
                              const offset = editingVisitSnapshot?.pageOffset ?? 0;
                              if (offset < CUSTOMER_VISITS_PAGE_SIZE) throw new Error("visit_missing");
                              const page = await visitsPageMutation.mutateAsync({ customerId: fresh.id, offset });
                              latest = page.visits.find((row) => row.id === visit.id);
                            }
                            if (latest?.status !== "valid") throw new Error("visit_missing");
                            return latest.treatmentNotes;
                          }}
                          onResume={(latest) => { setNoteBaseline(latest); setNotesConflict(false); }}
                        />}
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveNotes} disabled={notesMutation.isPending || notesConflict}>
                            {notesMutation.isPending ? "保存中..." : "保存"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingNoteId(null)}
                            disabled={notesMutation.isPending}
                          >
                            キャンセル
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        {visit.treatmentNotes ? (
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                            {visit.treatmentNotes}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground/60">施術メモなし</p>
                        )}
                        {/* 無効化された来店実績は履歴として残すだけ。API 側も
                            status='valid' 以外を 404 で拒否する。 */}
                        {visit.status === "valid" && !isArchived && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="mt-1 text-xs"
                            onClick={() => startEditNotes(visit)}
                            disabled={notesMutation.isPending || (editingNoteId !== null && editingNoteId !== visit.id)}
                          >
                            メモ編集
                          </Button>
                        )}
                      </div>
                    )}
                    {/* 無効化の理由は固定文言。voided_by / voided_at / void_reason は
                        API 応答にも画面にも出さない (誰がいつ操作したかは監査ログ側)。 */}
                    {visit.status === "voided" && (
                      <p className="pt-1 text-xs text-muted-foreground">
                        来店なしへの訂正により無効化されました。
                      </p>
                    )}
                    {/* 来店日の編集・削除は owner+ かつ手動 visit (予約由来でない) のみ。
                        予約由来の来店記録は予約側で管理するため変更不可。理由はコメント
                        だけでなく画面にも出す (ボタンが無い理由が分からないため)。 */}
                    {isPrivileged && visit.reservationId != null && visit.status === "valid" && (
                      <p className="pt-1 text-xs text-muted-foreground">
                        この来店記録は予約に連動しています。訂正は予約側から行ってください。
                      </p>
                    )}
                    {isPrivileged && !isArchived && isManualVisit(visit) && editingDateId !== visit.id && (
                      <div className="flex gap-2 pt-1">
                        {/* 別の行で編集/削除が処理中の間は無効化。処理中の保存が解決した時の
                            onSuccess(setEditingDateId(null)) が、新しく開いた別行の編集を
                            閉じてしまう共有state競合を防ぐ。 */}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs"
                          disabled={updateVisitMutation.isPending || deleteVisitMutation.isPending}
                          onClick={() => startEditDate(visit.id, visit.visitedAt)}
                        >
                          来店日を編集
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs text-destructive hover:text-destructive"
                          disabled={updateVisitMutation.isPending || deleteVisitMutation.isPending}
                          onClick={() => setDeleteVisitId(visit.id)}
                        >
                          削除
                        </Button>
                      </div>
                    )}
                    {visit.reservationId && <Button size="sm" variant="ghost" className="px-0 text-primary underline underline-offset-4" onClick={() => setSelectedReservationId(visit.reservationId)}>予約詳細を見る →</Button>}
                    </div>
                  </details>
                ))}
                {visitsPageError && <p className="text-sm text-destructive" role="alert">続きの来店履歴を読み込めませんでした。もう一度お試しください。</p>}
                {nextVisitOffset === null && visits.length > 0 && <p className="text-center text-xs text-muted-foreground">来店履歴の終端です</p>}
                {nextVisitOffset !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={loadMoreVisits}
                    disabled={visitsPageMutation.isPending}
                  >
                    {visitsPageMutation.isPending ? "読み込み中..." : "さらに読み込む"}
                  </Button>
                )}
              </Section>

                    </TabsContent>
                    <TabsContent value="reservations">
                {renderReservationHistory()}
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
              <div className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
                {!editingProfile && renderProfileSection()}
                <Separator />
                {renderConsentHistory()}

              <Separator />

              {isPrivileged && customer.duplicateConsentHistory.length > 0 && (
                <>
                  <Section title={`重複予約の同意履歴 (${customer.duplicateConsentHistory.length}件)`}>
                    <p className="text-xs text-muted-foreground">
                      他のご予約がある状態で新たに予約した際に、警告へ同意した記録です。繰り返し多い場合はご注意ください。
                    </p>
                    {customer.duplicateConsentHistory.map((entry) => (
                      <div
                        key={`${entry.reservationId}-${entry.consentedAt}`}
                        className="flex items-center justify-between text-sm"
                      >
                        <span>
                          {formatFullJstDate(new Date(entry.consentedAt))}{" "}
                          {formatTime(entry.consentedAt)}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">既存{entry.existingCount}件</span>
                          <Badge variant={entry.stage === "hard" ? "destructive" : "outline"}>
                            {entry.stage === "hard" ? "変更不可" : "警告"}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </Section>
                  <Separator />
                </>
              )}

              <CustomerAdminActions
                active={customer.blockStatus === "active"}
                hasLineIdentity={customer.lineIdentities.length > 0}
                archived={isArchived}
                onBlock={() => setBlockConfirm("block")}
                onUnblock={() => setBlockConfirm("unblock")}
                onLinkLine={() => setLinkLineOpen(true)}
                onArchive={() => setArchiveConfirm("archive")}
                onUnarchive={() => setArchiveConfirm("unarchive")}
                onDelete={() => {
                  setDeleteConfirmText("");
                  setDeleteOpen(true);
                }}
              />
              </div>
            </div>
          )}
        </div>
      </section>}
      <ReservationDetailPanel onOpenChart={() => setSelectedReservationId(null)} reservationId={selectedReservationId} onClose={() => setSelectedReservationId(null)} suspended={gateBlocked} />

      <PendingConfirmDialog
        open={!!blockConfirm && !gateBlocked}
        pending={blockMutation.isPending}
        title={blockDialog.title}
        description={blockDialog.description}
        confirmLabel="実行"
        onOpenChange={() => setBlockConfirm(null)}
        onConfirm={handleBlockAction}
      />

      <PendingConfirmDialog
        open={!!archiveConfirm && !gateBlocked}
        pending={archiveMutation.isPending}
        title={archiveDialog.title}
        description={archiveDialog.description}
        confirmLabel="実行"
        onOpenChange={() => setArchiveConfirm(null)}
        onConfirm={handleArchiveAction}
      />

      <AlertDialog open={deleteOpen && !gateBlocked} onOpenChange={(open) => {
        if (!open && deleteMutation.isPending) return;
        if (!open) { setDeleteOpen(false); setDeleteConfirmText(""); }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>顧客を完全に削除</AlertDialogTitle>
            <AlertDialogDescription>
              この顧客と、関連する予約・来店履歴・LINE連携などの記録をすべて完全に削除します。
              {/* 和文なので要素間に空白を入れない（Sonar S6772: 意図の明示） */}
              <strong className="text-destructive">この操作は取り消せません。</strong>
              通常はアーカイブのご利用をおすすめします。削除するには、顧客名「{customer?.displayName}」を入力してください。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor={deleteConfirmInputId} className="text-xs">確認のため顧客名を入力</Label>
            <Input
              id={deleteConfirmInputId}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={customer?.displayName ?? ""}
              disabled={deleteMutation.isPending}
              autoComplete="off"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={
                deleteMutation.isPending ||
                !customer ||
                deleteConfirmText.trim() !== customer.displayName.trim()
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "削除中..." : "完全に削除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PendingConfirmDialog
        open={clearNoteVisitId !== null && !gateBlocked}
        pending={notesMutation.isPending}
        title="施術メモを消しますか？"
        description="この来店に記録されている施術メモが消えます。この操作は取り消せません。"
        confirmLabel="消して保存"
        pendingLabel="保存中..."
        cancelLabel="やめる"
        destructive
        onOpenChange={() => setClearNoteVisitId(null)}
        onConfirm={() => { if (clearNoteVisitId) commitNotes(clearNoteVisitId); }}
      />

      <PendingConfirmDialog
        open={discardDraftNext !== null && !gateBlocked}
        pending={false}
        title="書きかけの入力があります"
        description="保存していない内容は失われます。閉じてよろしいですか？"
        confirmLabel="破棄して閉じる"
        cancelLabel="編集に戻る"
        destructive
        onOpenChange={() => setDiscardDraftNext(null)}
        onConfirm={discardDraftNext === "quickBook" ? quickBook : closePanel}
      />

      <PendingConfirmDialog
        open={deleteVisitId !== null && !gateBlocked}
        pending={deleteVisitMutation.isPending}
        title="来店履歴を削除"
        description="この来店記録を削除します。来店回数・最終来店日に反映されます。この操作は取り消せません。"
        confirmLabel="削除"
        pendingLabel="削除中..."
        destructive
        onOpenChange={() => setDeleteVisitId(null)}
        onConfirm={handleDeleteVisit}
      />

      {/* key で顧客毎に remount → 前回の検索語が次の顧客へ持ち越されない。 */}
      <LinkLineFromCardDialog
        key={`link-line-${linkLineOpen ? customer?.id ?? "open" : "closed"}`}
        customer={linkLineOpen && customer && !gateBlocked ? { id: customer.id, displayName: customer.displayName } : null}
        onClose={() => setLinkLineOpen(false)}
      />
    </>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

// 来店履歴 1 ページの件数。サーバー側 (src/admin/operations.ts の
// CUSTOMER_VISITS_PAGE_SIZE) と同じ値でないと「さらに読み込む」が出ない、
// または出たまま空を引き続ける。
const CUSTOMER_VISITS_PAGE_SIZE = 50;

// テキストエリアの入力文字数 / 上限を控えめに表示する（上限超過前に気づけるように）。
function CharCount({ value, max }: Readonly<{ value: string; max: number }>) {
  return (
    <p className="text-right text-xs text-muted-foreground" aria-hidden="true">
      {value.length} / {max}
    </p>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4 pt-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-px w-full" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

function isStaleSnapshot(error: unknown) {
  return error instanceof ApiError && error.status === 409 &&
    (error.body as { reason?: string } | null)?.reason === "stale_snapshot";
}

function isCustomerGateRequired(error: unknown) {
  return error instanceof ApiError && error.status === 403 &&
    (error.body as { reason?: string } | null)?.reason === "customer_gate_required";
}

function chartServiceName(name: string | null | undefined, source: "snapshot" | "current" | "unrecorded" | undefined) {
  if (!name) return "メニュー未記録";
  const display = displayServiceName(name);
  return source === "snapshot" ? display : `${display}（現在の名称・当時の名称は未記録）`;
}

function isManualVisit(visit: CustomerDetail["visits"][number]) {
  return visit.reservationId == null && ["manual_import", "paper_chart_import"].includes(visit.visitSource);
}


function ChartReservationCard({ reservation, onSelect }: Readonly<{ reservation: Reservation; onSelect: (id: string) => void }>) {
  const createdAt = reservation.createdAt && Number.isFinite(Date.parse(reservation.createdAt)) ? reservation.createdAt : null;
  const origin = reservationOriginLabel(reservation.reservationOrigin ?? null) ??
    (["admin", "phone_admin"].includes(reservation.source) ? "経路未記録" : null);
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">来店予定</p>
          <time dateTime={reservation.startAt} className="font-semibold">{formatFullJstDate(new Date(reservation.startAt))} {formatTime(reservation.startAt)}</time>
        </div>
        <Badge variant="outline">{statusLabel(reservation.status)}</Badge>
      </div>
      <p className="break-words font-medium">{chartServiceName(reservation.serviceName, reservation.serviceNameSource)}</p>
      <p className="text-xs text-muted-foreground">{reservation.storeName} · {reservation.resourceName}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <dt>登録日時</dt>
        <dd>{createdAt ? <time dateTime={createdAt}>{formatFullJstDate(new Date(createdAt))} {formatTime(createdAt)}</time> : "未記録"}</dd>
        <dt>受付経路</dt>
        <dd>{reservationSourceLabel(reservation.source)}{origin && ` · ${origin}`}</dd>
      </dl>
      {reservation.cancellationFeeUnpaidAt && <Badge variant="destructive">キャンセル料未納</Badge>}
      <Button size="sm" variant="ghost" className="px-0 text-primary underline underline-offset-4" onClick={() => onSelect(reservation.id)}>予約詳細を見る →</Button>
    </div>
  );
}


function chartLastVisitLabel(lastVisitAt: string | null | undefined) {
  if (lastVisitAt === undefined) return "確認できません";
  if (!lastVisitAt) return "来店記録なし";
  return formatFullJstDate(new Date(lastVisitAt));
}
