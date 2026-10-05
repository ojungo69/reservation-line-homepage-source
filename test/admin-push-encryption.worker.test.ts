import { generateRequestDetails, generateVAPIDKeys } from "web-push-neo";
import { describe, expect, it } from "vitest";

import { sendAdminPushTest } from "../src/notifications/admin-push";

// Runs on workerd, not Node — this is the only place that proves the Web Push
// crypto path actually works on the runtime we deploy to (WebCrypto only, no
// node:crypto) and that it puts the CURRENT encoding on the wire.
//
// Why the encoding is asserted: three of the four Workers-compatible Web Push
// libraries on npm still emit the withdrawn `aesgcm` draft (separate
// `Encryption:` / `Crypto-Key:` headers, 2-byte padding prefix). Safari — the
// only browser this feature targets — implements RFC 8291 `aes128gcm` only, so
// an upgrade that silently reverted the encoding would break every iOS push
// while every unit test kept passing.

// The encryption imports p256dh, so it has to be a real 65-byte uncompressed
// P-256 point — which is exactly the shape a VAPID public key has. Generating it
// keeps a string that looks like live key material out of the repository.
const subscription = async () => ({
  endpoint: "https://web.push.apple.com/QAAAAA_worker_test",
  keys: {
    p256dh: (await generateVAPIDKeys()).publicKey,
    auth: btoa("test-auth-secret").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  },
});

describe("web push encryption on the worker runtime", () => {
  it("builds an aes128gcm request with a VAPID authorization header", async () => {
    const keys = await generateVAPIDKeys();

    const request = await generateRequestDetails(await subscription(), JSON.stringify({ title: "t" }), {
      TTL: 3600,
      urgency: "high",
      vapidDetails: {
        subject: "mailto:ops@example.com",
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      },
    });

    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    // The withdrawn draft carried salt and the ephemeral key in these headers.
    expect(request.headers).not.toHaveProperty("Encryption");
    expect(request.headers).not.toHaveProperty("Crypto-Key");
    expect(request.headers["Authorization"]).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+,k=[\w-]+$/);
    expect(request.headers["TTL"]).toBe("3600");

    // RFC 8188 header: salt(16) + record size(4, big endian) + keyid length(1)
    // + the ephemeral public key. Anything shorter is a different encoding.
    const body = request.body;
    expect(body).not.toBeNull();
    expect(body!.length).toBeGreaterThan(16 + 4 + 1 + 65);
    expect(new DataView(body!.buffer, body!.byteOffset).getUint32(16)).toBe(4096);
    expect(body![20]).toBe(65);
  });

  it("produces a different ciphertext every time, so the salt is not reused", async () => {
    const keys = await generateVAPIDKeys();
    const details = {
      subject: "mailto:ops@example.com",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    const target = await subscription();
    const build = () =>
      generateRequestDetails(target, JSON.stringify({ title: "t" }), {
        vapidDetails: details,
      });

    const [first, second] = await Promise.all([build(), build()]);
    expect(Array.from(first.body!.slice(0, 16))).not.toEqual(Array.from(second.body!.slice(0, 16)));
  });

  it("constructs the production fetch RequestInit with workerd before sending", async () => {
    const keys = await generateVAPIDKeys();
    const target = await subscription();
    const db = {
      batch: async () => [],
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{
              endpoint: target.endpoint,
              admin_user_id: "admin_worker_test",
              p256dh: target.keys.p256dh,
              auth: target.keys.auth,
            }],
          }),
        }),
      }),
    } as unknown as D1Database;
    let request: Request | undefined;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    await expect(
      sendAdminPushTest(
        {
          VAPID_PUBLIC_KEY: keys.publicKey,
          VAPID_PRIVATE_KEY: keys.privateKey,
          OPERATIONS_NOTIFICATION_EMAIL: "ops@example.com",
        },
        db,
        {id:"admin_worker_test",email:"admin@example.test",role:"owner",staff_member_id:null,store_id:null},
        fetcher
      )
    ).resolves.toEqual({ ok: true, devices: 1, sent: 1 });
    expect(request?.redirect).toBe("manual");
  });
});
