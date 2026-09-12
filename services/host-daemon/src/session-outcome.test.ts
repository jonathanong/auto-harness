import { describe, expect, it, vi } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { finishClaimedSession } from "./session-outcome.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

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
});
