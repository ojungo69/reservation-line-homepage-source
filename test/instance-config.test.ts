import { describe, expect, it } from "vitest";
import { parseInstanceConfig } from "../src/instance-config";

const example = {
  displayName: "Example Studio",
  adminHostname: "admin.example.invalid",
  operationsEmailSender: "noreply@example.invalid",
  staffEmailDomain: "example.invalid",
  mensMenuStoreId: "sample-a",
  stagingStoreIds: ["sample-a", "sample-b"]
};

describe("instance configuration boundary", () => {
  it("keeps the staff email domain independent of the notification sender subdomain", () => {
    expect(parseInstanceConfig({ ...example, operationsEmailSender: "noreply@mail.example.invalid", staffEmailDomain: "example.invalid" })).toMatchObject({
      operationsEmailSender: "noreply@mail.example.invalid",
      staffEmailDomain: "example.invalid"
    });
  });

  it("supports fictional operator values without accepting a credential field", () => {
    expect(parseInstanceConfig(example)).toEqual(example);
    expect(() => parseInstanceConfig({ ...example, secret: "must-stay-in-env" })).toThrow();
  });

  it.each([
    { ...example, adminHostname: "admin.example.invalid/path" },
    { ...example, adminHostname: "admin..example.invalid" },
    { ...example, adminHostname: "example.invalid\r\nother" },
    { ...example, operationsEmailSender: "noreply@example.invalid\r\nBcc:other@example.invalid" },
    { ...example, displayName: "example\0studio" },
    { ...example, operationsEmailSender: "..@example.invalid" },
    { ...example, operationsEmailSender: "name.@example.invalid" },
    { ...example, operationsEmailSender: "first..last@example.invalid" },
    { ...example, staffEmailDomain: "example.invalid/path" },
    { ...example, mensMenuStoreId: "" },
    { ...example, stagingStoreIds: ["sample-a", "sample-a"] },
    { ...example, stagingStoreIds: [1] },
    null,
  ])("rejects invalid instance settings", (value) => {
    expect(() => parseInstanceConfig(value)).toThrow();
  });
});
