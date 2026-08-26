import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  installWorkspaceDependencies,
  invalidateImportMethodMarker,
} from "./dependency-install.ts";
import type { ProcessRunner } from "./executor.ts";

describe("installWorkspaceDependencies import-method marker (#350 migration)", () => {
  it("writes an import-method marker after a successful install in a fresh worktree", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-marker-fresh-"));
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(
      readFileSync(join(cwd, "node_modules", ".auto-harness-package-import-method"), "utf8"),
    ).toBe("copy");
  });

  it("does not throw when writing the import-method marker fails after a successful install", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-marker-write-fails-"));
    // node_modules exists as a plain file rather than a directory, so the
    // marker write's mkdirSync(dirname(markerPath)) fails with ENOTDIR.
    writeFileSync(join(cwd, "node_modules"), "not a directory");
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await installWorkspaceDependencies(
      runner,
      cwd,
      5_000,
      () => undefined,
      undefined,
      {},
    );
    expect(result.exitCode).toBe(0);
  });

  it("does not pass --force for a fresh worktree that has no node_modules yet", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-no-force-fresh-"));
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(seen?.argv).not.toContain("--force");
  });

  it("does not pass --force when node_modules already carries a matching import-method marker", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-marker-match-"));
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", ".auto-harness-package-import-method"), "copy");
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(seen?.argv).not.toContain("--force");
  });

  it("passes --force when node_modules exists with no import-method marker (a worktree from before this fix)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-force-missing-marker-"));
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(seen?.argv).toContain("--force");
  });

  it("passes --force when node_modules carries a stale import-method marker", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-force-stale-marker-"));
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", ".auto-harness-package-import-method"), "hardlink");
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(seen?.argv).toContain("--force");
  });

  it("leaves the import-method marker untouched when the install fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-marker-on-failure-"));
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(existsSync(join(cwd, "node_modules", ".auto-harness-package-import-method"))).toBe(
      false,
    );
  });

  it("passes --force when the import-method marker is a symlink, even one pointing at a matching value (#350 hardening)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-force-symlink-marker-"));
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    const external = join(cwd, "outside-marker-target");
    writeFileSync(external, "copy");
    symlinkSync(external, join(cwd, "node_modules", ".auto-harness-package-import-method"));
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(seen?.argv).toContain("--force");
  });

  it("replaces a symlinked import-method marker with a fresh regular file instead of writing through it (#350 hardening)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-write-symlink-marker-"));
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    const external = join(cwd, "outside-marker-target");
    writeFileSync(external, "sensitive external content");
    const markerPath = join(cwd, "node_modules", ".auto-harness-package-import-method");
    symlinkSync(external, markerPath);
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(lstatSync(markerPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(markerPath, "utf8")).toBe("copy");
    expect(readFileSync(external, "utf8")).toBe("sensitive external content");
  });

  it("invalidateImportMethodMarker removes an existing marker", () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-invalidate-marker-"));
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    const markerPath = join(cwd, "node_modules", ".auto-harness-package-import-method");
    writeFileSync(markerPath, "copy");
    invalidateImportMethodMarker(cwd);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("invalidateImportMethodMarker does not throw when no marker or node_modules exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-invalidate-marker-missing-"));
    expect(() => invalidateImportMethodMarker(cwd)).not.toThrow();
  });

  it("invalidateImportMethodMarker does not throw when node_modules is unreadable", () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-invalidate-marker-unreadable-"));
    const nodeModules = join(cwd, "node_modules");
    mkdirSync(nodeModules);
    writeFileSync(join(nodeModules, ".auto-harness-package-import-method"), "copy");
    chmodSync(nodeModules, 0o000);
    try {
      expect(() => invalidateImportMethodMarker(cwd)).not.toThrow();
    } finally {
      chmodSync(nodeModules, 0o755);
    }
  });
});
