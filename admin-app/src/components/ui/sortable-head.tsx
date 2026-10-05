import { type ReactNode } from "react";
import { TableHead } from "@/components/ui/table";

export type SortDir = "asc" | "desc";

// aria-sort 属性値と矢印インジケータを同じ active/sortDir 判定から導出。
function sortableHeadState(
  active: boolean,
  sortDir: SortDir,
): { ariaSort: "ascending" | "descending" | "none"; indicator: string } {
  if (!active) return { ariaSort: "none", indicator: "" };
  return sortDir === "asc"
    ? { ariaSort: "ascending", indicator: " ↑" }
    : { ariaSort: "descending", indicator: " ↓" };
}

// Module scope, NOT defined inside a page component: a component re-created on
// every render is a new type each time, so React unmounts/remounts the column
// header and the sort button loses focus on every click.
export function SortableHead<K extends string>({
  sortKeyName,
  activeKey,
  sortDir,
  onToggle,
  children,
}: Readonly<{
  sortKeyName: K;
  activeKey: K;
  sortDir: SortDir;
  onToggle: (key: K) => void;
  children: ReactNode;
}>) {
  const active = activeKey === sortKeyName;
  const { ariaSort, indicator } = sortableHeadState(active, sortDir);
  return (
    <TableHead aria-sort={ariaSort}>
      <button
        type="button"
        className="-ml-1 flex min-h-11 min-w-11 items-center gap-1 rounded px-1 select-none hover:text-foreground"
        onClick={() => onToggle(sortKeyName)}
      >
        {children}
        <span aria-hidden="true">{indicator}</span>
      </button>
    </TableHead>
  );
}
