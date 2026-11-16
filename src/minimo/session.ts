function invalid(): never { throw new Error("Invalid Minimo session"); }
const encoder = new TextEncoder();
const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;

function validateCookie(cookie: string): void {
  if (typeof cookie !== "string" || !cookie || cookie.length > 4096) invalid();
  const names = new Set<string>();
  for (const part of cookie.split("; ")) {
    const equals = part.indexOf("=");
    const name = part.slice(0, equals);
    const value = part.slice(equals + 1);
    if (equals < 1 || name.length > 128 || !cookieName.test(name) || !cookieValue.test(value)
      || names.has(name) || names.size >= 20) invalid();
    names.add(name);
  }
  if (!names.has("minimo_salontool")) invalid();
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
  const raw = atob(value);
  if (btoa(raw) !== value) invalid();
  return Uint8Array.from(raw, (character) => character.codePointAt(0)!);
}

async function encryptionKey(value: string): Promise<CryptoKey> {
  if (typeof value !== "string" || value.length !== 44) invalid();
  const bytes = decode(value);
  if (bytes.length !== 32) invalid();
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function associatedData(context: string): Uint8Array<ArrayBuffer> {
  if (typeof context !== "string" || !context || context.length > 1024) invalid();
  return encoder.encode(context);
}

export async function sealSession(cookie: string, key: string, context: string): Promise<string> {
  try {
    validateCookie(cookie);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(context) },
      await encryptionKey(key), encoder.encode(cookie)
    );
    return `v1.${btoa(String.fromCodePoint(...iv))}.${btoa(String.fromCodePoint(...new Uint8Array(ciphertext)))}`;
  } catch { return invalid(); }
}

export async function openSession(ciphertext: string, key: string, context: string): Promise<string> {
  try {
    if (typeof ciphertext !== "string" || ciphertext.length > 8192) invalid();
    const parts = ciphertext.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || parts[1].length !== 16) invalid();
    const iv = decode(parts[1]);
    const encrypted = decode(parts[2]);
    if (iv.length !== 12 || encrypted.length < 17 || encrypted.length > 4112) invalid();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(context) },
      await encryptionKey(key), encrypted
    );
    const cookie = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    validateCookie(cookie);
    return cookie;
  } catch { return invalid(); }
}
