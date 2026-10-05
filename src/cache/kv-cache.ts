const DEFAULT_TTL_SECONDS = 60;

export async function getCached<T>(
  kv: KVNamespace | undefined,
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<T> {
  if (kv) {
    const cached = (await kv.get(key, "json")) as T | null;
    if (cached !== null) {
      return cached;
    }
  }

  const fresh = await fetcher();

  if (kv && fresh !== null && fresh !== undefined) {
    await kv.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
  }

  return fresh;
}

// NOTE: this KV cache is intentionally TTL-only — there is no on-write
// invalidation. Admin edits to store options / business-hours / services /
// resources become visible to the public catalog within DEFAULT_TTL_SECONDS
// (60s), an acceptable staleness window for a read-only public catalog. If
// instant reflection is ever required, wire a `kv.delete(key)` into the admin
// mutation handlers using CACHE_KEYS rather than reintroducing a dead helper.
export const CACHE_KEYS = {
  storeOptions: (storeId: string) => `store-options:${storeId}`,
  allStores: () => "all-stores",
  businessHours: (storeId: string) => `business-hours:${storeId}`,
  services: (storeId: string) => `services:${storeId}`,
  resources: (storeId: string) => `resources:${storeId}`,
} as const;
