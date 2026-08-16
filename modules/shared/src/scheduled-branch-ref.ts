/** Maximum byte length Git accepts for a ref name on common filesystems. */
export const MAX_SCHEDULED_BRANCH_REF_BYTES = 255;

const SHA_LIKE_REF = /^[0-9a-f]{7,64}$/i;

/** Control characters and DEL are never legitimate in a ref or revision expression. */
function hasControlCharacter(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 0x7f,
  );
}

/**
 * `git check-ref-format --branch`'s reserved characters. `~^:?*[\` are meaningful
 * revision-expression syntax (`HEAD~1`, `main^2`) that `git rev-parse` must accept, so
 * this applies only to the scheduled-branch check below — a manual session's `ref` is a
 * revision expression, not necessarily a branch name, and rejecting these would reject
 * legitimate one-shot targets like `HEAD~1`.
 */
function hasForbiddenBranchCharacter(value: string): boolean {
  return hasControlCharacter(value) || [..."~^:?*[\\"].some((c) => value.includes(c));
}

/**
 * Shell/git-argv-hostile shapes rejected for every caller-supplied ref, scheduled or
 * manual: a leading `-` would be consumed as a flag by `git rev-parse`/`git switch` if it
 * ever reached them without a `--` separator, and the rest mirror `git check-ref-format`.
 */
function hasUnsafeRefShape(value: string): boolean {
  return (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    hasControlCharacter(value)
  );
}

function hasSafeRefPathSegments(value: string): boolean {
  return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
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
    hasUnsafeRefShape(value) ||
    hasForbiddenBranchCharacter(value) ||
    SHA_LIKE_REF.test(value)
  ) {
    return false;
  }
  return hasSafeRefPathSegments(value);
}

/**
 * Validate any caller-supplied git ref for shell/argv safety — the manual session `ref`
 * field, in particular. Unlike the scheduled-branch check above, this allows `HEAD`, `@`,
 * `refs/*`, and SHA-looking values: a one-shot session may legitimately target a specific
 * commit or fully-qualified ref, where a recurring schedule needs a stable branch name.
 */
export function isValidSessionRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (new TextEncoder().encode(value).length > MAX_SCHEDULED_BRANCH_REF_BYTES) return false;
  if (hasUnsafeRefShape(value)) return false;
  return hasSafeRefPathSegments(value);
}
