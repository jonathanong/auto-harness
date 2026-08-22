import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "./session-run-setup.ts";
import { finishSession, type SessionRunResult } from "./session-outcome.ts";
import { ResumeRefCaptureReader } from "./resume-ref-capture.ts";
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
  commandRunner: ProcessRunner = processRunner,
): Promise<SessionRunResult> {
  const setup = await runSetupIfNeeded(
    processRunner,
    streamer,
    logs,
    assign,
    claimed,
    signal,
    timedOut,
    remainingMs,
  );
  if (setup.failure) return setup.failure;

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
    commandRunner,
    streamer,
    logs,
    assign,
    claimed,
    assign.resolvedArgv,
    signal,
    timedOut,
    remainingMs,
    setup.environment,
  );
}

async function runProcessAndFinish(
  processRunner: ProcessRunner,
  commandRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  argv: string[],
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
  remainingMs: () => number,
  environment: NodeJS.ProcessEnv,
): Promise<SessionRunResult> {
  streamer.write(
    "system",
    `Spawning: ${argv[0]} (argument count: ${Math.max(0, argv.length - 1)})`,
  );
  let combined = "";
  const capturePolicy =
    commandRunner.outputStreams === "merged" && assign.resumeRefCapture
      ? { ...assign.resumeRefCapture, stream: "either" as const }
      : assign.resumeRefCapture;
  const resumeRef = new ResumeRefCaptureReader(capturePolicy);
  const result = await commandRunner.run({
    argv,
    cwd: claimed.cwd,
    env: environment,
    timeoutMs: remainingMs(),
    ...(signal ? { signal } : {}),
    onChunk: (c) => {
      // Usage-limit detection only needs recent output; retaining every byte of
      // a long-running command made daemon memory grow without a bound.
      combined = (combined + c.data).slice(-256 * 1024);
      const safeContent = resumeRef.push(c.stream, c.data);
      if (safeContent) streamer.write(c.stream, safeContent);
    },
  });
  const cliResumeRef = resumeRef.finish();
  for (const trailing of resumeRef.drainTrailing()) {
    streamer.write(trailing.stream, trailing.content);
  }
  if (cliResumeRef) streamer.write("system", "Captured CLI resume reference");
  streamer.write(
    "system",
    result.exitCode === null
      ? "Process exited without an exit code"
      : `Process exited with code ${String(result.exitCode)}`,
  );

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
    return await finish({
      status: "timed_out",
      exitCode: result.exitCode,
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
  }

  if (result.cancelled || signal?.aborted) {
    return await finish({
      status: "cancelled",
      exitCode: result.exitCode,
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
  }

  if (detectUsageLimit(combined)) {
    return await finish({
      status: "failed",
      exitCode: result.exitCode,
      errorCode: "usage_limit",
      errorMessage: "Usage limit detected in CLI output",
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
  }

  if (result.exitCode === 0) {
    return await finish({
      status: "completed",
      exitCode: 0,
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
  }

  return await finish({
    status: "failed",
    exitCode: result.exitCode,
    errorMessage: `process exited with code ${String(result.exitCode)}`,
    ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  });
}
