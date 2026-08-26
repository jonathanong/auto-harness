import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installWorkspaceDependencies } from "../services/host-daemon/src/dependency-install.ts";
import type { ProcessRunner } from "../services/host-daemon/src/executor.ts";
import { SpawnProcessRunner } from "../services/host-daemon/src/executor.ts";

/**
 * Real-pnpm proof for jonathanong/auto-harness#350: two worktrees sharing one
 * daemon `HOME` (and therefore one `--store-dir`) must not be able to alias
 * each other's files through the shared content-addressable store. See the
 * `--package-import-method copy` rationale in dependency-install.ts and
 * docs/host-daemon.md.
 */

const PKG_PATH = "node_modules/.pnpm/is-number@7.0.0/node_modules/is-number/index.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function manifest(name: string): string {
  return JSON.stringify({
    name,
    version: "1.0.0",
    private: true,
    dependencies: { "is-number": "7.0.0" },
  });
}

async function seedLockfile(
  rootDir: string,
  storeDir: string,
  runner: ProcessRunner,
  homeDir: string,
): Promise<Buffer> {
  // installWorkspaceDependencies always runs --frozen-lockfile, so a real
  // lockfile has to exist up front, same as a committed ref would have.
  const seed = join(rootDir, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "package.json"), manifest("store-isolation-seed"), { flag: "wx" });
  const seedResult = await runner.run({
    argv: ["pnpm", "install", "--lockfile-only", "--store-dir", storeDir],
    cwd: seed,
    env: { ...process.env, HOME: homeDir },
    timeoutMs: 60_000,
    onChunk: () => undefined,
  });
  expect(seedResult.exitCode).toBe(0);
  return readFileSync(join(seed, "pnpm-lock.yaml"));
}

function makeWorktree(rootDir: string, lockfile: Buffer, name: string): string {
  const cwd = join(rootDir, name);
  mkdirSync(cwd);
  writeFileSync(join(cwd, "package.json"), manifest(name), { flag: "wx" });
  writeFileSync(join(cwd, "pnpm-lock.yaml"), lockfile);
  return cwd;
}

describe("installWorkspaceDependencies store isolation (#350)", () => {
  it(
    "keeps one worktree's mutated dependency file from aliasing another worktree sharing the store",
    { timeout: 120_000 },
    async () => {
      root = mkdtempSync(join(tmpdir(), "ah-store-isolation-"));
      const homeDir = join(root, "home");
      mkdirSync(homeDir);
      const storeDir = join(homeDir, ".auto-harness-pnpm-store");
      const runner = new SpawnProcessRunner();

      const lockfile = await seedLockfile(root, storeDir, runner, homeDir);
      const install = (cwd: string) =>
        installWorkspaceDependencies(runner, cwd, 60_000, () => undefined, undefined, {
          ...process.env,
          HOME: homeDir,
        });

      const sessionA = makeWorktree(root, lockfile, "session-a");
      const sessionB = makeWorktree(root, lockfile, "session-b");

      const resultA = await install(sessionA);
      expect(resultA.exitCode).toBe(0);
      const resultB = await install(sessionB);
      expect(resultB.exitCode).toBe(0);

      const fileA = join(sessionA, PKG_PATH);
      const fileB = join(sessionB, PKG_PATH);
      expect(existsSync(fileA)).toBe(true);
      expect(existsSync(fileB)).toBe(true);

      // `--package-import-method copy` means each worktree's linked copy is an
      // independent file, not the same inode aliased into the shared store.
      expect(statSync(fileA).ino).not.toBe(statSync(fileB).ino);

      // Simulate a session mutating a dependency file in place (a debugging
      // patch, a corrupted write) inside its own worktree only.
      writeFileSync(fileA, `${readFileSync(fileA, "utf8")}\nexports.POISONED = true;\n`);
      expect(readFileSync(fileB, "utf8")).not.toContain("POISONED");

      // A third worktree installing after the mutation must not inherit it
      // either, whether via a poisoned store entry or a stale cached link.
      const sessionC = makeWorktree(root, lockfile, "session-c");
      const resultC = await install(sessionC);
      expect(resultC.exitCode).toBe(0);
      expect(readFileSync(join(sessionC, PKG_PATH), "utf8")).not.toContain("POISONED");
    },
  );

  it(
    "migrates a worktree whose node_modules predates this fix (installed under hardlink) on its next install",
    { timeout: 120_000 },
    async () => {
      root = mkdtempSync(join(tmpdir(), "ah-store-isolation-migrate-"));
      const homeDir = join(root, "home");
      mkdirSync(homeDir);
      const storeDir = join(homeDir, ".auto-harness-pnpm-store");
      const runner = new SpawnProcessRunner();

      const lockfile = await seedLockfile(root, storeDir, runner, homeDir);
      const install = (cwd: string) =>
        installWorkspaceDependencies(runner, cwd, 60_000, () => undefined, undefined, {
          ...process.env,
          HOME: homeDir,
        });

      // Simulate a worktree that was already installed by a daemon predating
      // this fix: same pinned flags, but hardlink, and no migration marker.
      const legacy = makeWorktree(root, lockfile, "session-legacy");
      const legacyInstall = await runner.run({
        argv: [
          "pnpm",
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
          "hardlink",
        ],
        cwd: legacy,
        env: { ...process.env, HOME: homeDir, CI: "true" },
        timeoutMs: 60_000,
        onChunk: () => undefined,
      });
      expect(legacyInstall.exitCode).toBe(0);
      const legacyFile = join(legacy, PKG_PATH);
      const inodeBeforeMigration = statSync(legacyFile).ino;

      // A second, already-copy-isolated worktree to prove non-aliasing below.
      const sessionB = makeWorktree(root, lockfile, "session-b");
      const resultB = await install(sessionB);
      expect(resultB.exitCode).toBe(0);

      // installWorkspaceDependencies sees node_modules with no import-method
      // marker and adds --force, relinking the legacy worktree onto an
      // independent copy instead of leaving its old hardlink untouched.
      const migrateResult = await install(legacy);
      expect(migrateResult.exitCode).toBe(0);
      expect(statSync(legacyFile).ino).not.toBe(inodeBeforeMigration);

      writeFileSync(legacyFile, `${readFileSync(legacyFile, "utf8")}\nexports.POISONED = true;\n`);
      expect(readFileSync(join(sessionB, PKG_PATH), "utf8")).not.toContain("POISONED");
    },
  );
});
