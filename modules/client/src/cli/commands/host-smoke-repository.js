/**
 * Creates a throwaway repository for `host smoke` to attach, run one prompt through, and delete
 * again in its teardown. The daemon dispatches sessions against the host-local path this same
 * run attaches (see `smokeInventoryEntry` below) — it never fetches or dials a repository's
 * `url` — so a syntactically valid but inert HTTPS placeholder under the `example.test`
 * reserved TLD (RFC 2606) is fine here, exactly like `e2e/real-cli/real-cli-helpers.ts` and
 * `e2e/control/orchestration.spec.ts` already use for the same reason. `randomHex(bytes)` is
 * injected (defaults to `node:crypto`'s `randomBytes` in `host-smoke.js`) so tests can assert
 * on a deterministic generated name.
 */
export async function createSmokeRepository(client, randomHex) {
  const name = `smoke-${randomHex(6)}`;
  return client.request("/repositories", {
    method: "POST",
    body: JSON.stringify({
      name,
      url: `https://example.test/${name}.git`,
      defaultBranch: "main",
    }),
  });
}

/**
 * The inventory entry `host smoke` attaches via `attachRepository` — one worktree, named after
 * the throwaway repository (`smoke-<hex>`), under `<repoPath>/.worktrees/<that name>`. Worktree
 * names are one namespace across every host (`services/api/src/control-plane-worktree-names.ts`),
 * so a fixed name would make two concurrent smokes on different hosts, or a leftover smoke
 * worktree anywhere in the fleet, reject this attach. `repoPath` is a path on the HOST, which may be a
 * different machine from wherever this CLI runs, so this never joins it with `node:path` (whose
 * separator would be wrong for a remote host) or checks it exists — see `host-smoke.js`'s usage
 * text and the README for the preconditions this command cannot verify itself: `repoPath` must
 * already be a git repository with a clean `main` checkout, and `.worktrees/` must be gitignored
 * there so the daemon's worktree checkout never collides with tracked files.
 */
export function smokeInventoryEntry(repository, repoPath) {
  return {
    id: repository.id,
    path: repoPath,
    defaultBranch: repository.defaultBranch ?? "main",
    worktrees: [
      {
        id: repository.name,
        name: repository.name,
        path: `${repoPath}/.worktrees/${repository.name}`,
        labels: [],
      },
    ],
  };
}
