import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { installWorkspaceDependencies, isPnpmWorkspace } from "./dependency-install.ts";
import type { ProcessRunner } from "./executor.ts";

describe("isPnpmWorkspace", () => {
  it("is true when the worktree has a root pnpm-lock.yaml", () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-pnpm-workspace-"));
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(isPnpmWorkspace(cwd)).toBe(true);
  });

  it("is false when the worktree has no lockfile", () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-no-lockfile-"));
    expect(isPnpmWorkspace(cwd)).toBe(false);
  });

  it("is false when the worktree path does not exist", () => {
    expect(isPnpmWorkspace(join(tmpdir(), "auto-harness-missing-worktree-does-not-exist"))).toBe(
      false,
    );
  });
});

describe("installWorkspaceDependencies", () => {
  it("runs a frozen-lockfile install in the worktree with the given environment plus CI=true", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-"));
    mkdirSync(cwd, { recursive: true });
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const chunks: string[] = [];
    const controller = new AbortController();
    const result = await installWorkspaceDependencies(
      runner,
      cwd,
      5_000,
      (c) => chunks.push(c.data),
      controller.signal,
      { PATH: "/usr/bin", HOME: "/home/harness" },
      "linux",
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toMatchObject({
      argv: [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--modules-dir",
        "node_modules",
        "--store-dir",
        join("/home/harness", ".auto-harness-pnpm-store"),
        "--virtual-store-dir",
        "node_modules/.pnpm",
        "--package-import-method",
        "copy",
      ],
      cwd,
      env: { PATH: "/usr/bin", HOME: "/home/harness", CI: "true" },
      timeoutMs: 5_000,
      signal: controller.signal,
    });
  });

  it("runs through cmd.exe on win32, since child_process.spawn with shell:false cannot execute a .cmd shim directly", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-win32-"));
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(
      runner,
      cwd,
      5_000,
      () => undefined,
      undefined,
      { HOME: "/home/harness" },
      "win32",
    );
    expect(seen?.argv).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--modules-dir",
      "node_modules",
      "--store-dir",
      join("/home/harness", ".auto-harness-pnpm-store"),
      "--virtual-store-dir",
      "node_modules/.pnpm",
      "--package-import-method",
      "copy",
    ]);
  });

  it("omits signal from run options when none is provided", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-no-signal-"));
    let seen: Parameters<ProcessRunner["run"]>[0] | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await installWorkspaceDependencies(runner, cwd, 5_000, () => undefined, undefined, {});
    expect(seen?.signal).toBeUndefined();
  });

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
});
