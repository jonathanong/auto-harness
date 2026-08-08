import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";
import { scripted } from "./git-test-helpers.ts";

describe("createGitClient ensureWorktree", () => {
  it("maps null exit codes to 1", async () => {
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv.includes("rev-parse") && opts.argv.includes("HEAD")) {
          return { exitCode: null, timedOut: false, signal: "SIGTERM" };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await expect(createGitClient(runner).revParse("/repo", "HEAD")).rejects.toThrow(/rev-parse/);
  });

  it("ensureRepo rejects non-repos", async () => {
    const git = createGitClient(
      scripted([{ match: ["rev-parse", "--is-inside-work-tree"], exitCode: 128 }]),
    );
    await expect(git.ensureRepo("/x")).rejects.toThrow(/Not a git repository/);
  });

  it("ensureWorktree skips when listed", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--is-inside-work-tree"],
          exitCode: 0,
          stdout: "true\n",
        },
        {
          match: ["worktree", "list", "--porcelain"],
          exitCode: 0,
          stdout: "worktree /repo/wt-1\n",
        },
      ]),
    );
    await expect(
      git.ensureWorktree({
        repoPath: "/repo",
        worktreePath: "/repo/wt-1",
        branch: "main",
      }),
    ).resolves.toBeUndefined();
  });

  it("ensureWorktree adds detached at branch tip", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--is-inside-work-tree"],
          exitCode: 0,
          stdout: "true\n",
        },
        { match: ["worktree", "list", "--porcelain"], exitCode: 0, stdout: "" },
        {
          match: ["rev-parse", "--verify", "main"],
          exitCode: 0,
          stdout: "abc\n",
        },
        {
          match: ["worktree", "add", "--detach", "/repo/wt-1", "abc"],
          exitCode: 0,
        },
      ]),
    );
    await git.ensureWorktree({
      repoPath: "/repo",
      worktreePath: "/repo/wt-1",
      branch: "main",
    });
  });

  it("ensureWorktree falls back to HEAD tip", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--is-inside-work-tree"],
          exitCode: 0,
          stdout: "true\n",
        },
        { match: ["worktree", "list", "--porcelain"], exitCode: 0, stdout: "" },
        { match: ["rev-parse", "--verify", "missing"], exitCode: 1, stderr: "no" },
        {
          match: ["rev-parse", "--verify", "HEAD"],
          exitCode: 0,
          stdout: "def\n",
        },
        {
          match: ["worktree", "add", "--detach", "/repo/wt-1", "def"],
          exitCode: 0,
        },
      ]),
    );
    await git.ensureWorktree({
      repoPath: "/repo",
      worktreePath: "/repo/wt-1",
      branch: "missing",
    });
  });

  it("ensureWorktree fails when tip and add fail", async () => {
    await expect(
      createGitClient(
        scripted([
          {
            match: ["rev-parse", "--is-inside-work-tree"],
            exitCode: 0,
            stdout: "true\n",
          },
          {
            match: ["worktree", "list", "--porcelain"],
            exitCode: 0,
            stdout: "",
          },
          { match: ["rev-parse", "--verify", "main"], exitCode: 1, stderr: "x" },
          { match: ["rev-parse", "--verify", "HEAD"], exitCode: 1, stderr: "y" },
        ]),
      ).ensureWorktree({
        repoPath: "/repo",
        worktreePath: "/repo/wt-1",
        branch: "main",
      }),
    ).rejects.toThrow(/Failed to resolve tip/);
  });

  it("ensureWorktree fails when worktree add fails", async () => {
    await expect(
      createGitClient(
        scripted([
          {
            match: ["rev-parse", "--is-inside-work-tree"],
            exitCode: 0,
            stdout: "true\n",
          },
          { match: ["worktree", "list", "--porcelain"], exitCode: 0, stdout: "" },
          {
            match: ["rev-parse", "--verify", "main"],
            exitCode: 0,
            stdout: "abc\n",
          },
          {
            match: ["worktree", "add", "--detach", "/repo/wt-1", "abc"],
            exitCode: 1,
            stderr: "locked",
          },
        ]),
      ).ensureWorktree({
        repoPath: "/repo",
        worktreePath: "/repo/wt-1",
        branch: "main",
      }),
    ).rejects.toThrow(/Failed to create worktree/);
  });
});
