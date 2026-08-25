import { existsSync } from "node:fs";
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
  return runner.run({
    argv:
      platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", "pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]
        : ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
    cwd,
    env: { ...environment, CI: "true" },
    timeoutMs,
    ...(signal ? { signal } : {}),
    onChunk,
  });
}
