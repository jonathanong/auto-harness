/** Lowercase alphanumeric segments joined by single dashes — no leading/trailing/double dashes. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlugName(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export const SLUG_NAME_HINT = "lowercase letters, numbers, and dashes only (e.g. my-repo-name)";
