import { useRef, useState, type FormEvent } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { useCustomerGateRequest, useCustomerGateVerify } from "@/hooks/use-customer-gate";

// サーバーが 1 つのチャレンジに許す入力回数 (src/admin/customer-gate.ts の MAX_ATTEMPTS)。
// 使い切ったあとは正しいコードを入れても同じ「正しくないか期限切れ」しか返らないので、
// 画面側で「もう再送しかない」と言えるようにこの回数を持つ。
const MAX_ATTEMPTS = 5;

/**
 * 承認を持たない staff に出す入り口。顧客データは 1 件も描画しない (FR-011)。
 * 強制しているのはサーバー側で、この画面はその案内。
 */
export function CustomerGateCard({ purpose = "customers", onVerified }: Readonly<{
  purpose?: "customers" | "notes";
  onVerified?: () => void;
}>) {
  const [code, setCode] = useState("");
  // 直近に発行できた challengeId を自分で持つ。表示条件を mutation の `data` から直に引くと
  // 2 方向に壊れる。(1) 再送が 429 (60 秒のクールダウン) で終わると `data` は undefined に
  // 戻ったままなので、オーナーから聞いた有効なコードを入れる欄ごと消える — 429 は発行経路の
  // 掃除より手前で返るため、そのコードはまだ生きている。(2) 逆に自前の sent フラグだけだと
  // 再送中も欄が開いたままで、そこで送信すると challengeId が空文字のまま届く。サーバーは
  // 文字列であることしか見ないので該当行なしの `invalid_code` になり、まだコードを受け取って
  // いないだけの人に「コードが正しくないか期限切れ」と出たうえ、verify のレート制限と監査行
  // まで消費する。成功した id だけを残せば、どちらも起きない。
  const [challengeId, setChallengeId] = useState<string | null>(null);
  // 数える相手を取り違えないための現在値。verify の応答が返る前に再送が成功すると、
  // 遅れて届いた**前の**チャレンジの invalid_code が新しいチャレンジの回数を 1 つ潰し、
  // まだ 5 回残っている画面が先に「再送しかない」と言い出す。
  const challengeIdRef = useRef<string | null>(null);
  challengeIdRef.current = challengeId;
  // 入力を間違えた回数。数えるのは**サーバーが試行として数えた回**だけ。通信エラーや
  // 5xx、認証エラーは verifyCustomerGateCode まで届いていないので D1 の attempts は
  // 増えておらず、ここで数えると、まだ試行が残っているチャレンジを画面が先に閉じて、
  // オーナーへのコード送信をもう 1 通強いることになる。429 (レート制限) も同じ理由で
  // 数えない。
  const [failedAttempts, setFailedAttempts] = useState(0);
  const requestCode = useCustomerGateRequest();
  const verifyCode = useCustomerGateVerify();
  const attemptsExhausted = failedAttempts >= MAX_ATTEMPTS;

  const onSend = () => {
    requestCode.mutate(undefined, {
      onSuccess: (result) => {
        setChallengeId(result.challengeId);
        // 入力欄を空にするのは再送が成功したときだけ。前のコードは今の再送で失効している
        // ので、6 桁を入れたあとに再送した人がそのまま送信すると、新しいチャレンジに古い
        // コードを当てて 5 回の試行を 1 つ潰し、まだ受け取ってもいないコードを「正しくない」
        // と言われる。再送が失敗した回は前のコードがまだ生きているので消さない。
        setCode("");
        setFailedAttempts(0);
      }
    });
  };

  const onVerify = (event: FormEvent) => {
    event.preventDefault();
    if (!challengeId || attemptsExhausted) return;
    const attemptedFor = challengeId;
    verifyCode.mutate(
      { challengeId, code },
      {
        onSuccess: () => onVerified?.(),
        onError: (error) => {
          // 送った時点のチャレンジが今のものでなければ数えない。
          if (attemptedFor !== challengeIdRef.current) return;
          // 400 は invalid_code と invalid_request の 2 つを兼ねる。後者は
          // verifyCustomerGateCode まで届かないので、理由まで見て数える。
          const reason =
            error instanceof ApiError && typeof error.body === "object" && error.body !== null
              ? (error.body as { reason?: string }).reason
              : undefined;
          if (reason === "invalid_code") {
            setFailedAttempts((count) => count + 1);
          }
        }
      }
    );
  };

  const sendLabel = challengeId ? "確認コードを再送する" : "確認コードを送る";
  const Heading = purpose === "notes" ? "h5" : "h1";
  const verifyLabel = purpose === "notes" ? "確認して編集を続ける" : "顧客情報を開く";

  return (
    <div className="p-4 sm:p-6">
      <Card className="mx-auto max-w-md space-y-4 p-6">
        <div className="space-y-1">
          <Heading className="text-lg font-bold">
            {purpose === "notes" ? "施術メモの保存にはオーナーの確認が必要です" : "顧客情報の閲覧にはオーナーの確認が必要です"}
          </Heading>
          <p className="text-sm text-muted-foreground">
            確認コードをオーナーのメールアドレスにお送りします。届いたコードをお聞きして、
            以下に入力してください。一度入力すると、12時間は再入力なしでご利用いただけます。
          </p>
        </div>

        <Button onClick={onSend} disabled={requestCode.isPending} className="w-full">
          {requestCode.isPending ? "送信しています..." : sendLabel}
        </Button>

        {challengeId && (
          <form onSubmit={onVerify} className="space-y-3">
            <p className="text-sm">
              オーナーのメールアドレスに確認コードをお送りしました。有効期限は10分です。
            </p>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="6桁の確認コード"
              aria-label="確認コード"
            />
            <Button
              type="submit"
              disabled={code.length !== 6 || verifyCode.isPending || attemptsExhausted}
              className="w-full"
            >
              {verifyCode.isPending ? "確認しています..." : verifyLabel}
            </Button>
            {attemptsExhausted ? (
              <p className="text-sm text-destructive">
                入力の回数が上限に達したため、このコードはもうご利用いただけません。
                「確認コードを再送する」から新しいコードをお送りして、お聞きし直してください。
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                コードが届かない場合は、1分ほどおいてから再送してください。
              </p>
            )}
          </form>
        )}
      </Card>
    </div>
  );
}
