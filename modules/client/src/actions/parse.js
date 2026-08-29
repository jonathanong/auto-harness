import { requiredEnvironmentValue } from "./env.js";
import { HarnessDispatchError } from "./errors.js";

const MAX_CONCURRENCY_ID_CHARACTERS = 128;
const MAX_METADATA_BYTES = 8192;

export function parseInteger(value, key, minimum) {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/u.test(value) || Number(value) < minimum || !Number.isSafeInteger(Number(value))) {
    throw new HarnessDispatchError(
      "INVALID_INTEGER",
      `${key} must be a ${minimum === 1 ? "positive" : "non-negative"} integer`,
    );
  }
  return Number(value);
}

export function parseRequiredLabels(value, fieldName = "HARNESS_REQUIRED_LABELS") {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_REQUIRED_LABELS", `${fieldName} must be valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((label) => typeof label === "string" && label !== "")
  ) {
    throw new HarnessDispatchError(
      "INVALID_REQUIRED_LABELS",
      `${fieldName} must be a JSON array of strings`,
    );
  }
  return parsed;
}

export function parseConcurrencyId(value) {
  const concurrencyId = value?.trim();
  if (!concurrencyId) {
    throw new HarnessDispatchError("INVALID_CONCURRENCY_ID", "HARNESS_CONCURRENCY_ID is required");
  }
  if (concurrencyId.length > MAX_CONCURRENCY_ID_CHARACTERS) {
    throw new HarnessDispatchError(
      "INVALID_CONCURRENCY_ID",
      "HARNESS_CONCURRENCY_ID exceeds 128 characters",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(concurrencyId)) {
    throw new HarnessDispatchError(
      "INVALID_CONCURRENCY_ID",
      "HARNESS_CONCURRENCY_ID contains unsupported characters",
    );
  }
  return concurrencyId;
}

export function parseMetadata(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_METADATA", "HARNESS_METADATA must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HarnessDispatchError("INVALID_METADATA", "HARNESS_METADATA must be a JSON object");
  }
  for (const [key, fieldValue] of Object.entries(parsed)) {
    if (!["string", "number", "boolean"].includes(typeof fieldValue) && fieldValue !== null) {
      throw new HarnessDispatchError(
        "INVALID_METADATA",
        `HARNESS_METADATA.${key} must be a string, number, boolean, or null`,
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_METADATA_BYTES) {
    throw new HarnessDispatchError("INVALID_METADATA", "HARNESS_METADATA exceeds 8192 bytes");
  }
  return parsed;
}

export function parseHarnessApiOrigin(environment) {
  const rawUrl = requiredEnvironmentValue(environment, "HARNESS_URL");
  let apiUrl;
  try {
    apiUrl = new URL(rawUrl);
  } catch {
    throw new HarnessDispatchError("INVALID_HARNESS_URL", "HARNESS_URL must be a valid URL");
  }
  if (apiUrl.protocol !== "https:") {
    throw new HarnessDispatchError("INVALID_HARNESS_URL", "HARNESS_URL must use https");
  }
  if (
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.pathname !== "/" ||
    apiUrl.search !== "" ||
    apiUrl.hash !== "" ||
    ![apiUrl.origin, `${apiUrl.origin}/`].includes(rawUrl)
  ) {
    throw new HarnessDispatchError(
      "INVALID_HARNESS_URL",
      "HARNESS_URL must be an exact https origin",
    );
  }
  return apiUrl;
}
