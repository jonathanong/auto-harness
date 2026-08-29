import { HarnessDispatchError } from "./errors.js";

export const TARGET_SPEC_KEYS = ["providerId", "providerName", "commandId", "commandName"];

function parseTargetRefValue(parsed, key) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HarnessDispatchError("INVALID_TARGET", `${key} must be a JSON object`);
  }
  const rest = Object.keys(parsed).filter((field) => !TARGET_SPEC_KEYS.includes(field));
  if (rest.length > 0) {
    throw new HarnessDispatchError(
      "INVALID_TARGET",
      `${key} must only contain providerId, providerName, commandId, or commandName`,
    );
  }
  const presentKeys = TARGET_SPEC_KEYS.filter((field) => field in parsed);
  if (presentKeys.length !== 1) {
    throw new HarnessDispatchError(
      "INVALID_TARGET",
      `${key} must be exactly one of providerId, providerName, commandId, or commandName`,
    );
  }
  const field = presentKeys[0];
  const fieldValue = parsed[field];
  if (typeof fieldValue !== "string" || fieldValue === "") {
    throw new HarnessDispatchError("INVALID_TARGET", `${key}.${field} must be a non-empty string`);
  }
  return { [field]: fieldValue };
}

export function parseHarnessTarget(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_TARGET", "HARNESS_TARGET must be valid JSON");
  }
  return parseTargetRefValue(parsed, "HARNESS_TARGET");
}

export function parseHarnessFallbacks(value) {
  if (!value?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_FALLBACKS", "HARNESS_FALLBACKS must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new HarnessDispatchError("INVALID_FALLBACKS", "HARNESS_FALLBACKS must be a JSON array");
  }
  return parsed.map((entry, index) => parseTargetRefValue(entry, `HARNESS_FALLBACKS[${index}]`));
}
