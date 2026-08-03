import { describe, expect, it } from "vitest";

import { createGitClient } from "./git.ts";
import { scripted } from "./git-test-helpers.ts";

describe("createGitClient checkout and revParse", () => {
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
