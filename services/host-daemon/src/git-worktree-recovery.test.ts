import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";
import { WORKTREE_ADD_TIMEOUT_MS } from "./git-worktree-recovery.ts";

type Call = { args: string[]; timeoutMs: number | undefined };

/** Fake `git` CLI boundary; the filesystem effects of `worktree add` are simulated for real. */
const done = (exitCode = 0) => ({ exitCode, timedOut: false, signal: null });

function fakeGit(options: {
  listed?: () => string;
  onAdd?: (path: string) => Promise<{ exitCode: number; stderr?: string } | "abort">;
  failList?: boolean;
}): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = {
    async run(opts) {
      const args = opts.argv.slice(1);
      calls.push({ args, timeoutMs: opts.timeoutMs });
      const out = (stdout: string) => opts.onChunk({ stream: "stdout", data: stdout });
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree")
        return (out("true\n"), done());
      if (args[0] === "rev-parse") return (out("abc123\n"), done());
      if (args[0] === "worktree" && args[1] === "list") {
        if (options.failList) throw new Error("list failed");
        out(options.listed?.() ?? "");
        return done();
      }
      if (args[0] === "worktree" && args[1] === "add") {
        const result = (await options.onAdd?.(args[3]!)) ?? { exitCode: 0 };
        if (result === "abort") throw new Error("This operation was aborted");
        if (result.stderr) opts.onChunk({ stream: "stderr", data: result.stderr });
        return done(result.exitCode);
      }
      return done();
    },
  };
  return { runner, calls };
}

let root: string;
let repo: string;
let target: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ah-wt-recovery-"));
  repo = join(root, "repo");
  target = join(root, "managed", "auto-4");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(root, "managed"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ensure = (runner: ProcessRunner, path = target) =>
  createGitClient(runner).ensureWorktree({ repoPath: repo, worktreePath: path, branch: "main" });

async function interruptedCheckout(path: string): Promise<void> {
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, "src", "partial.txt"), "x");
  await writeFile(join(path, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "gone")}\n`);
}

describe("ensureWorktree recovery from an interrupted add", () => {
  it("removes an unregistered checkout with a dangling gitfile and recreates it", async () => {
    await interruptedCheckout(target);
    const { runner, calls } = fakeGit({
      onAdd: async (path) => {
        // The leftover must be gone before git is asked to add again.
        await expect(stat(path)).rejects.toThrow();
        return { exitCode: 0 };
      },
    });
    await ensure(runner);
    expect(calls.some((call) => call.args[1] === "prune")).toBe(true);
    expect(calls.filter((call) => call.args[1] === "add")).toHaveLength(1);
  });

  it("removes an empty leftover directory", async () => {
    await mkdir(target);
    const { runner } = fakeGit({});
    await ensure(runner);
    await expect(stat(target)).rejects.toThrow();
  });

  it("never touches a registered worktree", async () => {
    await interruptedCheckout(target);
    const { runner, calls } = fakeGit({ listed: () => `worktree ${target}\n` });
    await ensure(runner);
    expect((await stat(join(target, "src", "partial.txt"))).isFile()).toBe(true);
    expect(calls.some((call) => call.args[1] === "add")).toBe(false);
  });

  it.each([
    ["a standalone clone", async () => mkdir(join(target, ".git"), { recursive: true })],
    [
      "a gitfile whose gitdir still exists",
      async () => {
        await mkdir(join(root, "other-gitdir"), { recursive: true });
        await mkdir(target);
        await writeFile(join(target, ".git"), `gitdir: ${join(root, "other-gitdir")}\n`);
      },
    ],
    [
      "unrelated files",
      async () => {
        await mkdir(target);
        await writeFile(join(target, "notes.txt"), "keep me");
      },
    ],
    [
      "an unparsable gitfile",
      async () => {
        await mkdir(target);
        await writeFile(join(target, ".git"), "garbage\n");
      },
    ],
  ])("refuses to delete %s", async (_name, setup) => {
    await setup();
    const { runner, calls } = fakeGit({});
    await expect(ensure(runner)).rejects.toThrow(/not an abandoned checkout/);
    expect((await readdir(target)).length).toBeGreaterThan(0);
    expect(calls.some((call) => call.args[1] === "add")).toBe(false);
  });

  it("refuses a path that encloses the repository or lives inside its .git", async () => {
    const { runner } = fakeGit({});
    await expect(ensure(runner, root)).rejects.toThrow(/overlaps the repository/);
    await mkdir(join(repo, ".git", "modules"), { recursive: true });
    await expect(ensure(runner, join(repo, ".git", "modules"))).rejects.toThrow(/overlaps/);
    expect((await stat(join(repo, ".git"))).isDirectory()).toBe(true);
  });

  it("resolves a symlinked managed path before checking the repository overlap", async () => {
    const alias = join(root, "alias");
    await symlink(repo, alias);
    const { runner } = fakeGit({});
    await expect(ensure(runner, alias)).rejects.toThrow(/overlaps the repository/);
  });
});

describe("ensureWorktree failed or aborted add", () => {
  it("cleans up the partial checkout when git fails", async () => {
    const { runner, calls } = fakeGit({
      onAdd: async (path) => {
        await interruptedCheckout(path);
        return { exitCode: 128, stderr: "fatal: could not write index" };
      },
    });
    await expect(ensure(runner)).rejects.toThrow(/Failed to create worktree.*could not write/);
    await expect(stat(target)).rejects.toThrow();
    expect(calls.filter((call) => call.args[1] === "prune").length).toBeGreaterThanOrEqual(2);
  });

  it("removes a still-registered half-created worktree before deleting it", async () => {
    let added = false;
    const { runner, calls } = fakeGit({
      listed: () => (added ? `worktree ${target}\n` : ""),
      onAdd: async (path) => {
        added = true;
        await interruptedCheckout(path);
        return "abort";
      },
    });
    await expect(ensure(runner)).rejects.toThrow(/aborted/);
    expect(calls.some((call) => call.args[1] === "remove" && call.args.includes("--force"))).toBe(
      true,
    );
    await expect(stat(target)).rejects.toThrow();
  });

  it("surfaces the original failure even when cleanup itself fails", async () => {
    let added = false;
    const { runner } = fakeGit({
      listed: () => "",
      onAdd: async () => {
        added = true;
        return "abort";
      },
    });
    const failing: ProcessRunner = {
      run: (opts) =>
        added && opts.argv.includes("list")
          ? Promise.reject(new Error("list failed"))
          : runner.run(opts),
    };
    await expect(ensure(failing)).rejects.toThrow(/aborted/);
  });

  it("gives the add a long but bounded timeout and does not create when told not to", async () => {
    const { runner, calls } = fakeGit({});
    await ensure(runner);
    expect(calls.find((call) => call.args[1] === "add")?.timeoutMs).toBe(WORKTREE_ADD_TIMEOUT_MS);
    expect(WORKTREE_ADD_TIMEOUT_MS).toBeGreaterThan(120_000);

    const second = fakeGit({});
    await expect(
      createGitClient(second.runner).ensureWorktree({
        repoPath: repo,
        worktreePath: target,
        branch: "main",
        createMissing: false,
      }),
    ).resolves.toBe("missing");
    expect(second.calls.some((call) => call.args[1] === "add")).toBe(false);
  });
});
