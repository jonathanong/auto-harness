import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "./session-run-setup.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";

function claim(
  cwd: string,
  currentExecutionTarget?: () => Promise<void>,
  hostSetupScript?: string,
): ClaimedWorktree {
  return {
    repository: { id: "repo-1", path: cwd, defaultBranch: "main", worktrees: [] },
    worktree: { id: "wt-1", name: "wt-1", path: cwd, labels: [] },
    cwd,
    ...(currentExecutionTarget ? { currentExecutionTarget } : {}),
    ...(hostSetupScript !== undefined ? { hostSetupScript } : {}),
    currentHookTarget: async () => null,
  };
}

function noopStreamer(): { streamer: LogStreamer; logs: SessionLogChunk[] } {
  const logs: SessionLogChunk[] = [];
  const streamer = new LogStreamer(
    "sess-1",
    "attempt-1",
    (chunk) => logs.push(chunk),
    () => "2026-08-01T00:00:00.000Z",
  );
  return { streamer, logs };
}

async function run(
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  runner: ProcessRunner,
  signal?: AbortSignal,
) {
  const { streamer, logs } = noopStreamer();
  return runSetupIfNeeded(
    runner,
    streamer,
    logs,
    assign,
    claimed,
    signal,
    () => false,
    () => 30_000,
  );
}

describe("runSetupIfNeeded setup edge cases", () => {
  it("fails structurally when setup revalidation throws a non-Error value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-setup-revalidation-"));
    const claimed = claim(
      cwd,
      () => {
        throw "boom";
      },
      "custom-host-setup",
    );
    const runner: ProcessRunner = {
      async run() {
        throw new Error("setup script should not run when revalidation fails");
      },
    };

    const { failure } = await run(baseAssign(), claimed, runner);
    expect(failure).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "boom",
    });
  });

  it("does not run setup or infer a command when no setup script is configured", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-no-setup-"));
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(options) {
        calls.push(options.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    const { failure } = await run(baseAssign(), claim(cwd), runner);
    expect(failure).toBeNull();
    expect(calls).toEqual([]);
  });

  it("normalizes bare newlines in setup output for the viewer, across chunk boundaries", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-setup-crlf-"));
    const runner: ProcessRunner = {
      async run(options) {
        options.onChunk({ stream: "stdout", data: "line one\nline two\r" });
        options.onChunk({ stream: "stdout", data: "\nline three\n" });
        return { exitCode: 0, timedOut: false, signal: null, environment: {} };
      },
    };
    const { streamer, logs } = noopStreamer();
    const { failure } = await runSetupIfNeeded(
      runner,
      streamer,
      logs,
      baseAssign({ setupScript: "prepare" }),
      claim(cwd),
      undefined,
      () => false,
      () => 30_000,
    );
    expect(failure).toBeNull();
    // The streamer coalesces consecutive same-stream writes into fewer emitted
    // chunks, so assert on the joined content rather than a specific split.
    const stdout = logs
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.content)
      .join("");
    expect(stdout).toBe("line one\r\nline two\r\nline three\r\n");
  });

  it("carries the pending CR across the host-setup/repo-setup script boundary, not just a chunk boundary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-setup-crlf-scripts-"));
    let invocation = 0;
    const runner: ProcessRunner = {
      async run(options) {
        invocation += 1;
        // Host setup runs first and ends its output on a lone \r (no \n yet).
        // The repo-scoped setup below runs as a second, separate runner.run()
        // call and opens with the matching \n. A normalizer recreated per
        // setup script (instead of once for the whole runSetupIfNeeded call)
        // would miss that the \r already belongs to it and double it.
        if (invocation === 1) {
          options.onChunk({ stream: "stdout", data: "host line\r" });
        } else {
          options.onChunk({ stream: "stdout", data: "\nrepo line\n" });
        }
        return { exitCode: 0, timedOut: false, signal: null, environment: {} };
      },
    };
    const { streamer, logs } = noopStreamer();
    const { failure } = await runSetupIfNeeded(
      runner,
      streamer,
      logs,
      baseAssign({ setupScript: "prepare" }),
      claim(cwd, undefined, "host-prepare"),
      undefined,
      () => false,
      () => 30_000,
    );
    expect(failure).toBeNull();
    expect(invocation).toBe(2);
    const stdout = logs
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.content)
      .join("");
    expect(stdout).toBe("host line\r\nrepo line\r\n");
  });
});
