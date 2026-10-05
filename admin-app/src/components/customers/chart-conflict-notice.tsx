import { useState } from "react";
import { Button } from "@/components/ui/button";

/** 最新値を確認してから再編集する。確認だけでは下書きや期待値を変えない。 */
export function ChartConflictNotice({ onReload, onResume }: Readonly<{
  onReload: () => Promise<string | null>;
  onResume: (latest: string | null) => void;
}>) {
  const [latest, setLatest] = useState<{ value: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const reload = async () => {
    setPending(true);
    setFailed(false);
    setLatest(null);
    try {
      setLatest({ value: await onReload() });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p>他の担当者が更新しました。下書きは保存されていません。最新内容を確認してから再編集してください。</p>
      <Button size="sm" variant="outline" onClick={() => { void reload(); }} disabled={pending}>
        {pending ? "最新内容を読み込み中" : "最新内容を確認"}
      </Button>
      {failed && <p>最新内容を読み込めませんでした。もう一度お試しください。</p>}
      {latest && <>
        <p className="whitespace-pre-wrap break-words">{latest.value || "記録なし"}</p>
        <Button size="sm" variant="outline" onClick={() => onResume(latest.value)}>確認して下書きを再編集</Button>
      </>}
    </div>
  );
}
