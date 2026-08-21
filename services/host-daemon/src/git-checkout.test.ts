import { describe, expect, it } from "vitest";

import { createGitClient } from "./git.ts";
import { scripted } from "./git-test-helpers.ts";

function resolvesCommit(ref: string, sha = "abc") {
  return {
    match: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    exitCode: 0,
    stdout: `${sha}\n`,
  };
}

describe("createGitClient checkout and revParse", () => {
  it("checkoutRef detaches at resolved sha", async () => {
    const git = createGitClient(
      scripted([
        resolvesCommit("main", "abc123"),
        { match: ["switch", "--detach", "abc123"], exitCode: 0 },
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123\n" },
      ]),
    );
    await git.checkoutRef({ cwd: "/repo/wt", ref: "main" });
  });

  it("checkoutRef fetches then falls back to checkout --detach", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main^{commit}"],
          exitCode: 1,
          stderr: "no",
        },
        { match: ["fetch", "--all", "--tags"], exitCode: 0 },
        resolvesCommit("main"),
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "old git" },
        { match: ["checkout", "--detach", "abc"], exitCode: 0 },
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc\n" },
      ]),
    );
    await git.checkoutRef({ cwd: "/repo/wt", ref: "main" });
  });

  it("checkoutRef fails when ref cannot be resolved", async () => {
    await expect(
      createGitClient(
        scripted([
          {
            match: ["rev-parse", "--verify", "--end-of-options", "bad^{commit}"],
            exitCode: 1,
            stderr: "e",
          },
          { match: ["fetch", "--all", "--tags"], exitCode: 0 },
          {
            match: ["rev-parse", "--verify", "--end-of-options", "bad^{commit}"],
            exitCode: 1,
            stderr: "e2",
          },
        ]),
      ).checkoutRef({ cwd: "/repo", ref: "bad" }),
    ).rejects.toThrow(/Failed to resolve ref/);
  });

  it("checkoutRef peels an annotated tag to its commit", async () => {
    const git = createGitClient(
      scripted([
        resolvesCommit("v1.2.3", "commit-sha"),
        { match: ["switch", "--detach", "commit-sha"], exitCode: 0 },
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "commit-sha\n" },
      ]),
    );

    await expect(git.checkoutRef({ cwd: "/repo", ref: "v1.2.3" })).resolves.toBeUndefined();
  });

  it("checkoutRef retries once after a target graph connectivity failure", async () => {
    const git = createGitClient(
      scripted([
        resolvesCommit("main"),
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["remote"], exitCode: 0, stdout: "origin\nupstream\n" },
        {
          match: ["fetch", "--tags", "--refetch", "origin"],
          exitCode: 0,
        },
        { match: ["fetch", "--tags", "--refetch", "upstream"], exitCode: 0 },
        { match: ["switch", "--detach", "abc"], exitCode: 0 },
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc\n" },
      ]),
    );
    await expect(git.checkoutRef({ cwd: "/repo", ref: "main" })).resolves.toBeUndefined();
  });

  it("checkoutRef does not refetch after an unrelated checkout failure", async () => {
    const checkout = createGitClient(
      scripted([
        resolvesCommit("main"),
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "dirty worktree" },
        { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "dirty worktree" },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 0 },
      ]),
    ).checkoutRef({ cwd: "/repo", ref: "main" });

    await expect(checkout).rejects.toThrow("Failed to checkout resolved ref");
  });

  it("checkoutRef fails closed when a remote refetch fails", async () => {
    const checkout = createGitClient(
      scripted([
        resolvesCommit("main"),
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "s" },
        { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "c" },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["remote"], exitCode: 0, stdout: "origin\n" },
        {
          match: ["fetch", "--tags", "--refetch", "origin"],
          exitCode: 1,
          stderr: "fatal: https://oauth:secret-token@example.com/repo.git",
        },
      ]),
    ).checkoutRef({ cwd: "/repo", ref: "main" });
    const error = await checkout.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to fetch required checkout objects");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("checkoutRef fails after one missing-object recovery attempt", async () => {
    const checkout = createGitClient(
      scripted([
        resolvesCommit("main"),
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "first switch" },
        { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "first checkout" },
        { match: ["fsck", "--connectivity-only", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["remote"], exitCode: 0, stdout: "origin\n" },
        { match: ["fetch", "--tags", "--refetch", "origin"], exitCode: 0 },
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "second switch" },
        {
          match: ["checkout", "--detach", "abc"],
          exitCode: 1,
          stderr: "fatal: https://oauth:secret-token@example.com/repo.git",
        },
      ]),
    ).checkoutRef({ cwd: "/repo", ref: "main" });
    const error = await checkout.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to checkout resolved ref");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("checkoutRef fails closed when detached HEAD resolves to a different SHA", async () => {
    const checkout = createGitClient(
      scripted([
        resolvesCommit("main"),
        { match: ["switch", "--detach", "abc"], exitCode: 0 },
        {
          match: ["rev-parse", "HEAD"],
          exitCode: 0,
          stdout: "different-sha\n",
        },
      ]),
    ).checkoutRef({ cwd: "/repo", ref: "main" });
    const error = await checkout.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to verify detached checkout");
    expect((error as Error).message).not.toContain("different-sha");
  });

  it("revParse returns hash", async () => {
    const git = createGitClient(
      scripted([{ match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123\n" }]),
    );
    await expect(git.revParse("/repo", "HEAD")).resolves.toBe("abc123");
  });

  it("forwards a session abort signal to every checkout command", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const git = createGitClient({
      async run(options) {
        if (options.signal) seen.push(options.signal);
        options.onChunk({ stream: "stdout", data: "abc\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    await git.checkoutRef({ cwd: "/repo/wt", ref: "main", signal: controller.signal });
    expect(seen).toEqual([controller.signal, controller.signal, controller.signal]);
  });
});
