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
  const invalid = value.find((name) => !ENVIRONMENT_NAME.test(name) || name.startsWith("HARNESS_"));
  if (invalid !== undefined) {
    throw new TypeError(`${context} contains an invalid environment variable name`);
  }
  return [...value].toSorted((a, b) => a.localeCompare(b));
}
