import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installWorkspaceDependencies } from "../services/host-daemon/src/dependency-install.ts";
import type { ProcessRunner } from "../services/host-daemon/src/executor.ts";
import { SpawnProcessRunner } from "../services/host-daemon/src/executor.ts";

/**
 * Real-pnpm proof for jonathanong/auto-harness#350's marker-symlink Codex
 * finding: a checked-out ref committing `IMPORT_METHOD_MARKER` as a symlink
 * must not let the daemon's own marker write clobber whatever that symlink
 * points to. Codex reproduced the original bug against this exact pinned
 * pnpm — a forced relink still preserved the committed symlink rather than
 * replacing it — so this proves the fix against real pnpm, not just a
 * mocked `ProcessRunner`.
 */

const MARKER = join("node_modules", ".auto-harness-package-import-method");

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("installWorkspaceDependencies import-method marker symlink hardening (#350)", () => {
  it(
    "replaces a committed marker symlink with a fresh regular file and leaves the symlink's target untouched",
    { timeout: 120_000 },
    async () => {
      root = mkdtempSync(join(tmpdir(), "ah-marker-symlink-"));
      const homeDir = join(root, "home");
      mkdirSync(homeDir);
      const storeDir = join(homeDir, ".auto-harness-pnpm-store");
      const runner: ProcessRunner = new SpawnProcessRunner();

      const cwd = join(root, "worktree");
      mkdirSync(cwd);
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({
          name: "marker-symlink-worktree",
          version: "1.0.0",
          private: true,
          dependencies: { "is-number": "7.0.0" },
        }),
      );
      const seedResult = await runner.run({
        argv: ["pnpm", "install", "--lockfile-only", "--store-dir", storeDir],
        cwd,
        env: { ...process.env, HOME: homeDir },
        timeoutMs: 60_000,
        onChunk: () => undefined,
      });
      expect(seedResult.exitCode).toBe(0);

      mkdirSync(join(cwd, "node_modules"), { recursive: true });
      const outsideTarget = join(root, "outside-marker-target");
      writeFileSync(outsideTarget, "sensitive external content");
      const markerPath = join(cwd, MARKER);
      symlinkSync(outsideTarget, markerPath);

      const install = await installWorkspaceDependencies(
        runner,
        cwd,
        60_000,
        () => undefined,
        undefined,
        { ...process.env, HOME: homeDir },
      );
      expect(install.exitCode).toBe(0);

      expect(lstatSync(markerPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(markerPath, "utf8")).toBe("copy");
      expect(readFileSync(outsideTarget, "utf8")).toBe("sensitive external content");
    },
  );
});
