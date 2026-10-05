import { useState, useMemo, useEffect, useRef } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuditLogs, type AuditLogFilter } from "@/hooks/use-audit-logs";
import { useSettings } from "@/hooks/use-settings";
import { useAuth } from "@/hooks/use-auth";
import { formatAuditSummary, formatTargetLabel, safeParseJson, normalizeTimestamp } from "@/lib/audit-format";
import { formatJstDate, formatTime } from "@/lib/timeline";

const ALL_SENTINEL = "__all__";

const ACTOR_TYPES = [
  { value: "staff", label: "スタッフ" },
  { value: "customer", label: "顧客" },
  { value: "system", label: "システム" },
  { value: "google_calendar", label: "Google Calendar" },
] as const;

function jstDateToIsoFrom(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${date}T00:00:00+09:00`;
}

function jstDateToIsoToExclusive(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// 操作記録は既定で直近7日ぶん（今日を含む7暦日）を表示する（全期間の重い取得を避け、
// 最初から有用な範囲を見せる）。to は jstDateToIsoToExclusive で「翌日0時」までを含むため、
// from は今日の 6 日前にすると [今日-6, 今日] の 7 暦日ちょうどになる（JST は夏時間なし）。
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function getDefaultFrom(): string {
  return formatJstDate(new Date(Date.now() - 6 * MS_PER_DAY));
}
function getDefaultTo(): string {
  return formatJstDate(new Date());
}

export default function ActivityPage() {
  const { user } = useAuth();
  const isSystemAdmin = user.role === "system_admin";
  const { data: settingsData } = useSettings();
  const settings = settingsData?.ok ? settingsData.settings : null;

  const [from, setFrom] = useState(getDefaultFrom);
  const [to, setTo] = useState(getDefaultTo);
  const [actorType, setActorType] = useState(ALL_SENTINEL);
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword] = useDebouncedValue(keyword);

  const filter: AuditLogFilter = useMemo(() => ({
    from: from ? jstDateToIsoFrom(from) : undefined,
    to: to ? jstDateToIsoToExclusive(to) : undefined,
    actorType: actorType === ALL_SENTINEL ? undefined : actorType,
    keyword: debouncedKeyword || undefined,
  }), [from, to, actorType, debouncedKeyword]);

  const { data, isPending, isError } = useAuditLogs(filter);

  const staffMap = useMemo(() => {
    const map = new Map<string, string>();
    if (settings?.staff) {
      for (const s of settings.staff) {
        map.set(s.id, s.displayName);
      }
    }
    return map;
  }, [settings]);

  const logs = data?.ok ? data.auditLogs : [];

  const groupedByDate = useMemo(() => {
    const groups = new Map<string, typeof logs>();
    for (const log of logs) {
      const date = formatJstDate(new Date(normalizeTimestamp(log.createdAt)));
      const list = groups.get(date) ?? [];
      list.push(log);
      groups.set(date, list);
    }
    return groups;
  }, [logs]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold">操作記録</h1>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="audit-from">開始日</Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-36"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-to">終了日</Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-36"
          />
        </div>
        <div className="space-y-1">
          <Label>操作者</Label>
          <Select value={actorType} onValueChange={setActorType}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="全て" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SENTINEL}>全て</SelectItem>
              {ACTOR_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-keyword">キーワード</Label>
          <Input
            id="audit-keyword"
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="操作内容を検索"
            className="w-44"
          />
        </div>
      </div>

      {isPending && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          操作記録の取得に失敗しました。
        </p>
      )}

      {!isPending && logs.length === 0 && (
        <p className="text-sm text-muted-foreground">該当する操作記録はありません</p>
      )}

      {/* サーバは 200 件で打ち切る (operations.ts の hard cap)。API に truncated フラグは
          無いため件数一致で検知する — ちょうど 200 件でも警告は誤りにならない。 */}
      {!isPending && logs.length >= 200 && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          表示件数が上限に達しました。期間を短くするかフィルタを追加してください。
        </p>
      )}

      {[...groupedByDate.entries()].map(([date, entries]) => (
        <div key={date} className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">{date}</h3>
          {entries.map((log) => (
            <ActivityCard
              key={log.id}
              summary={formatAuditSummary(log, staffMap)}
              targetType={formatTargetLabel(log.targetType)}
              targetId={log.targetId}
              timestamp={formatTime(normalizeTimestamp(log.createdAt))}
              metadataJson={isSystemAdmin ? log.metadataJson : null}
              rejectionReason={log.rejectionReason}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// コピーボタンの表示文言(コピー済み/長いIDの省略/そのまま表示)を決める。
function getCopyButtonLabel(copied: boolean, targetId: string): string {
  if (copied) return "コピーしました";
  if (targetId.length > 8) return `${targetId.slice(0, 8)}…`;
  return targetId;
}

function ActivityCard({
  summary,
  targetType,
  targetId,
  timestamp,
  metadataJson,
  rejectionReason,
}: Readonly<{
  summary: string;
  targetType: string;
  targetId: string;
  timestamp: string;
  metadataJson: string | null;
  // 予約却下の行のみサーバーが metadata から抽出して返す (owner にも見える)。
  rejectionReason: string | null;
}>) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // アンマウント時に保留中のリセットタイマーを破棄(setState警告/リーク防止)。
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyTargetId = () => {
    // 非セキュアコンテキスト等では navigator.clipboard 自体が undefined。
    // `clipboard?.writeText(...).then(...)` だと `.then` が undefined 上で呼ばれ
    // TypeError になるため、先に存在を確認してから呼ぶ。
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    clipboard.writeText(targetId).then(
      () => {
        setCopied(true);
        // 連打時に既存タイマーを破棄してから貼り直す(早期消滅のレース防止)。
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
          setCopied(false);
          copyTimerRef.current = null;
        }, 1500);
      },
      () => {
        // 書き込み失敗(権限拒否など)は無視。
      },
    );
  };

  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="text-sm">{summary}</p>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {targetType}
            </Badge>
            <button
              type="button"
              onClick={copyTargetId}
              title={targetId}
              aria-label={`IDをコピー: ${targetId}`}
              className="inline-flex min-h-11 items-center rounded font-mono text-xs text-muted-foreground underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {getCopyButtonLabel(copied, targetId)}
            </button>
          </div>
        </div>
        <span className="whitespace-nowrap text-xs text-muted-foreground">{timestamp}</span>
      </div>
      {rejectionReason && (
        <p className="mt-1 text-sm text-muted-foreground">理由: {rejectionReason}</p>
      )}
      {metadataJson && (
        <div className="mt-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "メタデータを閉じる" : "メタデータ"}
          </Button>
          {expanded && (
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 text-xs">
              {safeParseJson(metadataJson)}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}
