import { describe, expect, it, vi } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { runTerminalHook } from "./terminal-hook.ts";

describe("runTerminalHook", () => {
  it("passes session env to the hook script", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const runner: ProcessRunner = {
      async run(opts) {
        seenEnv = opts.env;
        expect(opts.argv).toEqual(["/bin/sh", "/hooks/done.sh"]);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await runTerminalHook(runner, {
      scriptPath: "/hooks/done.sh",
      cwd: "/wt",
      sessionId: "sess-1",
      status: "failed",
      errorCode: "usage_limit",
      ref: "main",
      metadata: { pr: 1 },
      worktreePath: "/wt",
      childEnvSource: {
        HARNESS_CHILD_ENV_ALLOWLIST: "AGENT_BLACKBOARD_TOKEN",
        AGENT_BLACKBOARD_TOKEN: "persisted-token",
      },
    });
    expect(seenEnv?.HARNESS_SESSION_ID).toBe("sess-1");
    expect(seenEnv?.HARNESS_STATUS).toBe("failed");
    expect(seenEnv?.HARNESS_ERROR_CODE).toBe("usage_limit");
    expect(seenEnv?.HARNESS_REF).toBe("main");
    expect(seenEnv?.HARNESS_METADATA).toBe('{"pr":1}');
    expect(seenEnv?.HARNESS_WORKTREE_PATH).toBe("/wt");
    expect(seenEnv?.AGENT_BLACKBOARD_TOKEN).toBe("persisted-token");
  });

  it("injects hook metadata without inheriting daemon credentials", async () => {
    const original = process.env.HARNESS_API_KEY;
    process.env.HARNESS_API_KEY = "do-not-forward";
    try {
      let seen: NodeJS.ProcessEnv | undefined;
      await runTerminalHook(
        {
          async run(opts) {
            seen = opts.env;
            return { exitCode: 0, timedOut: false, signal: null };
          },
        },
        {
          scriptPath: "/h.sh",
          cwd: "/wt",
          sessionId: "s",
          status: "completed",
          worktreePath: "/wt",
        },
      );
      expect(seen?.HARNESS_API_KEY).toBeUndefined();
      expect(seen?.HARNESS_SESSION_ID).toBe("s");
    } finally {
      if (original === undefined) delete process.env.HARNESS_API_KEY;
      else process.env.HARNESS_API_KEY = original;
    }
  });

  it("swallows hook failures", async () => {
    const log = vi.fn();
    const runner: ProcessRunner = {
      async run() {
        throw new Error("boom");
      },
    };
    await expect(
      runTerminalHook(
        runner,
        {
          scriptPath: "/hooks/done.sh",
          cwd: "/wt",
          sessionId: "sess-1",
          status: "completed",
          worktreePath: "/wt",
        },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();

    const log2 = vi.fn();
    await runTerminalHook(
      {
        async run() {
          throw "raw";
        },
      },
      {
        scriptPath: "/hooks/done.sh",
        cwd: "/wt",
        sessionId: "sess-2",
        status: "failed",
        worktreePath: "/wt",
      },
      log2,
    );
    expect(log2.mock.calls[0]?.[0]).toContain("raw");
  });

  it("logs non-zero hook exit", async () => {
    const log = vi.fn();
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 2, timedOut: false, signal: null };
      },
    };
    await runTerminalHook(
      runner,
      {
        scriptPath: "/h.sh",
        cwd: "/wt",
        sessionId: "s",
        status: "timed_out",
        worktreePath: "/wt",
      },
      log,
    );
    expect(log).toHaveBeenCalled();
  });

  it("uses console.error by default on failure and discards output chunks", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runner: ProcessRunner = {
      async run(opts) {
        opts.onChunk({ stream: "stdout", data: "noise" });
        return { exitCode: 9, timedOut: false, signal: null };
      },
    };
    await runTerminalHook(runner, {
      scriptPath: "/h.sh",
      cwd: "/wt",
      sessionId: "s",
      status: "completed",
      worktreePath: "/wt",
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
