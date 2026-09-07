/* eslint-disable max-lines -- operation-marker and index-chunk failure cases share one runner. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProcessRunner, RunProcessOptions } from "./executor.ts";
import { resetPriorWorktreeState } from "./git-worktree-reset.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function fixture(): { cwd: string; gitDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ah-worktree-reset-"));
  roots.push(root);
  const cwd = join(root, "cwd");
  const gitDir = join(root, "git-dir");
  mkdirSync(cwd);
  mkdirSync(gitDir);
  return { cwd, gitDir };
}

function createMarker(gitDir: string, name: string): void {
  const path = join(gitDir, name);
  if (name.startsWith("rebase-") || name === "sequencer") mkdirSync(path);
  else writeFileSync(path, "state");
}

function processResult() {
  return { exitCode: 0, timedOut: false, signal: null } as const;
}

describe("resetPriorWorktreeState", () => {
  it("aborts interrupted operations and clears index flags in bounded chunks", async () => {
    const { cwd, gitDir } = fixture();
    for (const marker of [
      "rebase-merge",
      "rebase-apply",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "sequencer",
    ]) {
      createMarker(gitDir, marker);
    }
    const paths = Array.from({ length: 129 }, (_, index) => `path-${index}`);
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(options) {
        const argv = options.argv.slice(1);
        calls.push(argv);
        if (argv[0] === "rebase") {
          const marker =
            calls.filter((call) => call[0] === "rebase").length === 1
              ? "rebase-merge"
              : "rebase-apply";
          rmSync(join(gitDir, marker), { recursive: true });
        } else if (argv[0] === "merge") rmSync(join(gitDir, "MERGE_HEAD"));
        else if (argv[0] === "cherry-pick") {
          rmSync(join(gitDir, "CHERRY_PICK_HEAD"));
          rmSync(join(gitDir, "sequencer"), { recursive: true });
        } else if (argv[0] === "revert") rmSync(join(gitDir, "REVERT_HEAD"));
        else if (argv[0] === "ls-files") {
          options.onChunk({ stream: "stdout", data: `${paths.join("\0")}\0` });
        }
        return processResult();
      },
    };

    await resetPriorWorktreeState(runner, cwd, gitDir);

    expect(calls.filter((call) => call[0] === "update-index")).toHaveLength(4);
    expect(calls.some((call) => call.join(" ") === "cherry-pick --abort")).toBe(true);
  });

  it("falls back to am --abort for a rebase-apply marker", async () => {
    const { cwd, gitDir } = fixture();
    createMarker(gitDir, "rebase-apply");
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(options) {
        const argv = options.argv.slice(1);
        calls.push(argv);
        if (argv[0] === "am") rmSync(join(gitDir, "rebase-apply"), { recursive: true });
        return processResult();
      },
    };

    await resetPriorWorktreeState(runner, cwd, gitDir);

    expect(calls.slice(0, 2)).toEqual([
      ["rebase", "--abort"],
      ["am", "--abort"],
    ]);
  });

  it("fails closed when operation metadata remains or cannot be inspected", async () => {
    const { cwd, gitDir } = fixture();
    createMarker(gitDir, "MERGE_HEAD");
    const runner: ProcessRunner = {
      async run() {
        return processResult();
      },
    };
    await expect(resetPriorWorktreeState(runner, cwd, gitDir)).rejects.toThrow(
      "Failed to clear interrupted Git operation",
    );
    await expect(resetPriorWorktreeState(runner, cwd, "\0")).rejects.toThrow();
  });

  it("reports sanitized tracked-file inspection and update failures", async () => {
    const { cwd, gitDir } = fixture();
    const failingList: ProcessRunner = {
      async run(options) {
        options.onChunk({ stream: "stderr", data: "?X-Amz-Signature=LISTSECRET" });
        return { ...processResult(), exitCode: 1 };
      },
    };
    await expect(resetPriorWorktreeState(failingList, cwd, gitDir)).rejects.toThrow(
      "Failed to inspect tracked files: ?X-Amz-Signature=[redacted]",
    );

    const failingUpdate: ProcessRunner = {
      async run(options: RunProcessOptions) {
        if (options.argv[1] === "ls-files") {
          options.onChunk({ stream: "stdout", data: "tracked\0" });
          return processResult();
        }
        options.onChunk({ stream: "stderr", data: "token=UPDATESECRET" });
        return { ...processResult(), exitCode: 1 };
      },
    };
    await expect(resetPriorWorktreeState(failingUpdate, cwd, gitDir)).rejects.toThrow(
      "Failed to clear tracked-file index flags: token=[redacted]",
    );
  });

  it("chunks an individually long tracked path and accepts output without a trailing NUL", async () => {
    const { cwd, gitDir } = fixture();
    const updates: string[][] = [];
    const runner: ProcessRunner = {
      async run(options) {
        if (options.argv[1] === "ls-files") {
          options.onChunk({ stream: "stdout", data: `${"x".repeat(8_001)}\0short` });
        } else updates.push(options.argv);
        return processResult();
      },
    };

    await resetPriorWorktreeState(runner, cwd, gitDir);

    expect(updates).toHaveLength(4);
  });
});
