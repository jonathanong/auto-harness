import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

const claimed = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "worktree", path: "/worktree", labels: [] },
  cwd: "/worktree",
};

const processRunner: ProcessRunner = {
  async run() {
    return { exitCode: 0, timedOut: false, signal: null };
  },
};

describe("SessionRunner deadline branch coverage", () => {
  it("reports a deadline that expires while waiting for the main-checkout lock", async () => {
    let released = false;
    const worktrees = {
      mainClaim: () => claimed,
      acquireMain: async () => {
        await delay();
        return true;
      },
      releaseMain: () => {
        released = true;
      },
    } as unknown as WorktreeManager;
    const runner = new SessionRunner({ worktrees, processRunner });
    await expect(
      runner.run(baseAssign({ worktreeId: null, sessionType: "scheduled", timeout: 0.001 })),
    ).resolves.toMatchObject({ status: "timed_out" });
    expect(released).toBe(true);
  });

  it("preserves timeout when checkout rejects after the deadline", async () => {
    const worktrees = regularWorktrees(async () => {
      await delay();
      throw new Error("checkout stopped");
    });
    const runner = new SessionRunner({ worktrees, processRunner });
    await expect(runner.run(baseAssign({ timeout: 0.001 }))).resolves.toMatchObject({
      status: "timed_out",
    });
  });

  it("preserves external cancellation when checkout completes after abort", async () => {
    const controller = new AbortController();
    const worktrees = regularWorktrees(async () => {
      controller.abort();
    });
    const runner = new SessionRunner({ worktrees, processRunner });
    await expect(runner.run(baseAssign(), { signal: controller.signal })).resolves.toMatchObject({
      status: "cancelled",
    });
  });
});

function regularWorktrees(prepareCheckout: () => Promise<void>): WorktreeManager {
  return {
    claim: () => claimed,
    prepareCheckout,
    release: () => undefined,
  } as unknown as WorktreeManager;
}

async function delay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}
