import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.js";
import { createGitClient } from "./git.js";

function scripted(
  responses: Array<{
    match: string[];
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }>,
): ProcessRunner {
  // Consume matching entries in order so the same argv can return different
  // results on successive calls (e.g. rev-parse fails then succeeds after fetch).
  const queue = [...responses];
  return {
    async run(opts) {
      const idx = queue.findIndex((r) =>
        r.match.every((m, i) => opts.argv[i + 1] === m || m === "*"),
      );
      if (idx < 0) {
        throw new Error(`unexpected git ${opts.argv.slice(1).join(" ")}`);
      }
      const [hit] = queue.splice(idx, 1);
      if (hit.stdout) {
        opts.onChunk({ stream: "stdout", data: hit.stdout });
      }
      if (hit.stderr) {
        opts.onChunk({ stream: "stderr", data: hit.stderr });
      }
      return { exitCode: hit.exitCode, timedOut: false, signal: null };
    },
  };
}

describe("createGitClient", () => {
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

  it("checkoutRef detaches at resolved sha", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--verify", "main"],
          exitCode: 0,
          stdout: "abc123\n",
        },
        {
          match: ["switch", "--detach", "abc123"],
          exitCode: 0,
        },
      ]),
    );
    await git.checkoutRef({ cwd: "/repo/wt", ref: "main" });
  });

  it("checkoutRef fetches then falls back to checkout --detach", async () => {
    const git = createGitClient(
      scripted([
        { match: ["rev-parse", "--verify", "main"], exitCode: 1, stderr: "no" },
        { match: ["fetch", "--all", "--tags"], exitCode: 0 },
        {
          match: ["rev-parse", "--verify", "main"],
          exitCode: 0,
          stdout: "abc\n",
        },
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "old git" },
        { match: ["checkout", "--detach", "abc"], exitCode: 0 },
      ]),
    );
    await git.checkoutRef({ cwd: "/repo/wt", ref: "main" });
  });

  it("checkoutRef fails when ref cannot be resolved", async () => {
    await expect(
      createGitClient(
        scripted([
          { match: ["rev-parse", "--verify", "bad"], exitCode: 1, stderr: "e" },
          { match: ["fetch", "--all", "--tags"], exitCode: 0 },
          { match: ["rev-parse", "--verify", "bad"], exitCode: 1, stderr: "e2" },
        ]),
      ).checkoutRef({ cwd: "/repo", ref: "bad" }),
    ).rejects.toThrow(/Failed to resolve ref/);
  });

  it("checkoutRef fails when switch and checkout both fail", async () => {
    await expect(
      createGitClient(
        scripted([
          {
            match: ["rev-parse", "--verify", "main"],
            exitCode: 0,
            stdout: "abc\n",
          },
          { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "s" },
          { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "c" },
        ]),
      ).checkoutRef({ cwd: "/repo", ref: "main" }),
    ).rejects.toThrow(/Failed to checkout ref/);
  });

  it("revParse returns hash", async () => {
    const git = createGitClient(
      scripted([{ match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123\n" }]),
    );
    await expect(git.revParse("/repo", "HEAD")).resolves.toBe("abc123");
  });
});
