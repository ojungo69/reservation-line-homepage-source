import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { StoreContext } from "@/providers/store-context";

// Owns the shared store selection. Initialized to the user's home store (null for
// multi-store owner/system_admin = "all stores"). Mounted in AppShell above the
// header and the routed pages so a header switch reaches every consumer.
export function StoreProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { user } = useAuth();
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(user.storeId);
  const selectStore = useCallback((id: string | null) => setSelectedStoreId(id), []);
  // value をインライン生成すると毎レンダー新しい参照になり、選択が変わっていなくても
  // 全 consumer が再レンダーされる（Sonar S6481）。selectStore は useCallback で安定。
  const value = useMemo(() => ({ selectedStoreId, selectStore }), [selectedStoreId, selectStore]);
  return (
    <StoreContext.Provider value={value}>
      {children}
    </StoreContext.Provider>
  );
}
