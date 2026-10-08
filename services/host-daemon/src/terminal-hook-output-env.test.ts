import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { runTerminalHook } from "./terminal-hook.ts";

describe("terminal hook output environment", () => {
  it("re-adds only the daemon-owned output paths after the normal HARNESS_ filter", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const runner: ProcessRunner = {
      async run(options) {
        seen = options.env;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await runTerminalHook(runner, {
      scriptPath: "/hooks/done.sh",
      cwd: "/worktree",
      sessionId: "session-1",
      status: "completed",
      worktreePath: "/worktree",
      childEnvSource: {
        HARNESS_OUTPUT_FILE: "/private/attempt/output.json",
        HARNESS_ARTIFACTS_DIR: "/private/attempt/artifacts",
        HARNESS_API_KEY: "never-forward",
      },
    });
    expect(seen?.HARNESS_OUTPUT_FILE).toBe("/private/attempt/output.json");
    expect(seen?.HARNESS_ARTIFACTS_DIR).toBe("/private/attempt/artifacts");
    expect(seen?.HARNESS_API_KEY).toBeUndefined();
  });
});
