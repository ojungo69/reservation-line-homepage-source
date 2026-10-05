// Shared dedupe-key utilities. Extracted from import-sync.ts so that
// conflict-resolutions.ts (and other modules) can compute the canonical
// dedupe_key for calendar_sync_jobs without duplicating the FNV-1a hash.
//
// The MAX_DEDUPE_KEY_LENGTH constraint comes from the CHECK on
// calendar_sync_jobs.dedupe_key (0001 initial migration).

export const MAX_DEDUPE_KEY_LENGTH = 256;

/** FNV-1a 64-bit hash → 16-hex-char string. */
export const stableHash = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * Returns `rawKey` if it fits the DB column length, otherwise hashes it
 * into `compactPrefix:stableHash(rawKey)`.
 */
export const compactDedupeKey = (rawKey: string, compactPrefix: string): string => {
  if (rawKey.length <= MAX_DEDUPE_KEY_LENGTH) {
    return rawKey;
  }
  return `${compactPrefix}:${stableHash(rawKey)}`;
};
