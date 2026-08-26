import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { OutputChunk, ProcessResult, ProcessRunner } from "./executor.ts";

/** A pnpm workspace worktree always has a committed root lockfile. */
export function isPnpmWorkspace(cwd: string): boolean {
  return existsSync(join(cwd, "pnpm-lock.yaml"));
}

const PACKAGE_IMPORT_METHOD = "copy";
const IMPORT_METHOD_MARKER = join("node_modules", ".auto-harness-package-import-method");

function readImportMethodMarker(markerPath: string): string | undefined {
  try {
    // Never follow a symlink: an untrusted checked-out ref can commit
    // node_modules/.auto-harness-package-import-method as a symlink to any
    // other file this same-uid daemon can read (jonathanong/auto-harness#350
    // Codex review). Treating a symlinked marker as absent, rather than
    // reading through it, means it can only ever cause an extra --force —
    // never a wrongly-skipped one.
    if (lstatSync(markerPath).isSymbolicLink()) return undefined;
    return readFileSync(markerPath, "utf8").trim();
  } catch {
    return undefined;
  }
}

function writeImportMethodMarker(markerPath: string): void {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    // Remove whatever already exists at markerPath — including a symlink —
    // before writing, so this always creates a fresh regular file instead
    // of following a symlink an untrusted ref committed there and
    // truncating whatever it points to (same #350 Codex finding as above;
    // confirmed the pinned pnpm preserves a committed marker symlink
    // through even a forced install, so this write is the only backstop).
    // rmSync on a symlink removes the link itself, per POSIX unlink
    // semantics, not whatever it points to.
    rmSync(markerPath, { force: true, recursive: true });
    writeFileSync(markerPath, PACKAGE_IMPORT_METHOD);
  } catch {
    // Best-effort: a write failure here only costs a redundant --force on the
    // next install (see the marker paragraph below), not a correctness bug.
  }
}

/**
 * Invalidate a worktree's import-method marker before a setup script runs.
 * A setup script is arbitrary, admin-configured code (`session-run-setup.ts`)
 * that can run its own `pnpm install` without this module's pinned
 * `--package-import-method`; if the checked-out ref's lockfile changed, that
 * install would resolve and link the new packages under pnpm's `auto`
 * default (`hardlink` on Linux — the original #350 bug) while this
 * worktree's marker still claims `copy` from a prior successful install
 * here. Left alone, the next `installWorkspaceDependencies` call would trust
 * that stale claim and skip `--force` (jonathanong/auto-harness#350 Codex
 * review). Deleting the marker first means that next call always forces a
 * fresh relink instead of trusting a claim this module has no way to verify
 * a setup script honored.
 */
export function invalidateImportMethodMarker(cwd: string): void {
  try {
    rmSync(join(cwd, IMPORT_METHOD_MARKER), { force: true, recursive: true });
  } catch {
    // Best-effort: see writeImportMethodMarker.
  }
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
 *
 * Pinning the flag going forward does not retroactively fix a worktree
 * whose `node_modules` was already materialized under a different import
 * method (every worktree that existed before this fix deployed, since
 * `hardlink` was pnpm's `auto` default here). Confirmed empirically against
 * pnpm@10.28.2: rerunning `--frozen-lockfile` against an unchanged lockfile
 * hits pnpm's own fast path ("Already up to date") and skips revisiting
 * already-linked files entirely, regardless of the requested import
 * method — the file kept the exact same inode before and after switching
 * `hardlink` to `copy` with nothing else different. `IMPORT_METHOD_MARKER`
 * records which import method most recently completed a successful install
 * in this worktree; when it is missing (this worktree has `node_modules`
 * from before this fix, or from an interrupted install) or stale (a future
 * change to `PACKAGE_IMPORT_METHOD`), that one install additionally passes
 * `--force`, which does revisit and relink every package — confirmed the
 * same way, against both a single-package repro and this repo's own
 * multi-package workspace (confirming `--force` also preserves the
 * per-package `link:` topology from the `modules-dir`/`virtual-store-dir`
 * paragraph above, not just single-package linking). Confirmed to relink
 * already-resolved packages from the already-warm store (`reused`, not
 * `downloaded`) rather than refetch them — but not a strict "no network"
 * guarantee: a lockfile carrying platform-specific optional dependencies
 * (build tooling that ships a native binary per OS/arch, e.g. `rollup`,
 * `esbuild`) can have entries this worktree's store never needed to fetch
 * before, and `--force` does fetch those from the registry. Confirmed those
 * extra fetches only populate the shared store and are never linked into
 * any package's `node_modules` — this worktree's own on-disk footprint and
 * resolution are unaffected — so the real cost is a one-time, bounded
 * amount of extra network I/O on the worktree's first post-deploy install,
 * not a recurring one. Later installs in that worktree go back to the cheap
 * fast path once the marker is rewritten after a successful install; a
 * failed install leaves the marker untouched, so the next attempt still
 * forces. A resumed session skips this install step entirely (see the
 * `copy` paragraph above), so a worktree whose sessions are only ever
 * resumed — never freshly run — stays on its old import method until a
 * fresh run finally forces the migration; `IMPORT_METHOD_MARKER` is not
 * itself the security boundary here, only a cache of the last install's
 * outcome; like the store itself, it lives under the same same-uid
 * limitation the "What this does *not* close" paragraph above already
 * concedes — a session could forge it to suppress its own worktree's next
 * `--force`, but that session could already reach the same "stay on a
 * mutable, potentially-aliased `node_modules`" outcome more directly, by
 * writing into `storeDir` itself.
 *
 * The marker path is a fixed, well-known name inside a worktree an
 * untrusted checked-out ref controls, which is a stronger threat than a
 * session merely forging its *contents*: a ref can commit
 * `IMPORT_METHOD_MARKER` as a symlink to any other file this same-uid
 * daemon process can write, and `writeFileSync`'s default behavior follows
 * symlinks — so the write after a successful install, not just the read
 * before one, was reachable before the provider sandbox for that session
 * even starts (jonathanong/auto-harness#350 Codex review; reproduced
 * against the pinned pnpm — a forced relink still preserves a committed
 * marker symlink rather than replacing it). `readImportMethodMarker` and
 * `writeImportMethodMarker` both `lstat`/unlink rather than follow: a
 * symlinked marker reads as absent (only ever costs an extra `--force`,
 * never wrongly skips one), and a write always `rmSync`s whatever is at
 * the path first, so `writeFileSync` only ever creates a fresh regular
 * file rather than truncating a symlink's target.
 *
 * `IMPORT_METHOD_MARKER` also assumes the install this function ran is the
 * only thing that could have touched `node_modules` since the marker was
 * last written — untrue when a worktree has a configured setup script.
 * `session-run-setup.ts` runs setup scripts *before* calling this function,
 * and a setup script is arbitrary admin-configured code that can invoke its
 * own unpinned `pnpm install`; if the checked-out ref's lockfile changed,
 * that install resolves and links the new packages under pnpm's `auto`
 * default while this worktree's marker still claims `copy` from a prior
 * install here, so this function would wrongly trust the stale marker and
 * skip `--force` even though the setup script may have just re-aliased
 * those packages (jonathanong/auto-harness#350 Codex review). `session-run-
 * setup.ts` calls the exported `invalidateImportMethodMarker` before
 * running any setup script, so this function's next call always forces a
 * relink whenever a setup script ran — scoped to that case specifically,
 * rather than forcing every install, to keep the throughput benefit above
 * for the more common case of no setup script.
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
  const markerPath = join(cwd, IMPORT_METHOD_MARKER);
  const needsForceRelink =
    existsSync(join(cwd, "node_modules")) &&
    readImportMethodMarker(markerPath) !== PACKAGE_IMPORT_METHOD;
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
    PACKAGE_IMPORT_METHOD,
    ...(needsForceRelink ? ["--force"] : []),
  ];
  const result = await runner.run({
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
  if (result.exitCode === 0) {
    writeImportMethodMarker(markerPath);
  }
  return result;
}
