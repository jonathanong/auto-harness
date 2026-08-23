import {
  MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH,
  MAX_RUNTIME_ENVIRONMENT_NAMES,
} from "./host-runtime.ts";

const ENVIRONMENT_NAME = /^[A-Za-z_]\w*$/;

export function parseRequiredEnvironment(
  value: unknown,
  context = "requiredEnvironment",
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new TypeError(`${context} must be a string array`);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${context} must not contain duplicate names`);
  }
  if (value.length > MAX_RUNTIME_ENVIRONMENT_NAMES) {
    throw new TypeError(`${context} must contain at most ${MAX_RUNTIME_ENVIRONMENT_NAMES} names`);
  }
  if (value.some((name) => name.length > MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH)) {
    throw new TypeError(
      `${context} environment variable names must be at most ${MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH} characters`,
    );
  }
  const invalid = value.find(
    (name) => !ENVIRONMENT_NAME.test(name) || name.toUpperCase().startsWith("HARNESS_"),
  );
  if (invalid !== undefined) {
    throw new TypeError(`${context} contains an invalid environment variable name`);
  }
  return [...value].toSorted((a, b) => a.localeCompare(b));
}

/** Ensure the requirements for one host/repository pair fit in a runtime report. */
export function assertHostRepositoryRequiredEnvironmentLimit(
  hostRequiredEnvironment: readonly string[] | undefined,
  repositoryRequiredEnvironment: readonly string[] | undefined,
  context = "requiredEnvironment",
): void {
  const required = new Set([
    ...(hostRequiredEnvironment ?? []),
    ...(repositoryRequiredEnvironment ?? []),
  ]);
  if (required.size > MAX_RUNTIME_ENVIRONMENT_NAMES) {
    throw new TypeError(
      `${context} and host requiredEnvironment must contain at most ${MAX_RUNTIME_ENVIRONMENT_NAMES} distinct names`,
    );
  }
}
