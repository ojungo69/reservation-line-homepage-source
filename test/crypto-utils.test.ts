import { describe, expect, it } from "vitest";

import { bytesToHex, sha256Hex } from "../src/crypto-utils";

describe("crypto-utils", () => {
  it("sha256Hex of empty string matches the known SHA-256 digest", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("bytesToHex lowercases and zero-pads each byte", () => {
    expect(bytesToHex(new Uint8Array([0, 255]).buffer)).toBe("00ff");
  });
});
