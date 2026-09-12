/* eslint-disable max-lines -- terminal outcome and result-probe branches share fixtures. */
import { describe, expect, it, vi } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { failSession, finishClaimedSession, harnessSessionResult } from "./session-outcome.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

describe("finishClaimedSession", () => {
  it("keeps a stable harness result for daemon-owned failures", async () => {
    const logs = [];
    const streamer = new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk));

    await expect(
      failSession(streamer, logs, "setup_failed", "setup could not run", null),
    ).resolves.toEqual({
      status: "failed",
      exitCode: null,
      errorCode: "setup_failed",
      errorMessage: "setup could not run",
      result: { summary: "Session failed", summarySource: "harness" },
      logs,
    });
    expect(logs.map((chunk) => chunk.content)).toContain("setup could not run");
    expect(harnessSessionResult("cancelled")).toEqual({
      summary: "Session cancelled",
      summarySource: "harness",
    });
  });

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
      {
        status: "failed",
        exitCode: 1,
        errorCode: "setup_failed",
        agentSummary: "The agent reported a failure.",
      },
      process.env,
      "0123456789012345678901234567890123456789",
    );

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      result: { summary: "The agent reported a failure.", summarySource: "agent" },
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(logs.map((chunk) => chunk.content)).toContain(
      "terminal hook revalidation failed for session sess-1: path is outside allowed roots",
    );
  });

  it("stringifies a primitive terminal-hook revalidation failure", async () => {
    const logs = [];
    const result = await finishClaimedSession(
      { run: vi.fn() },
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/wt-1",
        repository: { terminalHookScript: "/repo/hook.sh" },
        currentHookTarget: async () => {
          throw "hook-offline";
        },
      },
      { status: "failed", exitCode: 1, errorCode: "setup_failed" },
    );
    expect(result).toMatchObject({ status: "failed" });
    expect(logs.map((chunk) => chunk.content)).toContain(
      "terminal hook revalidation failed for session sess-1: hook-offline",
    );
  });

  it("does not probe a stale checkout when terminal-hook revalidation returns null", async () => {
    const runner: ProcessRunner = { run: vi.fn() };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/stale-worktree",
        repository: { terminalHookScript: "/repo/hook.sh" },
        currentHookTarget: async () => null,
      },
      { status: "completed", exitCode: 0, agentSummary: "Finished safely." },
      process.env,
      "0123456789012345678901234567890123456789",
    );

    expect(runner.run).not.toHaveBeenCalled();
    expect(result.result).toEqual({ summary: "Finished safely.", summarySource: "agent" });
  });

  it("collects the result only after the terminal hook has completed", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(options) {
        calls.push(options.argv);
        if (options.argv[0] === "/bin/sh") return { exitCode: 0, timedOut: false, signal: null };
        if (options.argv.includes("symbolic-ref")) {
          options.onChunk({ stream: "stdout", data: "feature/result\n" });
        }
        if (options.argv.includes("diff"))
          options.onChunk({ stream: "stdout", data: "changed.ts\0" });
        if (options.argv.includes("ls-files")) options.onChunk({ stream: "stdout", data: "" });
        if (options.argv.includes("pr")) return { exitCode: 1, timedOut: false, signal: null };
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs = [];
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/wt-1",
        repository: { terminalHookScript: "/repo/hook.sh" },
        currentHookTarget: async () => ({
          cwd: "/repo/wt-1",
          repository: { terminalHookScript: "/repo/hook.sh" },
        }),
      },
      { status: "completed", exitCode: 0, agentSummary: "done" },
      process.env,
      "0123456789012345678901234567890123456789",
    );

    expect(calls.findIndex((argv) => argv[0] === "/bin/sh")).toBeLessThan(
      calls.findIndex((argv) => argv.includes("symbolic-ref")),
    );
    expect(result.result).toMatchObject({
      summary: "done",
      summarySource: "agent",
      filesChanged: ["changed.ts"],
    });
  });

  it("collects an agent summary without a git baseline", async () => {
    const runner: ProcessRunner = {
      async run(options) {
        if (options.argv.includes("symbolic-ref"))
          options.onChunk({ stream: "stdout", data: "feature/result\n" });
        return { exitCode: options.argv.includes("pr") ? 1 : 0, timedOut: false, signal: null };
      },
    };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign(),
      { worktree: { id: "wt-1" }, cwd: "/repo/wt-1", repository: {} },
      { status: "completed", exitCode: 0, agentSummary: "done" },
    );

    expect(result.result).toMatchObject({ summary: "done", summarySource: "agent" });
  });

  it("uses a fallback without probing when the claimed hook target is unavailable", async () => {
    const runner: ProcessRunner = { run: vi.fn() };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/removed-worktree",
        repository: {},
        // An older claim may predate live hook revalidation support.
        currentHookTarget: undefined as unknown as () => Promise<null>,
      },
      { status: "cancelled", exitCode: null },
    );

    expect(runner.run).not.toHaveBeenCalled();
    expect(result.result).toEqual({ summary: "Session cancelled", summarySource: "harness" });
  });

  it("keeps terminal output fields while falling back when no probes are required", async () => {
    const runner: ProcessRunner = { run: vi.fn() };
    const usage = { inputTokens: 3, outputTokens: 5 };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/wt-1",
        repository: {},
        currentHookTarget: async () => ({ cwd: "/repo/wt-1", repository: {} }),
      },
      {
        status: "failed",
        exitCode: 9,
        errorCode: "execution_failed",
        errorMessage: "agent exited",
        cliResumeRef: "resume-1",
        usage,
      },
    );

    expect(runner.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      exitCode: 9,
      errorCode: "execution_failed",
      errorMessage: "agent exited",
      cliResumeRef: "resume-1",
      usage,
      result: { summary: "Session failed", summarySource: "harness" },
    });
  });

  it("collects baseline facts when the agent did not supply a summary", async () => {
    const runner: ProcessRunner = {
      async run(options) {
        if (options.argv.includes("symbolic-ref"))
          options.onChunk({ stream: "stdout", data: "feature/baseline\n" });
        return { exitCode: options.argv.includes("pr") ? 1 : 0, timedOut: false, signal: null };
      },
    };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/wt-1",
        repository: {},
        currentHookTarget: async () => ({ cwd: "/repo/wt-1", repository: {} }),
      },
      { status: "completed", exitCode: 0 },
      process.env,
      "0123456789012345678901234567890123456789",
    );

    expect(result.result).toMatchObject({
      summary: "Session completed; on feature/baseline; 0 files changed",
      summarySource: "harness",
      branch: "feature/baseline",
      filesChanged: [],
    });
  });

  it("collects an agent summary without requiring a checkout baseline", async () => {
    const runner: ProcessRunner = {
      async run(options) {
        return { exitCode: options.argv.includes("pr") ? 1 : 0, timedOut: false, signal: null };
      },
    };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: "/repo/wt-1",
        repository: {},
        currentHookTarget: async () => ({ cwd: "/repo/wt-1", repository: {} }),
      },
      { status: "completed", exitCode: 0, agentSummary: "Agent finished." },
    );

    expect(result.result).toMatchObject({ summary: "Agent finished.", summarySource: "agent" });
  });

  it("passes optional terminal-hook fields only when they are present", async () => {
    const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: ProcessRunner = {
      async run(options) {
        calls.push({ argv: options.argv, env: options.env });
        if (options.argv.includes("symbolic-ref"))
          options.onChunk({ stream: "stdout", data: "feature/hook\n" });
        return { exitCode: options.argv.includes("pr") ? 1 : 0, timedOut: false, signal: null };
      },
    };
    await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign({ ref: "release", metadata: { trigger: "schedule" } }),
      {
        worktree: { id: "wt-1" },
        cwd: process.cwd(),
        repository: { terminalHookScript: "AGENTS.md" },
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: { terminalHookScript: "AGENTS.md" },
          allowedRoots: [process.cwd()],
        }),
      },
      { status: "failed", exitCode: 2, errorCode: "execution_failed" },
      process.env,
      "0123456789012345678901234567890123456789",
    );

    const hook = calls.find((call) => call.argv[0] === "/bin/sh");
    expect(hook?.env).toMatchObject({
      HARNESS_ERROR_CODE: "execution_failed",
      HARNESS_REF: "release",
      HARNESS_METADATA: JSON.stringify({ trigger: "schedule" }),
    });
  });

  it("settles a deferred hook after revalidating the live claim", async () => {
    const logs: Array<{ content: string }> = [];
    const runner: ProcessRunner = {
      run: vi.fn(async () => ({ exitCode: 0, timedOut: false, signal: null })),
    };
    let mode: "none" | "null" | "hook" | "throw" = "none";
    const claimed = {
      worktree: { id: "wt-1" },
      cwd: "/repo/wt-1",
      repository: { terminalHookScript: "/repo/hook.sh" },
      currentHookTarget: async () => {
        if (mode === "throw") throw new Error("claim disappeared");
        if (mode === "null") return null;
        if (mode === "hook") {
          return {
            cwd: process.cwd(),
            repository: { terminalHookScript: "AGENTS.md" },
            allowedRoots: [process.cwd()],
          };
        }
        return { cwd: "/repo/wt-1", repository: {} };
      },
    };
    const streamer = new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk));
    const result = await finishClaimedSession(
      runner,
      streamer,
      [],
      baseAssign({ ref: "feature/test", metadata: { source: "deferred" } }),
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorCode: "checkout_fetch_failed",
        deferTerminalHook: true,
      },
    );

    // A retry disposition can discard the hook without another probe; a
    // terminal disposition revalidates the claim before invoking it.
    await result.settleDeferredTerminalHook?.(false);
    expect(runner.run).not.toHaveBeenCalled();

    mode = "null";
    await result.settleDeferredTerminalHook?.(true);
    expect(runner.run).not.toHaveBeenCalled();

    mode = "hook";
    await result.settleDeferredTerminalHook?.(true);
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["/bin/sh", `${process.cwd()}/AGENTS.md`],
        cwd: process.cwd(),
        env: expect.objectContaining({
          HARNESS_ERROR_CODE: "checkout_fetch_failed",
          HARNESS_REF: "feature/test",
          HARNESS_METADATA: JSON.stringify({ source: "deferred" }),
        }),
      }),
    );

    mode = "throw";
    await result.settleDeferredTerminalHook?.(true);
    expect(logs.map((chunk) => chunk.content)).toContain(
      "terminal hook revalidation failed for session sess-1: claim disappeared",
    );
  });

  it("omits optional hook fields when the failed run has no error code or ref", async () => {
    const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: ProcessRunner = {
      async run(options) {
        calls.push({ argv: options.argv, env: options.env });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await finishClaimedSession(
      runner,
      new LogStreamer("session-1", "attempt-1", () => undefined),
      [],
      baseAssign(),
      {
        worktree: { id: "wt-1" },
        cwd: process.cwd(),
        repository: { terminalHookScript: "AGENTS.md" },
        currentHookTarget: async () => ({
          cwd: process.cwd(),
          repository: { terminalHookScript: "AGENTS.md" },
        }),
      },
      {
        status: "failed",
        exitCode: null,
        deferTerminalHook: true,
      },
    );

    await result.settleDeferredTerminalHook?.(true);
    const hook = calls[0];
    expect(hook?.argv).toEqual(["/bin/sh", `${process.cwd()}/AGENTS.md`]);
    expect(hook?.env).not.toHaveProperty("HARNESS_ERROR_CODE");
    expect(hook?.env).not.toHaveProperty("HARNESS_REF");
  });
});
