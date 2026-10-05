import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormHint, invalidFieldProps, type InvalidReason } from "@/components/ui/form-hint";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRecurringPreview, useRecurringCommit } from "@/hooks/use-recurring-blocks";
import { useResourceList } from "@/hooks/use-resources";
import { WEEKDAYS, toggleWeekday } from "@/lib/timeline";

type Props = {
  selectedStoreId: string | null;
};

const BYDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  const m = i % 2 === 0 ? "00" : "30";
  return `${h}:${m}`;
});

const jstToIso = (date: string, time: string): string =>
  new Date(`${date}T${time}:00+09:00`).toISOString();

// プレビュー不可の理由。disabled 判定と表示を同じ導出から取り、フォームの
// 上から下の順で最初に満たされていない条件のみ、対象フィールドと合わせて示す。
// 店舗 (早期 return で実質不達) と曜日 (Badge グループで単一コントロールが
// 無い) は field: null にしてヒント文言のみで伝える。
export function derivePreviewInvalid(
  selectedStoreId: string | null,
  selectedDays: number[],
  durationMinutes: number,
  startDate: string,
  endDate: string,
  resourceId: string,
): InvalidReason<"endTime" | "startDate" | "endDate" | "resourceId"> {
  if (!selectedStoreId) return { field: null, message: "店舗を選択してください" };
  if (selectedDays.length === 0) return { field: null, message: "曜日を選択してください" };
  if (durationMinutes <= 0) return { field: "endTime", message: "終了時刻は開始時刻より後にしてください" };
  if (durationMinutes > 240) return { field: "endTime", message: "1件あたり4時間（240分）以内にしてください" };
  if (!startDate) return { field: "startDate", message: "開始日を入力してください" };
  if (!endDate) return { field: "endDate", message: "終了日を入力してください" };
  if (endDate < startDate) return { field: "endDate", message: "終了日は開始日以降にしてください" };
  if (!resourceId) return { field: "resourceId", message: "リソースを選択してください" };
  return null;
}

export function RecurringBlocksTab({ selectedStoreId }: Readonly<Props>) {
  const { resourceList } = useResourceList(selectedStoreId);
  const previewMutation = useRecurringPreview();
  const commitMutation = useRecurringCommit();

  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [startTime, setStartTime] = useState("12:00");
  const [endTime, setEndTime] = useState("13:00");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [title, setTitle] = useState("");
  const idempotencyKeyRef = useRef<string>("");
  if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = crypto.randomUUID();
  }

  const toggleDay = (day: number) => {
    setSelectedDays((prev) => toggleWeekday(prev, day));
  };

  const durationMinutes = (() => {
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
  })();

  const buildRrule = () => {
    const byDay = selectedDays.map((d) => BYDAY_CODES[d]).join(",");
    return `FREQ=WEEKLY;BYDAY=${byDay}`;
  };

  const hasPreview = previewMutation.data?.ok === true;

  const previewInvalid = derivePreviewInvalid(
    selectedStoreId,
    selectedDays,
    durationMinutes,
    startDate,
    endDate,
    resourceId,
  );

  // 作成はプレビュー済みであることを追加で要求する。commit 専用の理由は
  // preview 側の理由と別 id のヒントに出すため分離する (同文の二重表示防止)。
  const commitOnlyReason =
    previewInvalid === null && !hasPreview ? "先にプレビューを実行してください" : null;
  const commitDisabled = previewInvalid !== null || commitOnlyReason !== null;

  const previewReset = previewMutation.reset;
  const selectedDaysKey = selectedDays.join(",");

  useEffect(() => {
    previewReset();
    setResourceId("");
  }, [selectedStoreId, previewReset]);

  useEffect(() => {
    previewReset();
  }, [selectedDaysKey, startTime, endTime, startDate, endDate, resourceId, previewReset]);

  // Bind the idempotency key to the commit payload, not to each commit attempt:
  // rotate whenever any request_hash field changes (recurring-commit.ts
  // buildRequestHash covers store/resource/rrule/dtstart/windowEnd/duration/title).
  // A corrected retry (changed payload) becomes a fresh request; an unchanged
  // retry keeps the same key so the backend's handleExistingParent resumes the
  // failed parent (same-key + same-hash → CAS-claimed child write loop) instead
  // of starting a second parent. This is why we must NOT rotate on commit error.
  // Kept separate from the preview-reset effects above so a title edit (not part
  // of the preview) rotates the key without clearing the shown occurrences.
  // Depends on the trimmed title (what the payload/request_hash actually sees),
  // so whitespace-only edits don't rotate the key and break same-payload resume.
  const commitTitle = title.trim();
  useEffect(() => {
    idempotencyKeyRef.current = crypto.randomUUID();
  }, [selectedStoreId, resourceId, selectedDaysKey, startTime, endTime, startDate, endDate, commitTitle]);

  const handlePreview = () => {
    if (previewInvalid !== null || !selectedStoreId) return;
    previewMutation.mutate({
      storeId: selectedStoreId,
      resourceId,
      rrule: buildRrule(),
      dtstart: jstToIso(startDate, startTime),
      windowEnd: jstToIso(endDate, "23:59"),
      durationMinutes,
    });
  };

  const handleCommit = () => {
    if (commitDisabled || !selectedStoreId) return;
    commitMutation.mutate(
      {
        idempotencyKey: idempotencyKeyRef.current,
        storeId: selectedStoreId,
        resourceId,
        rrule: buildRrule(),
        dtstart: jstToIso(startDate, startTime),
        windowEnd: jstToIso(endDate, "23:59"),
        durationMinutes,
        title: title.trim() || undefined,
      },
      {
        onSuccess: () => {
          idempotencyKeyRef.current = crypto.randomUUID();
          previewMutation.reset();
        },
      },
    );
  };

  if (!selectedStoreId) {
    return <p className="text-sm text-muted-foreground">店舗を選択してください</p>;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        定期的なブロック枠を一括作成します。最大50件、4時間以内/件。
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>曜日</Label>
          <div className="flex gap-2">
            {WEEKDAYS.map((label, i) => (
              <Badge
                key={label}
                variant={selectedDays.includes(i) ? "default" : "outline"}
                className="cursor-pointer px-4 py-3 hover:opacity-90"
                onClick={() => toggleDay(i)}
              >
                {label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>開始時刻</Label>
            <Select value={startTime} onValueChange={setStartTime}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIME_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>終了時刻</Label>
            <Select value={endTime} onValueChange={setEndTime}>
              <SelectTrigger {...invalidFieldProps(previewInvalid, "endTime", "recurring-preview-hint")}><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIME_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {durationMinutes > 0 && durationMinutes <= 240 && (
          <p className="text-xs text-muted-foreground">{durationMinutes}分間</p>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>開始日</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              {...invalidFieldProps(previewInvalid, "startDate", "recurring-preview-hint")}
            />
          </div>
          <div className="space-y-2">
            <Label>終了日</Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              {...invalidFieldProps(previewInvalid, "endDate", "recurring-preview-hint")}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>リソース</Label>
          <Select value={resourceId} onValueChange={setResourceId}>
            <SelectTrigger {...invalidFieldProps(previewInvalid, "resourceId", "recurring-preview-hint")}><SelectValue placeholder="リソースを選択" /></SelectTrigger>
            <SelectContent>
              {resourceList.filter((r) => r.active).map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>タイトル（任意）</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 休憩" />
        </div>

        {/* 同時に文言が入るのは高々1つ。space-y の隙間を1要素分に抑えるためまとめる */}
        <div>
          <FormHint id="recurring-preview-hint" reason={previewInvalid} />
          <FormHint id="recurring-commit-hint" reason={commitOnlyReason} />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handlePreview}
            disabled={previewInvalid !== null || previewMutation.isPending}
            aria-describedby="recurring-preview-hint"
          >
            {previewMutation.isPending ? "計算中..." : "プレビュー"}
          </Button>
          <Button
            onClick={handleCommit}
            disabled={commitDisabled || commitMutation.isPending}
            aria-describedby="recurring-preview-hint recurring-commit-hint"
          >
            {commitMutation.isPending ? "作成中..." : "作成"}
          </Button>
        </div>
      </div>

      {previewMutation.data?.ok && (
        <Card className="space-y-2 p-4">
          <h3 className="text-sm font-semibold">
            プレビュー ({previewMutation.data.occurrences.length}件)
          </h3>
          {previewMutation.data.truncatedByCap && (
            <p className="text-xs text-amber-600">上限に達したため一部が省略されています</p>
          )}
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {previewMutation.data.occurrences.map((occ) => {
              const start = new Date(occ);
              const end = new Date(start.getTime() + durationMinutes * 60_000);
              const fmt = (d: Date) => d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
              return (
                <p key={occ} className="text-xs text-muted-foreground">
                  {fmt(start)}〜{end.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" })}
                </p>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
