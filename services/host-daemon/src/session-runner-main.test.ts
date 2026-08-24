import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { createGitClient } from "./git.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";
import { scripted } from "./git-test-helpers.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { deferred, makeRunner, viTick } from "./session-runner-main-test-helpers.ts";

describe("SessionRunner main checkout", () => {
  it("propagates a bounded redacted Git failure without leaking credentials", async () => {
    const config = parseDaemonConfig({
      hostId: "a1",
      repositories: [{ id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] }],
    });
    const git = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "feature"], exitCode: 0 },
        { match: ["status", "--porcelain"], exitCode: 0 },
        {
          match: ["show-ref", "--verify", "--quiet", "refs/heads/feature"],
          exitCode: 1,
        },
        { match: ["switch", "--", "feature"], exitCode: 1 },
        {
          match: ["fetch", "--all", "--tags"],
          exitCode: 1,
          stderr: "fatal: https://oauth:session-secret@example.com/repo.git",
        },
      ]),
    );
    const sessionRunner = new SessionRunner({
      worktrees: new WorktreeManager(config, git),
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      now: () => "2026-08-01T00:00:00.000Z",
    });

    const result = await sessionRunner.run(
      baseAssign({
        repositoryId: "repo-1",
        worktreeId: null,
        sessionType: "scheduled",
        ref: "feature",
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
    });
    expect(result.errorMessage).toContain("Failed to fetch branch feature");
    expect(result.errorMessage).not.toContain("session-secret");
    expect(result.logs.every((log) => !log.content.includes("session-secret"))).toBe(true);
  });

  it("uses the repository path, branch switch, setup, and hook cwd", async () => {
    const test = makeRunner();
    const result = await test.runner.run(
      baseAssign({
        repositoryId: "r1",
        worktreeId: null,
        sessionType: "scheduled",
        ref: "feature",
        setupScript: "setup",
      }),
    );
    expect(result.status).toBe("completed");
    expect(test.checkouts).toEqual(["/repo-1:feature"]);
    expect(test.starts).toEqual(["/repo-1"]);
    expect(test.hooks).toEqual(["/repo-1"]);
  });

  it("serializes same-repository sessions in FIFO order", async () => {
    const test = makeRunner();
    const firstGate = deferred();
    test.waits.set("/repo-1", firstGate);
    const first = test.runner.run(
      baseAssign({
        sessionId: "first",
        repositoryId: "r1",
        worktreeId: null,
        sessionType: "scheduled",
      }),
    );
    await viTick();
    const second = test.runner.run(
      baseAssign({
        sessionId: "second",
        repositoryId: "r1",
        worktreeId: null,
        sessionType: "scheduled",
      }),
    );
    await viTick();
    expect(test.starts).toEqual(["/repo-1"]);
    firstGate.resolve();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(second).resolves.toMatchObject({ status: "completed" });
    expect(test.starts).toEqual(["/repo-1", "/repo-1"]);
  });

  it("runs different repositories in parallel", async () => {
    const test = makeRunner();
    const r1Gate = deferred();
    test.waits.set("/repo-1", r1Gate);
    const first = test.runner.run(
      baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
    );
    await viTick();
    const second = test.runner.run(
      baseAssign({ repositoryId: "r2", worktreeId: null, sessionType: "scheduled" }),
    );
    await viTick();
    expect(test.starts).toEqual(["/repo-1", "/repo-2"]);
    r1Gate.resolve();
    await Promise.all([first, second]);
  });

  it("cancellation removes a queued lock waiter and a thrown run releases the lock", async () => {
    const test = makeRunner();
    const firstGate = deferred();
    test.waits.set("/repo-1", firstGate);
    const first = test.runner.run(
      baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
    );
    await viTick();
    const controller = new AbortController();
    const queued = test.runner.run(
      baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(queued).resolves.toMatchObject({ status: "cancelled" });
    expect(test.hooks).toEqual([]);
    firstGate.resolve();
    await first;
    expect(test.hooks).toEqual(["/repo-1"]);
    test.waits.delete("/repo-1");
    test.throwPrimary.value = true;
    await expect(
      test.runner.run(
        baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "primary failed",
    });
    await expect(
      test.runner.run(
        baseAssign({ repositoryId: "r1", worktreeId: null, sessionType: "scheduled" }),
      ),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("fails unknown repositories before acquiring a main lock", async () => {
    const test = makeRunner();
    const result = await test.runner.run(
      baseAssign({ repositoryId: "missing", worktreeId: null, sessionType: "scheduled" }),
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "setup_failed" });
  });

  it("acquires the main lock before taking a fresh, path-validated claim", async () => {
    const calls: string[] = [];
    const runner = new SessionRunner({
      worktrees: {
        acquireMain: async () => {
          calls.push("lock");
          return true;
        },
        mainClaim: async () => {
          calls.push("claim");
          throw new Error("path is outside allowed roots");
        },
        releaseMain: () => calls.push("release"),
      } as unknown as WorktreeManager,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });

    await expect(
      runner.run(
        baseAssign({ repositoryId: "repo-1", worktreeId: null, sessionType: "scheduled" }),
      ),
    ).resolves.toMatchObject({ status: "failed", errorCode: "setup_failed" });
    expect(calls).toEqual(["lock", "claim", "release"]);
  });
});
