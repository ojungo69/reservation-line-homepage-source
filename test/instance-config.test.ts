import { describe, expect, it } from "vitest";
import { parseInstanceConfig } from "../src/instance-config";

const example = {
  displayName: "Example Studio",
  adminHostname: "admin.example.invalid",
  operationsEmailSender: "noreply@example.invalid",
  mensMenuStoreId: "sample-a",
  stagingStoreIds: ["sample-a", "sample-b"]
};

describe("instance configuration boundary", () => {
  it("supports fictional operator values without accepting a credential field", () => {
    expect(parseInstanceConfig(example)).toEqual({ ...example, staffEmailDomain: "example.invalid" });
    expect(() => parseInstanceConfig({ ...example, secret: "must-stay-in-env" })).toThrow();
  });

  it.each([
    { ...example, adminHostname: "admin.example.invalid/path" },
    { ...example, adminHostname: "admin..example.invalid" },
    { ...example, adminHostname: "example.invalid\r\nother" },
    { ...example, operationsEmailSender: "noreply@example.invalid\r\nBcc:other@example.invalid" },
    { ...example, mensMenuStoreId: "" },
    { ...example, stagingStoreIds: ["sample-a", "sample-a"] },
    { ...example, stagingStoreIds: [1] },
    null,
  ])("rejects invalid instance settings", (value) => {
    expect(() => parseInstanceConfig(value)).toThrow();
  });
});
