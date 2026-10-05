import { createContext } from "react";

// Shared "currently selected store" so the header switcher, the schedule/timeline,
// and the per-page store selectors all reference one selection instead of each
// useStores() call owning its own disconnected useState.
export type StoreSelectionValue = {
  selectedStoreId: string | null;
  selectStore: (id: string | null) => void;
};

export const StoreContext = createContext<StoreSelectionValue | null>(null);
