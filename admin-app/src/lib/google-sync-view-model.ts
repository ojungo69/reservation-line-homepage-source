import type { Store, SyncStatusSystemAdmin } from "@/types/api";

export function buildGoogleSyncViewModel(
  syncStatus: SyncStatusSystemAdmin,
  settingsStores: Store[],
  selectedStoreId: string | null,
) {
  const calendarToStore = new Map<string, string>();
  for (const store of settingsStores) {
    if (store.googleCalendarId) calendarToStore.set(store.googleCalendarId, store.id);
  }
  for (const channel of syncStatus.channels) {
    calendarToStore.set(channel.calendarId, channel.storeId);
  }

  const seen = new Set(settingsStores.map((store) => store.id));
  const storeOptions = settingsStores.map((store) => ({ id: store.id, label: store.name }));
  const extra = new Set<string>();
  for (const storeId of [
    ...syncStatus.channels.map((channel) => channel.storeId),
    ...syncStatus.googleEvents.map((event) => event.storeId),
    ...syncStatus.dlq.jobs.map((job) => job.storeId),
  ]) {
    if (storeId != null && !seen.has(storeId)) extra.add(storeId);
  }
  for (const id of extra) {
    storeOptions.push({ id, label: `${id.slice(0, 8)}…` });
  }

  if (!selectedStoreId) {
    return {
      storeOptions,
      channels: syncStatus.channels,
      dlqJobs: syncStatus.dlq.jobs,
      googleEvents: syncStatus.googleEvents,
      outboundWrites: syncStatus.outboundWrites,
      conflicts: syncStatus.conflicts,
    };
  }

  return {
    storeOptions,
    channels: syncStatus.channels.filter((channel) => channel.storeId === selectedStoreId),
    dlqJobs: syncStatus.dlq.jobs.filter(
      (job) => job.storeId == null || job.storeId === selectedStoreId,
    ),
    googleEvents: syncStatus.googleEvents.filter((event) => event.storeId === selectedStoreId),
    outboundWrites: syncStatus.outboundWrites.filter((write) => {
      const storeId = calendarToStore.get(write.calendarId);
      return storeId == null || storeId === selectedStoreId;
    }),
    conflicts: syncStatus.conflicts.filter((conflict) => conflict.storeId === selectedStoreId),
  };
}
