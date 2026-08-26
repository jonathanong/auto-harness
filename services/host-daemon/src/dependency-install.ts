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
 *
 * `--package-import-method copy` closes a separate hole in that shared
 * store (jonathanong/auto-harness#350). `--store-dir` being one store
 * shared by every worktree on the host is not itself the bug. The bug is
 * pnpm's default `auto` import method, which resolves to `hardlink` on
 * filesystems without clone/reflink support (confirmed empirically against
 * the pinned `pnpm@10.28.2`, comparing forced `hardlink` vs. macOS/APFS's
 * `auto` default of `clone`): under hardlink, every worktree's copy of an
 * unchanged package is the *same inode* as the store's copy, not an
 * independent file. A worktree boundary that looks writable-only-within-
 * itself is not: a write to a hardlinked file anywhere — a session's agent
 * process patching a dependency while debugging, a partial/corrupted write,
 * anything that touches the file in place rather than replacing it —
 * mutates every other worktree's copy and the store entry itself, instantly
 * and with no revalidation, for as long as those other sessions keep
 * running (verified the same way: mutating one worktree's linked file was
 * immediately visible from a second, already-installed worktree sharing the
 * store). Per docs/plan.md's D9, the daemon does not sandbox worktrees from
 * each other at the OS level — the CLI's own writable-root boundary is what
 * is supposed to hold here, and hardlinking silently defeats it regardless
 * of `--frozen-lockfile`, which guards what pnpm resolves to install, not
 * what a process does to the files afterward. A later fresh install
 * elsewhere against the same store does self-heal — pnpm re-verifies
 * content against the lockfile's integrity hash and silently refetches on a
 * mismatch (confirmed the same way) — so exposure is bounded to worktrees
 * already running at mutation time, plus a resumed session, which skips
 * this install step entirely (session-run-setup.ts) and so never gets a
 * chance to self-heal. Auto Harness explicitly supports multiple worktrees
 * running sessions concurrently on one host, so that window is real.
 *
 * `copy`, not `clone-or-copy`: clone/reflink is copy-on-write, so it is
 * just as write-isolated as a plain copy on filesystems that support it,
 * but "an independent copy on every filesystem, unconditionally" is the
 * easier property to defend on a security-motivated pin across the
 * daemon's Linux and macOS hosts, and it removes the platform split
 * entirely — reasoning about one import method instead of "clone here,
 * copy there" is worth more than the throughput `clone-or-copy` would
 * preserve on macOS. Like the three flags above, `package-import-method`
 * is also `.npmrc`-settable, so pinning it on the CLI closes the same
 * checked-out-`.npmrc` override vector: unpinned, a ref's `.npmrc` could
 * force `hardlink` even on a filesystem where `auto` would not otherwise
 * have chosen it.
 *
 * The real cost: `copy` gives up cross-worktree dedup on the filesystems
 * where `auto` was already choosing `hardlink` (Linux/ext4, including the
 * `ubuntu-latest` CI runners) — every worktree's `node_modules` now holds
 * an independent on-disk copy of each installed package instead of sharing
 * one inode, so per-host disk usage scales with worktree count instead of
 * with distinct packages, and each install's linking step (not the
 * network fetch — the store itself stays warm and shared) does more I/O
 * than a hardlink would. That's acceptable here: the number of worktrees
 * concurrently active on one host is small and operator-controlled, not
 * something an untrusted ref can inflate, and there is no scripts/build
 * step downstream whose latency this would compound.
 *
 * What this does *not* close: the daemon's session process and every
 * worktree's install run as the same OS user (D9 — no per-session OS
 * sandboxing), so a session that deliberately wants to corrupt the shared
 * store still can, by writing into `storeDir` directly rather than through
 * a worktree's linked copy. `--package-import-method copy` only removes
 * the *incidental* aliasing path — an in-place mutation of a file that
 * used to be silently shared — plus the `.npmrc`-forced-`hardlink`
 * override. Closing direct same-uid store writes would need the store
 * mounted read-only outside the install step (auto-harness#350's second
 * suggested option), which is out of scope for this fix.
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
    "--package-import-method",
    "copy",
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
