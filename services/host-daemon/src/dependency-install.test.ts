import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
