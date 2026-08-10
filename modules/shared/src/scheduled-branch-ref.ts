/** Maximum byte length Git accepts for a ref name on common filesystems. */
export const MAX_SCHEDULED_BRANCH_REF_BYTES = 255;

const SHA_LIKE_REF = /^[0-9a-f]{7,64}$/i;

function hasForbiddenRefCharacter(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) <= 32 ||
      character.charCodeAt(0) === 0x7f ||
      "~^:?*[\\".includes(character),
  );
}

/**
 * Validate a scheduled checkout branch name without consulting a repository.
 *
 * This follows `git check-ref-format --branch` constraints closely, while
 * deliberately rejecting full `refs/*` names and SHA-looking revisions. A
 * host still verifies the branch exists before running the scheduled job.
 */
export function isValidScheduledBranchRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (new TextEncoder().encode(value).length > MAX_SCHEDULED_BRANCH_REF_BYTES) return false;
  if (
    value === "@" ||
    value === "HEAD" ||
    value.startsWith("refs/") ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    hasForbiddenRefCharacter(value) ||
    SHA_LIKE_REF.test(value)
  ) {
    return false;
  }
  return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}
