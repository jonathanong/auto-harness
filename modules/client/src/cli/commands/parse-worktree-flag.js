import { CliUsageError } from "../cli-errors.js";

/**
 * Parses repeated `--worktree <id>=<path>` values (as collected by `parseFlags`'s
 * `repeatableFlags`) into inventory worktree entries: `{ id, name: id, path, labels: [] }`.
 * `name` mirrors `id` — the server's own slug check on `name` (see
 * `modules/shared/src/host-inventory-parse.ts`) is what actually constrains its shape, so this
 * does not re-validate it. Splits on the *first* `=` so a path containing `=` still parses
 * correctly; an entry with no `=`, an empty id, or an empty path is a usage error (exit 2), as
 * is a repeated id — the server would also reject a duplicate worktree id, but only after a
 * round trip, so catching it here is a strictly better error.
 */
export function parseWorktreeFlags(rawValues) {
  const worktrees = [];
  const seenIds = new Set();
  for (const raw of rawValues) {
    const equals = raw.indexOf("=");
    if (equals <= 0 || equals === raw.length - 1) {
      throw new CliUsageError(`--worktree must be <id>=<path>, got: ${raw}`);
    }
    const id = raw.slice(0, equals);
    const path = raw.slice(equals + 1);
    if (seenIds.has(id)) {
      throw new CliUsageError(`--worktree id given more than once: ${id}`);
    }
    seenIds.add(id);
    worktrees.push({ id, name: id, path, labels: [] });
  }
  return worktrees;
}
