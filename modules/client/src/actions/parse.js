import { requiredEnvironmentValue } from "./env.js";
import { HarnessDispatchError } from "./errors.js";

const MAX_CONCURRENCY_ID_CHARACTERS = 128;
// Mirrors the control plane's own limit (modules/shared/src/validation.ts's
// MAX_CONCURRENCY_ID_BYTES), which allows any byte sequence up to this length.
const MAX_CONCURRENCY_ID_BYTES = 2_048;
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

/**
 * `allowAnyCharacters` widens validation to the control plane's own contract — any byte
 * sequence up to `MAX_CONCURRENCY_ID_BYTES` — for callers (like the dispatch Action) whose
 * concurrency-id may already contain characters the default charset rejects, e.g. a `/`-bearing
 * `${{ github.ref }}`. The default stays narrower (a safe-for-URLs-and-shells charset) for
 * callers with no such existing contract to preserve.
 */
export function parseConcurrencyId(
  value,
  { fieldName = "HARNESS_CONCURRENCY_ID", optional = false, allowAnyCharacters = false } = {},
) {
  const concurrencyId = value?.trim();
  if (!concurrencyId) {
    if (optional) return undefined;
    throw new HarnessDispatchError("INVALID_CONCURRENCY_ID", `${fieldName} is required`);
  }
  if (allowAnyCharacters) {
    if (Buffer.byteLength(concurrencyId, "utf8") > MAX_CONCURRENCY_ID_BYTES) {
      throw new HarnessDispatchError(
        "INVALID_CONCURRENCY_ID",
        `${fieldName} exceeds ${MAX_CONCURRENCY_ID_BYTES} bytes`,
      );
    }
    return concurrencyId;
  }
  if (concurrencyId.length > MAX_CONCURRENCY_ID_CHARACTERS) {
    throw new HarnessDispatchError("INVALID_CONCURRENCY_ID", `${fieldName} exceeds 128 characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(concurrencyId)) {
    throw new HarnessDispatchError(
      "INVALID_CONCURRENCY_ID",
      `${fieldName} contains unsupported characters`,
    );
  }
  return concurrencyId;
}

export function parseMetadata(value, fieldName = "HARNESS_METADATA") {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_METADATA", `${fieldName} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HarnessDispatchError("INVALID_METADATA", `${fieldName} must be a JSON object`);
  }
  for (const [key, fieldValue] of Object.entries(parsed)) {
    const isValidScalar =
      ["string", "boolean"].includes(typeof fieldValue) ||
      fieldValue === null ||
      (typeof fieldValue === "number" && Number.isFinite(fieldValue));
    if (!isValidScalar) {
      throw new HarnessDispatchError(
        "INVALID_METADATA",
        `${fieldName}.${key} must be a string, finite number, boolean, or null`,
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_METADATA_BYTES) {
    throw new HarnessDispatchError("INVALID_METADATA", `${fieldName} exceeds 8192 bytes`);
  }
  return parsed;
}

/**
 * Validates a raw URL string is an exact origin, optionally suffixed with `/api/v1`
 * (accepted and stripped, so an API-relative origin round-trips unchanged). Requires https
 * unless `allowHttp` is set, for callers whose control plane may be reached over plain http
 * (e.g. a local or self-hosted deployment without TLS termination).
 */
export function parseApiOrigin(rawUrl, { fieldName = "HARNESS_URL", allowHttp = false } = {}) {
  let apiUrl;
  try {
    apiUrl = new URL(rawUrl);
  } catch {
    throw new HarnessDispatchError("INVALID_HARNESS_URL", `${fieldName} must be a valid URL`);
  }
  const protocolLabel = allowHttp ? "http or https" : "https";
  if (apiUrl.protocol !== "https:" && !(allowHttp && apiUrl.protocol === "http:")) {
    throw new HarnessDispatchError("INVALID_HARNESS_URL", `${fieldName} must use ${protocolLabel}`);
  }
  const { origin } = apiUrl;
  if (
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.search !== "" ||
    apiUrl.hash !== "" ||
    ![origin, `${origin}/`, `${origin}/api/v1`, `${origin}/api/v1/`].includes(rawUrl)
  ) {
    throw new HarnessDispatchError(
      "INVALID_HARNESS_URL",
      `${fieldName} must be an exact ${protocolLabel} origin, optionally suffixed with /api/v1`,
    );
  }
  return new URL(origin);
}

export function parseHarnessApiOrigin(environment) {
  return parseApiOrigin(requiredEnvironmentValue(environment, "HARNESS_URL"), {
    fieldName: "HARNESS_URL",
  });
}
