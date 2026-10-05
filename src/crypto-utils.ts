// Canonical Web Crypto helpers (Workers-compatible, no dependencies): hex encoding + SHA-256 digests.
const textEncoder = new TextEncoder();

export const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (value: string): Promise<string> =>
  bytesToHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
