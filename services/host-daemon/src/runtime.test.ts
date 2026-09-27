/* eslint-disable max-lines -- git readiness, workspace-only, and GitHub App assignment share one runtime fixture. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { ensureDaemonReady } from "./runtime.ts";

const runtimeRoot = mkdtempSync(join(tmpdir(), "ah-runtime-unit-"));
const runtimeRepo = join(runtimeRoot, "repo");
const runtimeWorktree = join(runtimeRoot, "wt-1");
const runtimeGitDir = join(runtimeRepo, ".git", "worktrees", "one");
const runtimeWorkspace = join(runtimeRoot, "workspace", "slot");

beforeAll(() => {
  mkdirSync(runtimeRepo);
  mkdirSync(runtimeWorktree);
  mkdirSync(runtimeGitDir, { recursive: true });
  mkdirSync(runtimeWorkspace, { recursive: true });
  writeFileSync(join(runtimeWorktree, ".git"), `gitdir: ${runtimeGitDir}\n`);
  writeFileSync(join(runtimeGitDir, "gitdir"), `${join(runtimeWorktree, ".git")}\n`);
});

afterAll(() => {
  rmSync(runtimeRoot, { recursive: true, force: true });
});

const config = parseDaemonConfig({
  hostId: "a1",
  commandProfiles: { echo: { argv: ["echo"], appendPrompt: true } },
  repositories: [
    {
      id: "repo-1",
      path: runtimeRepo,
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", name: "wt-1", path: runtimeWorktree, labels: [] }],
    },
  ],
});

describe("runtime helpers", () => {
  it("ensureDaemonReady uses git client", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv.join(" "));
        if (opts.argv.includes("--version")) {
          opts.onChunk({ stream: "stdout", data: "git version 2.36.0\n" });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (opts.argv.includes("rev-parse")) {
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (opts.argv.includes("list")) {
          opts.onChunk({
            stream: "stdout",
            data: `worktree ${runtimeWorktree}\n`,
          });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await ensureDaemonReady(config, runner);
    expect(calls.some((c) => c.includes("rev-parse"))).toBe(true);
  });

  it("returns an unready runtime report without initializing worktrees", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv.join(" "));
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };

    await expect(ensureDaemonReady(config, runner)).resolves.toMatchObject({
      gitReady: false,
      gitReadinessReason: "git_unavailable",
    });
    expect(calls).toEqual(["git --version"]);
  });

  it("validates a workspace-only host when Git is unavailable", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      async run(options) {
        calls.push(options.argv.join(" "));
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    const workspaceOnly = parseDaemonConfig({
      hostId: "workspace-only",
      allowedRoots: [runtimeRoot],
      repositories: [],
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "slot", name: "slot", path: runtimeWorkspace }],
        },
      ],
    });

    await expect(ensureDaemonReady(workspaceOnly, runner)).resolves.toMatchObject({
      gitReady: false,
      gitReadinessReason: "git_unavailable",
    });
    expect(calls).toEqual(["git --version"]);
  });
});
