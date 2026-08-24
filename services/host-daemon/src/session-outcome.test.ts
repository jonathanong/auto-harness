import { describe, expect, it, vi } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { finishClaimedSession } from "./session-outcome.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";

describe("finishClaimedSession", () => {
  it("reports a terminal-hook revalidation failure before suppressing the hook", async () => {
    const logs = [];
    const runner: ProcessRunner = { run: vi.fn() };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/wt-1",
        repository: { terminalHookScript: "/repo/hook.sh" },
        currentHookTarget: async () => {
          throw new Error("path is outside allowed roots");
        },
      },
      { status: "failed", exitCode: 1, errorCode: "setup_failed" },
    );

    expect(result).toMatchObject({ status: "failed", errorCode: "setup_failed" });
    expect(runner.run).not.toHaveBeenCalled();
    expect(logs.map((chunk) => chunk.content)).toContain(
      "terminal hook revalidation failed for session sess-1: path is outside allowed roots",
    );
  });
});
