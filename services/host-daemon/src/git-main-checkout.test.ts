import { describe, expect, it } from "vitest";

import { createGitClient } from "./git.ts";
import { scripted } from "./git-test-helpers.ts";

describe("createGitClient main checkout", () => {
  it("switches a clean checkout to a branch and verifies symbolic HEAD", async () => {
    const calls: string[][] = [];
    const git = createGitClient({
      async run(options) {
        calls.push(options.argv.slice(1));
        if (options.argv[1] === "symbolic-ref") {
          options.onChunk({ stream: "stdout", data: "main\n" });
        }
        if (options.argv[1] === "show-ref") {
          return { exitCode: 0, timedOut: false, signal: null };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    await git.prepareMainCheckout({ cwd: "/repo", ref: "main" });
    expect(calls).toEqual([
      ["check-ref-format", "--branch", "main"],
      ["status", "--porcelain"],
      ["show-ref", "--verify", "--quiet", "refs/heads/main"],
      ["switch", "--", "main"],
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ]);
  });

  it("refuses dirty or invalid main checkout refs", async () => {
    const dirty = createGitClient({
      async run(options) {
        if (options.argv[1] === "status") {
          options.onChunk({ stream: "stdout", data: " M tracked.txt\n?? new.txt\n" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    await expect(dirty.prepareMainCheckout({ cwd: "/repo", ref: "main" })).rejects.toThrow(
      /uncommitted changes/,
    );
    const invalid = createGitClient(
      scripted([{ match: ["check-ref-format", "--branch", "HEAD"], exitCode: 1 }]),
    );
    await expect(invalid.prepareMainCheckout({ cwd: "/repo", ref: "HEAD" })).rejects.toThrow(
      /Invalid main checkout branch ref/,
    );
  });

  it("reports status and local-branch switch failures", async () => {
    const statusFailed = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "main"], exitCode: 0 },
        { match: ["status", "--porcelain"], exitCode: 1 },
      ]),
    );
    await expect(statusFailed.prepareMainCheckout({ cwd: "/repo", ref: "main" })).rejects.toThrow(
      /Failed to inspect main checkout/,
    );
    const localFailed = createGitClient({
      async run(options) {
        if (options.argv[1] === "switch") {
          return { exitCode: 1, timedOut: false, signal: null };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    await expect(localFailed.prepareMainCheckout({ cwd: "/repo", ref: "main" })).rejects.toThrow(
      /Failed to switch main checkout/,
    );
  });

  it("fetches missing branches and reports fetch or second-switch failures", async () => {
    const fetched = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "feature/x"], exitCode: 0 },
        { match: ["status", "--porcelain"], exitCode: 0 },
        { match: ["show-ref", "--verify", "--quiet", "refs/heads/feature/x"], exitCode: 1 },
        { match: ["switch", "--", "feature/x"], exitCode: 1 },
        { match: ["fetch", "--all", "--tags"], exitCode: 0 },
        { match: ["switch", "--", "feature/x"], exitCode: 0 },
        {
          match: ["symbolic-ref", "--quiet", "--short", "HEAD"],
          exitCode: 0,
          stdout: "feature/x\n",
        },
      ]),
    );
    await fetched.prepareMainCheckout({ cwd: "/repo", ref: "feature/x" });
    const fetchFailed = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "feature"], exitCode: 0 },
        { match: ["status", "--porcelain"], exitCode: 0 },
        { match: ["show-ref", "--verify", "--quiet", "refs/heads/feature"], exitCode: 1 },
        { match: ["switch", "--", "feature"], exitCode: 1 },
        { match: ["fetch", "--all", "--tags"], exitCode: 1, stderr: "offline" },
      ]),
    );
    await expect(fetchFailed.prepareMainCheckout({ cwd: "/repo", ref: "feature" })).rejects.toThrow(
      /Failed to fetch branch/,
    );
  });

  it("rejects symbolic HEAD mismatches and failed retries", async () => {
    const mismatch = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "feature"], exitCode: 0 },
        { match: ["status", "--porcelain"], exitCode: 0 },
        { match: ["show-ref", "--verify", "--quiet", "refs/heads/feature"], exitCode: 0 },
        { match: ["switch", "--", "feature"], exitCode: 0 },
        { match: ["symbolic-ref", "--quiet", "--short", "HEAD"], exitCode: 0, stdout: "other\n" },
      ]),
    );
    await expect(mismatch.prepareMainCheckout({ cwd: "/repo", ref: "feature" })).rejects.toThrow(
      /Main checkout is not on branch/,
    );
    const retryFailed = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "feature"], exitCode: 0 },
        { match: ["status", "--porcelain"], exitCode: 0 },
        { match: ["show-ref", "--verify", "--quiet", "refs/heads/feature"], exitCode: 1 },
        { match: ["switch", "--", "feature"], exitCode: 1 },
        { match: ["fetch", "--all", "--tags"], exitCode: 0 },
        { match: ["switch", "--", "feature"], exitCode: 1, stderr: "still missing" },
      ]),
    );
    await expect(retryFailed.prepareMainCheckout({ cwd: "/repo", ref: "feature" })).rejects.toThrow(
      /Failed to switch main checkout/,
    );
  });
});
