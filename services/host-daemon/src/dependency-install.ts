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
 * protect. `modules-dir`/`virtual-store-dir` are pinned to their existing
 * pnpm defaults (both already resolve under `cwd`), so this is a no-op for a
 * repository that doesn't try to redirect them. `store-dir` is pinned to a
 * fixed path under the daemon's own (session-independent) `HOME` rather than
 * pnpm's platform-specific default location, so it stays content-addressable
 * and shared/warm across sessions exactly as before, just anchored somewhere
 * a checked-out `.npmrc` cannot redirect it away from.
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
  const modulesDir = join(cwd, "node_modules");
  const storeDir = join(environment.HOME ?? homedir(), ".auto-harness-pnpm-store");
  const installArgs = [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--modules-dir",
    modulesDir,
    "--store-dir",
    storeDir,
    "--virtual-store-dir",
    join(modulesDir, ".pnpm"),
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
