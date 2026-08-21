import { describe, expect, it } from "vitest";

import { createGitClient } from "./git.ts";
import { scripted } from "./git-test-helpers.ts";

describe("createGitClient checkout and revParse", () => {
  it("checkoutRef detaches at resolved sha", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main"],
          exitCode: 0,
          stdout: "abc123\n",
        },
        { match: ["switch", "--detach", "abc123"], exitCode: 0 },
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123\n" },
      ]),
    );
    await git.checkoutRef({ cwd: "/repo/wt", ref: "main" });
  });

  it("checkoutRef fetches then falls back to checkout --detach", async () => {
    const git = createGitClient(
      scripted([
        { match: ["rev-parse", "--verify", "--end-of-options", "main"], exitCode: 1, stderr: "no" },
        { match: ["fetch", "--all", "--tags"], exitCode: 0 },
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main"],
          exitCode: 0,
          stdout: "abc\n",
        },
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
          { match: ["rev-parse", "--verify", "--end-of-options", "bad"], exitCode: 1, stderr: "e" },
          { match: ["fetch", "--all", "--tags"], exitCode: 0 },
          {
            match: ["rev-parse", "--verify", "--end-of-options", "bad"],
            exitCode: 1,
            stderr: "e2",
          },
        ]),
      ).checkoutRef({ cwd: "/repo", ref: "bad" }),
    ).rejects.toThrow(/Failed to resolve ref/);
  });

  it("checkoutRef retries checkout once after fetching missing objects", async () => {
    const git = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main"],
          exitCode: 0,
          stdout: "abc\n",
        },
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "missing tree" },
        { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "missing tree" },
        {
          match: ["fetch", "--all", "--tags", "--refetch"],
          exitCode: 0,
        },
        { match: ["switch", "--detach", "abc"], exitCode: 0 },
        { match: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc\n" },
      ]),
    );
    await expect(git.checkoutRef({ cwd: "/repo", ref: "main" })).resolves.toBeUndefined();
  });

  it("checkoutRef fails closed when the missing-object fetch fails", async () => {
    const checkout = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main"],
          exitCode: 0,
          stdout: "abc\n",
        },
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "s" },
        { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "c" },
        {
          match: ["fetch", "--all", "--tags", "--refetch"],
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

  it("checkoutRef fails after one missing-object fetch retry", async () => {
    const checkout = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main"],
          exitCode: 0,
          stdout: "abc\n",
        },
        { match: ["switch", "--detach", "abc"], exitCode: 1, stderr: "first switch" },
        { match: ["checkout", "--detach", "abc"], exitCode: 1, stderr: "first checkout" },
        { match: ["fetch", "--all", "--tags", "--refetch"], exitCode: 0 },
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

  it("checkoutRef fails closed when detached HEAD does not match the resolved SHA", async () => {
    const checkout = createGitClient(
      scripted([
        {
          match: ["rev-parse", "--verify", "--end-of-options", "main"],
          exitCode: 0,
          stdout: "abc\n",
        },
        { match: ["switch", "--detach", "abc"], exitCode: 0 },
        {
          match: ["rev-parse", "HEAD"],
          exitCode: 1,
          stderr: "fatal: https://oauth:secret-token@example.com/repo.git",
        },
      ]),
    ).checkoutRef({ cwd: "/repo", ref: "main" });
    const error = await checkout.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Failed to verify detached checkout");
    expect((error as Error).message).not.toContain("secret-token");
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
