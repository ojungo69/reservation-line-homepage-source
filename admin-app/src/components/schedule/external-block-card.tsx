import { useState } from "react";
import { formatTime, formatDateTime } from "@/lib/timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useExternalBlockCancel } from "@/hooks/use-external-blocks";
import { useAuth } from "@/hooks/use-auth";
import type { ExternalBlock } from "@/types/api";

type ExternalBlockCardProps = {
  block: ExternalBlock;
  // minutes は getCardStyle が返す「表示窓で clip 済み」の分数 (ReservationCard
  // と同じ契約)。営業時間外へはみ出すブロックは実尺より短く描画されるため、
  // 行出し分けはこちらを使う。
  style: { top: string; height: string; minutes: number };
  // 15分スロット1行の高さ(px)。カード実高 = style.minutes/15 × slotPx。
  // style.height は % 文字列のため px はここから導出する。
  slotPx: number;
  // 指定時はカード自前の解除ダイアログを開かず、親に block.id を通知する
  // （スケジュール画面が解除確認ダイアログを集約管理するため）。
  onBlockClick?: (blockId: string) => void;
};

// text は縞 (hairline #E5E5EA) の上にも載るため gray-500 では 4.0:1 を割る —
// gray-600 で縞上でも AA を満たす。
const BASE_CLASS_NAME =
  "stripe-hairline absolute left-0.5 right-0.5 overflow-hidden rounded border border-gray-300 px-1.5 py-0.5 text-left text-xs text-gray-600 dark:border-gray-600 dark:text-gray-400";

export function ExternalBlockCard({
  block,
  style,
  slotPx,
  onBlockClick,
}: Readonly<ExternalBlockCardProps>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useExternalBlockCancel();
  const { isPrivileged } = useAuth();

  // 手動作成した one-off ブロックのみ解除可能。Google 由来のブロックは
  // Google 連携側で管理するため解除アクションを出さない。解除は owner/system_admin
  // 限定（バックエンドが staff を拒否するため UI も privileged に揃える）。
  const isCancellable = block.source === "admin_block" && isPrivileged;

  const label = block.titleSnapshot ?? "ブロック";
  const timeLabel = `${formatTime(block.startAt)}–${formatTime(block.endAt)}`;

  // 縞背景は共有トークン側の .stripe-hairline (glass-tokens.css)。生値の
  // gradient/色を consumer に書かない (contract item 9)。
  // minHeight 22px = text-xs 1 行 16px + py 4px + border 2px。20px だと
  // 5 分ブロックのようにスロット未満の高さでラベル行そのものが clip される
  // (実測 scrollHeight 20 > clientHeight 18)。
  const inlineStyle = {
    top: style.top,
    height: style.height,
    minHeight: "22px",
    zIndex: 5,
  } as const;

  // 高さ=時間長 (FR-008 例外) のため、compact 密度の短時間ブロックでは全行が
  // 収まらない (15分 compact = 24px、text-xs 2行は 32px + py 4px + border 2px
  // = 38px 必要)。overflow-hidden で途中まで見える切れ方をさせず、収まる行だけ
  // 描画する (ReservationCard と同じ扱い、codex P2)。
  const heightPx = (style.minutes / 15) * slotPx;
  const showTime = heightPx >= 38;

  const cardBody = (
    <>
      <div className="truncate font-medium">{label}</div>
      {/* opacity-60 は実効 2.28:1 で WCAG AA 未達 (opacity 合成対応の contrast
          ゲートで検出)。二次情報の弱調は text-xs のみで表現する。
          収まらない高さでも DOM からは外さず sr-only に落とす — PR#350 で
          「title= 依存はタッチだと情報が読めない」を anti-pattern として撤廃済み
          であり、解除不可ブロックは button ですらない (aria-label の経路が無い)
          ため、時間帯を title だけに残すと読み上げ経路が丸ごと消える。
          到達手段の内訳: 読み上げ= この sr-only / マウス= title / 視覚=
          タイムライン上の位置 (毎正時ラベル + 15分ごとの破線グリッド)。
          ponytail: 視覚経路はグリッド粒度が上限で、10:07 開始のような Google
          由来のブロックだと compact 密度ではタッチのみの利用者に分単位までは
          読めない。解除不可＝操作対象でない情報表示であり、24px の要素に
          タップ操作を足すと 44px タップ寸法の要件と衝突するため、ここは
          占有区間が視認できることをもって足りるとする。分単位の提示が要る
          という運用要望が出たら、週表示や詳細パネル側に寄せる。 */}
      <div className={showTime ? "text-xs" : "sr-only"}>{timeLabel}</div>
    </>
  );

  if (!isCancellable) {
    return (
      // 解除できないブロックは aria-label を持つ button ではないため、時刻行を
      // 隠したときに時間帯の到達手段が消える — title で補う。
      <div
        className={BASE_CLASS_NAME}
        style={inlineStyle}
        data-duration-geometry=""
        title={`${label} ${timeLabel}`}
      >
        {cardBody}
      </div>
    );
  }

  // 親が解除確認ダイアログを集約する場合は、クリックを親に委譲し、
  // カード自前のダイアログは描画しない（ダイアログ重複を避ける）。
  if (onBlockClick) {
    return (
      <button
        type="button"
        className={`${BASE_CLASS_NAME} cursor-pointer hover:border-gray-400 hover:text-gray-700 dark:hover:text-gray-200`}
        style={inlineStyle}
        data-duration-geometry=""
        onClick={() => onBlockClick(block.id)}
        aria-label={`ブロック ${label} ${timeLabel} を解除`}
      >
        {cardBody}
      </button>
    );
  }

  const handleCancel = () => {
    cancel.mutate(
      { externalBlockId: block.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          setOpen(false);
          setReason("");
        },
      },
    );
  };

  return (
    <>
      <button
        type="button"
        className={`${BASE_CLASS_NAME} cursor-pointer hover:border-gray-400 hover:text-gray-700 dark:hover:text-gray-200`}
        style={inlineStyle}
        data-duration-geometry=""
        onClick={() => {
          setReason("");
          setOpen(true);
        }}
        aria-label={`ブロック ${label} ${timeLabel} を解除`}
      >
        {cardBody}
      </button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // 解除処理中は閉じさせない。
          if (!next && cancel.isPending) return;
          if (!next) {
            setOpen(false);
            setReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>ブロックを解除しますか?</AlertDialogTitle>
            <AlertDialogDescription>
              {label}（{formatDateTime(block.startAt)} 〜{" "}
              {formatDateTime(block.endAt)}）を解除します。この操作は元に戻せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="block-cancel-reason">理由（任意）</Label>
            <Input
              id="block-cancel-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例: 予定変更のため"
            />
          </div>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                setReason("");
              }}
              disabled={cancel.isPending}
            >
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? "解除中..." : "解除する"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
