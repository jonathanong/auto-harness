import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const claimedBase = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
  cwd: "/wt",
  currentHookTarget: async () => null,
};

function runner(): ProcessRunner {
  return {
    async run() {
      return { exitCode: 0, timedOut: false, signal: null, environment: {} };
    },
  };
}

async function runClaimed(
  claimed: typeof claimedBase,
  setupScript?: string,
  remainingMs: () => number = () => 10_000,
) {
  const logs = [];
  return await runClaimedSession(
    runner(),
    new LogStreamer("session", "attempt", (chunk) => logs.push(chunk)),
    logs,
    baseAssign(setupScript ? { setupScript } : {}),
    claimed,
    undefined,
    () => false,
    remainingMs,
    undefined,
    { PATH: process.env.PATH },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
}

describe("deferred pre-command setup failures", () => {
  it("marks a preflight failure as deferred", async () => {
    const result = await runClaimed({
      ...claimedBase,
      currentExecutionTarget: async () => {
        throw new Error("policy changed");
      },
    });
    expect(result).toMatchObject({ status: "failed", errorMessage: "policy changed" });
    expect(result.settleDeferredTerminalHook).toEqual(expect.any(Function));
  });

  it("marks a setup revalidation failure as deferred", async () => {
    let calls = 0;
    const result = await runClaimed(
      {
        ...claimedBase,
        currentExecutionTarget: async () => {
          calls += 1;
          if (calls === 3) throw new Error("setup policy changed");
        },
      },
      "setup",
      () => {
        throw new Error("setup planner failed");
      },
    );
    expect(result).toMatchObject({ status: "failed", errorMessage: "setup planner failed" });
    expect(result.settleDeferredTerminalHook).toEqual(expect.any(Function));
  });
});
