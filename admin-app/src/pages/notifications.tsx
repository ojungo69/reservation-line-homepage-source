import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminPush } from "@/hooks/use-admin-push";

/**
 * 端末ごとのプッシュ通知設定。
 *
 * 店舗設定ではなくこの独立ページに置いている: 店舗設定はオーナー専用ルートで、
 * スタッフも自分の端末で受け取れるという要件を満たせないため。
 */
function NotificationsPage() {
  const {
    supported,
    configured,
    needsHomeScreen,
    permission,
    isSubscribed,
    isChecking,
    isBusy,
    isTesting,
    subscribe,
    unsubscribe,
    sendTest,
  } = useAdminPush();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Bell className="h-5 w-5" aria-hidden="true" />
        <h1 className="text-lg font-semibold">通知</h1>
      </div>

      <Card className="space-y-3 p-4">
        <div>
          <p className="text-sm font-medium">この端末のプッシュ通知</p>
          <p className="mt-1 text-xs text-muted-foreground">
            新しいご予約の申込や、承認期限が近づいた予約をお知らせします。
            管理画面を開いていなくても届きます。
          </p>
        </div>

        <PushControls
          supported={supported}
          configured={configured}
          needsHomeScreen={needsHomeScreen}
          permission={permission}
          isSubscribed={isSubscribed}
          isChecking={isChecking}
          isBusy={isBusy}
          isTesting={isTesting}
          subscribe={subscribe}
          unsubscribe={unsubscribe}
          sendTest={sendTest}
        />

        <p className="text-xs text-muted-foreground">
          設定は端末ごとです。別のスマートフォンやパソコンでも受け取るには、
          その端末で同じ操作をしてください。
        </p>
      </Card>
    </div>
  );
}

type PushControlsProps = ReturnType<typeof useAdminPush>;

function PushControls({
  supported,
  configured,
  needsHomeScreen,
  permission,
  isSubscribed,
  isChecking,
  isBusy,
  isTesting,
  subscribe,
  unsubscribe,
  sendTest,
}: Readonly<PushControlsProps>) {
  if (!configured) {
    return (
      <p className="text-sm text-muted-foreground">
        この環境ではプッシュ通知が設定されていません。
      </p>
    );
  }

  if (!supported) {
    return (
      <p className="text-sm text-muted-foreground">
        この端末・ブラウザではプッシュ通知をご利用いただけません。
        iPhone や iPad をお使いの場合は、Safari で管理画面を開き、
        共有メニューから「ホーム画面に追加」して、
        追加されたアイコンから開き直してください。
      </p>
    );
  }

  if (isChecking) {
    return <Skeleton className="h-9 w-40" />;
  }

  if (permission === "denied") {
    return (
      <p className="text-sm text-muted-foreground">
        この端末で通知が拒否されています。端末の設定アプリからこの管理画面の
        通知を許可したあと、もう一度お試しください。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {needsHomeScreen && (
        <p className="text-xs text-amber-600">
          iPhone・iPad では、ホーム画面に追加したアイコンから開いた場合のみ
          通知を登録できます。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {isSubscribed ? (
          <Button variant="outline" onClick={() => void unsubscribe()} disabled={isBusy}>
            通知を停止する
          </Button>
        ) : (
          <Button onClick={() => void subscribe()} disabled={isBusy}>
            通知を受け取る
          </Button>
        )}
        {isSubscribed && (
          <Button variant="outline" onClick={sendTest} disabled={isTesting}>
            テスト送信
          </Button>
        )}
      </div>
    </div>
  );
}

export default NotificationsPage;
