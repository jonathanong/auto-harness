import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { checkoutFetchFailure } from "./git-commands.ts";
import { SessionRunner } from "./session-runner.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { LogStreamer } from "./log-streamer.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

const processRunner: ProcessRunner = {
  async run() {
    return { exitCode: 0, timedOut: false, signal: null };
  },
};

const mainClaim = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "main", name: "main", path: "/repo", labels: [] },
  cwd: "/repo",
  currentHookTarget: async () => ({ cwd: "/repo", repository: {} }),
};

describe("SessionRunner deferred main coverage", () => {
  it("releases a retained main checkout when its deferred hook settles", async () => {
    let releases = 0;
    const runner = new SessionRunner({
      processRunner,
      worktrees: {
        acquireMain: async () => true,
        mainClaim: async () => mainClaim,
        prepareMainCheckout: async () => {
          throw checkoutFetchFailure("fetch failed");
        },
        releaseMain: () => {
          releases += 1;
        },
      } as unknown as WorktreeManager,
    });
    const result = await runner.run(
      baseAssign({ worktreeId: null, sessionType: "scheduled", infrastructureRetryCount: 0 }),
      { deferCheckoutFetchFailureHook: true },
    );
    expect(releases).toBe(0);
    await result.settleDeferredTerminalHook?.(false);
    expect(releases).toBe(1);
  });

  it("reports a timed-out command-start rejection", async () => {
    const logs = [];
    const result = await runClaimedSession(
      processRunner,
      new LogStreamer("session", "attempt", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      {
        repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
        worktree: { id: "wt-1", name: "wt", path: "/worktree", labels: [] },
        cwd: "/worktree",
        currentHookTarget: async () => ({ cwd: "/worktree", repository: {} }),
      },
      undefined,
      () => true,
      () => 1,
      processRunner,
      process.env,
      undefined,
      undefined,
      async () => false,
    );
    expect(result).toMatchObject({ status: "timed_out", exitCode: null });
  });
});
