import configuration from "../instance-config.json";

const keys = new Set(["displayName", "adminHostname", "operationsEmailSender", "staffEmailDomain", "mensMenuStoreId", "stagingStoreIds"]);
const storeIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function hostname(value: unknown): string {
  if (typeof value !== "string" || value.length > 253 || value.split(".").some((label) =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("Invalid instance hostname");
  }
  const parsed = new URL(`https://${value}`);
  if (parsed.hostname !== value || parsed.port || parsed.username || parsed.password) {
    throw new Error("Invalid instance hostname");
  }
  return value;
}

function storeId(value: unknown): string {
  if (typeof value !== "string" || !storeIdPattern.test(value)) throw new Error("Invalid instance store ID");
  return value;
}

export function parseInstanceConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key)) ||
      !("displayName" in value) || !("adminHostname" in value) || !("operationsEmailSender" in value) || !("staffEmailDomain" in value) ||
      !("mensMenuStoreId" in value) || !("stagingStoreIds" in value)) {
    throw new Error("Invalid instance configuration fields");
  }
  if (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 80 ||
      (/[\r\n]/.test(value.displayName) || value.displayName.includes("\0"))) throw new Error("Invalid instance display name");
  if (typeof value.operationsEmailSender !== "string" ||
      value.operationsEmailSender.length > 254 ||
      !/^[a-zA-Z0-9_%+-]+(?:\.[a-zA-Z0-9_%+-]+)*@[a-z0-9.-]+$/.test(value.operationsEmailSender) ||
      value.operationsEmailSender.indexOf("@") > 64) {
    throw new Error("Invalid instance email sender");
  }
  hostname(value.operationsEmailSender.slice(value.operationsEmailSender.indexOf("@") + 1));
  const staffEmailDomain = hostname(value.staffEmailDomain);
  if (!Array.isArray(value.stagingStoreIds) || !value.stagingStoreIds.length) {
    throw new Error("Invalid instance staging stores");
  }
  const stagingStoreIds = value.stagingStoreIds.map((id: unknown) => storeId(id));
  if (new Set(stagingStoreIds).size !== stagingStoreIds.length) throw new Error("Duplicate instance staging store");
  return Object.freeze({
    displayName: value.displayName,
    adminHostname: hostname(value.adminHostname),
    operationsEmailSender: value.operationsEmailSender,
    mensMenuStoreId: storeId(value.mensMenuStoreId),
    stagingStoreIds: Object.freeze(stagingStoreIds),
    staffEmailDomain
  });
}

export const INSTANCE_CONFIG = parseInstanceConfig(configuration);
