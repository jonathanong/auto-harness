import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.js";
import { createGitClient } from "./git.js";
// ProcessRunner used for null exitCode coverage

function scripted(
  responses: Array<{
    match: string[];
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }>,
): ProcessRunner {
  return {
    async run(opts) {
      const key = opts.argv.slice(1).join(" ");
      const hit = responses.find((r) =>
        r.match.every((m, i) => opts.argv[i + 1] === m || m === "*"),
      );
      if (!hit) {
        throw new Error(`unexpected git ${key}`);
      }
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
        { match: ["rev-parse", "--is-inside-work-tree"], exitCode: 0, stdout: "true\n" },
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

  it("ensureWorktree adds when missing and falls back to detach", async () => {
    const git = createGitClient(
      scripted([
        { match: ["rev-parse", "--is-inside-work-tree"], exitCode: 0, stdout: "true\n" },
        { match: ["worktree", "list", "--porcelain"], exitCode: 0, stdout: "" },
        {
          match: ["worktree", "add", "-B", "main", "/repo/wt-1", "main"],
          exitCode: 1,
          stderr: "nope",
        },
        {
          match: ["worktree", "add", "--detach", "/repo/wt-1", "HEAD"],
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

  it("ensureWorktree success path on first add", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--is-inside-work-tree"],
          exitCode: 0,
          stdout: "true\n",
        },
        { match: ["worktree", "list", "--porcelain"], exitCode: 0, stdout: "" },
        {
          match: ["worktree", "add", "-B", "main", "/repo/wt-1", "main"],
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

  it("checkoutRef fails clearly", async () => {
    const git = createGitClient(
      scripted([
        { match: ["fetch", "--all", "--tags"], exitCode: 1, stderr: "offline" },
        { match: ["checkout", "--force", "bad"], exitCode: 1, stderr: "missing" },
      ]),
    );
    await expect(git.checkoutRef({ cwd: "/repo", ref: "bad" })).rejects.toThrow(
      /Failed to checkout/,
    );
  });

  it("revParse returns hash", async () => {
    const git = createGitClient(
      scripted([{ match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123\n" }]),
    );
    await expect(git.revParse("/repo", "HEAD")).resolves.toBe("abc123");
  });

  it("revParse and ensureWorktree fail hard", async () => {
    await expect(
      createGitClient(
        scripted([{ match: ["rev-parse", "HEAD"], exitCode: 1, stderr: "e" }]),
      ).revParse("/repo", "HEAD"),
    ).rejects.toThrow(/rev-parse/);

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
            match: ["worktree", "add", "-B", "main", "/repo/wt-1", "main"],
            exitCode: 1,
            stderr: "",
          },
          {
            match: ["worktree", "add", "--detach", "/repo/wt-1", "HEAD"],
            exitCode: 1,
            stderr: "b",
          },
        ]),
      ).ensureWorktree({
        repoPath: "/repo",
        worktreePath: "/repo/wt-1",
        branch: "main",
      }),
    ).rejects.toThrow(/Failed to create worktree/);
  });

  it("checkoutRef succeeds", async () => {
    const git = createGitClient(
      scripted([
        { match: ["fetch", "--all", "--tags"], exitCode: 0 },
        { match: ["checkout", "--force", "main"], exitCode: 0 },
      ]),
    );
    await git.checkoutRef({ cwd: "/repo", ref: "main" });
  });
});
