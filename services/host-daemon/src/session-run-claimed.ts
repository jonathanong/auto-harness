import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "./session-run-setup.ts";
import { finishSession, type SessionRunResult } from "./session-outcome.ts";
import { detectUsageLimit } from "./usage-limit.ts";

/**
 * Run setup + command for an already-claimed worktree (checkout already done).
 * argv is resolved control-plane-side (cascade walk + prompt append); the daemon
 * just spawns it. A missing/empty resolvedArgv should be unreachable — the scheduler
 * only assigns worktrees that already resolved a command — but is checked defensively
 * rather than trusted blindly off the wire.
 */
export async function runClaimedSession(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
  remainingMs: () => number,
): Promise<SessionRunResult> {
  const setupFail = await runSetupIfNeeded(
    processRunner,
    streamer,
    logs,
    assign,
    claimed,
    signal,
    timedOut,
    remainingMs,
  );
  if (setupFail) return setupFail;

  if (signal?.aborted) {
    return await finishSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed.worktree.id,
      claimed.cwd,
      claimed.repository.terminalHookScript,
      { status: timedOut() ? "timed_out" : "cancelled", exitCode: null },
    );
  }

  if (assign.resolvedArgv.length === 0) {
    return await finishSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed.worktree.id,
      claimed.cwd,
      claimed.repository.terminalHookScript,
      {
        status: "failed",
        exitCode: null,
        errorCode: "unknown_command_profile",
        errorMessage: "no resolved command argv for this session",
      },
    );
  }

  return await runProcessAndFinish(
    processRunner,
    streamer,
    logs,
    assign,
    claimed,
    assign.resolvedArgv,
    signal,
    timedOut,
    remainingMs,
  );
}

async function runProcessAndFinish(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  argv: string[],
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
  remainingMs: () => number,
): Promise<SessionRunResult> {
  streamer.write("system", `Spawning: ${argv.join(" ")}`);
  let combined = "";
  const result = await processRunner.run({
    argv,
    cwd: claimed.cwd,
    timeoutMs: remainingMs(),
    ...(signal ? { signal } : {}),
    onChunk: (c) => {
      // Usage-limit detection only needs recent output; retaining every byte of
      // a long-running command made daemon memory grow without a bound.
      combined = (combined + c.data).slice(-256 * 1024);
      streamer.write(c.stream, c.data);
    },
  });

  const finish = (outcome: Parameters<typeof finishSession>[7]) =>
    finishSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed.worktree.id,
      claimed.cwd,
      claimed.repository.terminalHookScript,
      outcome,
    );

  if (result.timedOut || timedOut()) {
    return await finish({ status: "timed_out", exitCode: result.exitCode });
  }

  if (result.cancelled || signal?.aborted) {
    return await finish({ status: "cancelled", exitCode: result.exitCode });
  }

  if (detectUsageLimit(combined)) {
    return await finish({
      status: "failed",
      exitCode: result.exitCode,
      errorCode: "usage_limit",
      errorMessage: "Usage limit detected in CLI output",
    });
  }

  if (result.exitCode === 0) {
    return await finish({ status: "completed", exitCode: 0 });
  }

  return await finish({
    status: "failed",
    exitCode: result.exitCode,
    errorMessage: `process exited with code ${String(result.exitCode)}`,
  });
}
