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

      // installWorkspaceDependencies always runs --frozen-lockfile, so a real
      // lockfile has to exist up front, same as a committed ref would have.
      // Generate one real lockfile once and reuse it for every worktree below.
      const seed = join(root, "seed");
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
      const lockfile = readFileSync(join(seed, "pnpm-lock.yaml"));

      function worktree(name: string): string {
        const cwd = join(root!, name);
        mkdirSync(cwd);
        writeFileSync(join(cwd, "package.json"), manifest(name), { flag: "wx" });
        writeFileSync(join(cwd, "pnpm-lock.yaml"), lockfile);
        return cwd;
      }

      const sessionA = worktree("session-a");
      const sessionB = worktree("session-b");
      const install = (cwd: string) =>
        installWorkspaceDependencies(runner, cwd, 60_000, () => undefined, undefined, {
          ...process.env,
          HOME: homeDir,
        });

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
      const sessionC = worktree("session-c");
      const resultC = await install(sessionC);
      expect(resultC.exitCode).toBe(0);
      expect(readFileSync(join(sessionC, PKG_PATH), "utf8")).not.toContain("POISONED");
    },
  );
});
