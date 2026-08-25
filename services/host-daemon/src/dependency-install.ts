import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OutputChunk, ProcessResult, ProcessRunner } from "./executor.ts";

/** A pnpm workspace worktree always has a committed root lockfile. */
export function isPnpmWorkspace(cwd: string): boolean {
  return existsSync(join(cwd, "pnpm-lock.yaml"));
}

/**
 * Install workspace dependencies for a session worktree. `--frozen-lockfile`
 * refuses to mutate the lockfile or dirty the worktree; a lockfile that
 * disagrees with package.json at the checked-out ref fails setup instead of
 * silently drifting.
 *
 * `CI=true` is forced for this step only: a reused worktree's `node_modules`
 * can need a purge-and-recreate (store, virtual-store, or hoisting layout
 * changed since the last install), and pnpm refuses that without a TTY
 * unless CI mode is set. `SpawnProcessRunner` never attaches one.
 *
 * On win32 the install runs through `cmd.exe /d /s /c` rather than a bare
 * `pnpm`/`pnpm.cmd` argv0: `SpawnProcessRunner` always spawns with
 * `shell: false`, and `.cmd` shims are batch scripts that Windows'
 * CreateProcess cannot execute directly — see Node's "Spawning .bat and
 * .cmd files on Windows" doc. `pnpm` and its args stay as separate argv
 * elements (not a joined string), so there is no shell-injection surface.
 *
 * `--ignore-scripts` is mandatory: this install runs for any checked-out
 * ref, including refs a repository-scoped (non-admin) session author
 * chose, before the provider CLI's sandbox launches. Without it, a
 * `preinstall`/`install`/`postinstall`/`prepare` script in that ref would
 * execute arbitrary code as the daemon user, bypassing the admin-only
 * arbitrary-execution boundary `fleet:exec-config`/`catalog:write` draw
 * around setup scripts and command argv (docs/roles.md). A repository that
 * genuinely needs those scripts can run them through its admin-configured
 * `setupScript` instead.
 *
 * `--ignore-pnpmfile` closes the same hole for `.pnpmfile.cjs`: pnpm
 * `require()`s and calls that file's hooks (`readPackage`,
 * `afterAllResolved`, ...) as part of its own resolution logic, not as an
 * npm lifecycle script, so `--ignore-scripts` alone does not stop it from
 * running. A `.pnpmfile.cjs` committed to a non-admin session author's ref
 * would otherwise execute arbitrary code as the daemon user before the
 * frozen-lockfile check even runs.
 *
 * `--modules-dir`/`--store-dir`/`--virtual-store-dir` are pinned explicitly
 * because pnpm also reads them from a project `.npmrc` in the checked-out
 * ref, and CLI flags outrank project config. Confirmed against the pinned
 * `pnpm@10.28.2`: an unpinned install honors a checked-out
 * `.npmrc` setting `store-dir`/`modules-dir` to an arbitrary absolute path
 * and writes there as the daemon user, before the provider sandbox starts —
 * the same admin-only arbitrary-write boundary the scripts/pnpmfile flags
 * protect.
 *
 * `modules-dir`/`virtual-store-dir` are pinned to pnpm's own *relative*
 * defaults (`node_modules`, `node_modules/.pnpm`) rather than an absolute
 * path resolved against `cwd`. This distinction is load-bearing, not
 * cosmetic: pnpm resolves `modules-dir`/`virtual-store-dir` per workspace
 * package (each of `modules/*`/`services/*` normally gets its own
 * `<package>/node_modules` with a `link:`/symlink into the shared
 * `.pnpm` virtual store for workspace-internal deps like
 * `@auto-harness/shared`). Pinning an *absolute* value collapses that
 * per-package resolution — confirmed empirically against a full workspace
 * install with the pinned pnpm: every workspace package's `node_modules`
 * goes uncreated, root `node_modules` ends up with nothing but `.pnpm` and
 * the state file, and `@auto-harness/shared` becomes unresolvable from
 * every dependent package, which is the exact failure class #340 exists to
 * fix. Relative literals still take CLI precedence over a malicious
 * `.npmrc` (verified the same way: a checked-out `.npmrc` redirecting
 * `modules-dir`/`virtual-store-dir` has no effect), while reproducing
 * pnpm's default per-package linking topology exactly. `store-dir` has no
 * such per-package resolution (it's one shared content-addressable store
 * for the whole install), so it stays pinned absolute, under the daemon's
 * own (session-independent) `HOME` rather than pnpm's platform-specific
 * default location — anchored somewhere a checked-out `.npmrc` cannot
 * redirect it away from. Because that default location differs from pnpm's
 * usual platform default, the first install after this pin takes effect is
 * a cold store (full download); every subsequent install — same worktree or
 * a fresh one — reuses the warm, content-addressable store exactly as
 * before.
 */
export async function installWorkspaceDependencies(
  runner: ProcessRunner,
  cwd: string,
  timeoutMs: number,
  onChunk: (chunk: OutputChunk) => void,
  signal: AbortSignal | undefined,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessResult> {
  const storeDir = join(environment.HOME ?? homedir(), ".auto-harness-pnpm-store");
  const installArgs = [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--modules-dir",
    "node_modules",
    "--store-dir",
    storeDir,
    "--virtual-store-dir",
    "node_modules/.pnpm",
  ];
  return runner.run({
    argv:
      platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "pnpm", ...installArgs]
        : ["pnpm", ...installArgs],
    cwd,
    env: { ...environment, CI: "true" },
    timeoutMs,
    ...(signal ? { signal } : {}),
    onChunk,
  });
}
