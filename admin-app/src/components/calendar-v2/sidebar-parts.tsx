import { Plus } from "lucide-react";
import { PRESSABLE } from "@/components/shell-v2/pressable";
import { cn } from "@/lib/utils";
import type { Layers } from "./body";

/** The sidebar's 予約を追加: a raised pill, as DESIGN.md §3 keeps shadows for the create button. */
export function CreateReservationButton({ onCreate }: Readonly<{ onCreate: (from: HTMLElement) => void }>) {
  return (
    <div className="px-3 pb-2">
      <button
        type="button"
        onClick={(event) => onCreate(event.currentTarget)}
        className={cn(
          "inline-flex min-h-14 items-center gap-3 rounded-full bg-cal-surface pl-4 pr-6 text-sm font-medium text-cal-text shadow-md ring-1 ring-cal-grid hover:bg-cal-detail",
          PRESSABLE,
        )}
      >
        <Plus className="size-6 text-cal-primary" aria-hidden="true" />
        予約を追加
      </button>
    </div>
  );
}

// The swatches are the blocks' own fills, so each row names what it shows by
// color as well as by its words (DESIGN.md §3).
const LAYER_ROWS = [
  { key: "pending", label: "承認待ち", swatch: "border border-cal-outline bg-cal-pending" },
  { key: "google", label: "Googleカレンダーの予定", swatch: "bg-cal-external" },
] as const;

/** 表示する予定: shows or hides pending bookings and Google's blocks on the calendar. */
export function CalendarLayers({ layers, onChange }: Readonly<{ layers: Layers; onChange: (next: Layers) => void }>) {
  return (
    // The top border is on a wrapper: on the fieldset it would run through the legend.
    <div className="border-t border-cal-grid px-3 pb-3 pt-2">
      <fieldset>
        <legend className="px-4 pb-1 pt-2 text-xs font-medium text-cal-text-secondary">表示する予定</legend>
        {LAYER_ROWS.map((row) => (
          <label key={row.key} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-full px-4 text-sm hover:bg-cal-text/8">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-cal-primary"
              checked={layers[row.key]}
              onChange={(event) => onChange({ ...layers, [row.key]: event.target.checked })}
            />
            <span aria-hidden="true" className={cn("size-3 shrink-0 rounded-sm", row.swatch)} />
            <span className="min-w-0">{row.label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
