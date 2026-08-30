import { AutoHarnessError } from "./errors.js";

/**
 * Resolves a unique `name` to its `id` within a catalog loaded by `catalog()`. Catalog rows are
 * checked defensively for more than one match: create/update name-uniqueness checks are
 * read-then-write races rather than atomic constraints, and legacy rows are not rewritten.
 */
export async function resolveByName(name, catalog, kind) {
  const matches = (await catalog()).filter((entry) => entry.name === name);
  if (matches.length === 0) {
    throw new AutoHarnessError(`no ${kind} named "${name}"`, {
      status: 400,
      code: `UNKNOWN_${kind.toUpperCase()}_NAME`,
    });
  }
  if (matches.length > 1) {
    throw new AutoHarnessError(
      `ambiguous ${kind} name "${name}": ${matches.length} ${
        kind === "repository" ? "repositories" : `${kind}s`
      } share this name`,
      { status: 400, code: `AMBIGUOUS_${kind.toUpperCase()}_NAME` },
    );
  }
  return matches[0].id;
}
