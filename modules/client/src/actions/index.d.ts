import type { TargetSpec } from "../index.js";

/** Dependency-free env→`CreateSessionInput` adapter for GitHub Actions consumers of Auto Harness. */

export type ActionEnvironment = Record<string, string | undefined>;

export class HarnessDispatchError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function requiredEnvironmentValue(environment: ActionEnvironment, key: string): string;

export function parseInteger(
  value: string | undefined,
  key: string,
  minimum: number,
): number | undefined;

/** Parses `HARNESS_REQUIRED_LABELS`-shaped input; `fieldName` customizes the error message only. */
export function parseRequiredLabels(value: string | undefined, fieldName?: string): string[];

export function parseConcurrencyId(
  value: string | undefined,
  options?: { fieldName?: string; optional?: boolean; allowAnyCharacters?: boolean },
): string | undefined;

export function parseMetadata(
  value: string | undefined,
  fieldName?: string,
): Record<string, string | number | boolean | null>;

/**
 * Validates a raw URL string is an exact origin, optionally suffixed with `/api/v1`
 * (accepted and stripped, so an API-relative origin round-trips unchanged). Requires https
 * unless `allowHttp` is set.
 */
export function parseApiOrigin(
  rawUrl: string,
  options?: { fieldName?: string; allowHttp?: boolean },
): URL;

/** Validates `HARNESS_URL` is an exact `https://host` origin (no path/query/hash/credentials). */
export function parseHarnessApiOrigin(environment: ActionEnvironment): URL;

export const TARGET_SPEC_KEYS: readonly ["providerId", "providerName", "commandId", "commandName"];

export function parseHarnessTarget(value: string, fieldName?: string): TargetSpec;

export function parseHarnessFallbacks(value: string | undefined, fieldName?: string): TargetSpec[];

export type DispatchResult = {
  id: string;
  url: string;
  created: boolean;
};

/**
 * Writes `session-id`/`session-url`/`created` to `GITHUB_OUTPUT`, a summary table to
 * `GITHUB_STEP_SUMMARY`, and a `::notice` annotation — each only when its env var is set.
 * `route` is the resolved provider/command chain used for this dispatch, if any; omit it for a
 * dispatch that retained an existing session's target.
 */
export function writeOutputs(
  environment: ActionEnvironment,
  result: DispatchResult,
  route?: TargetSpec[],
): void;
