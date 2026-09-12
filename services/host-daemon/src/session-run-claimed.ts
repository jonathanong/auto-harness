/* eslint-disable max-lines -- claimed run covers setup, profile env, and terminal outcomes. */
import { thrownMessage } from "@auto-harness/shared";
import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessResult, ProcessRunner } from "./executor.ts";
import {
  applyExecutionProfile,
  emptyExecutionProfiles,
  executionProfileReady,
  resolveExecutionProfile,
  type ExecutionProfiles,
} from "./execution-profiles.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "./session-run-setup.ts";
import { finishClaimedSession, type SessionRunResult } from "./session-outcome.ts";
import { ResumeRefCaptureReader } from "./resume-ref-capture.ts";
import { detectUsageLimit } from "./usage-limit.ts";
import {
  removePriorContextFile,
  writePriorContextFile,
  type PriorContextIdentity,
} from "./prior-context-file.ts";

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
  childEnvSource: NodeJS.ProcessEnv = process.env,
  executionProfiles: ExecutionProfiles = emptyExecutionProfiles(),
  /** Daemon identity used only to fetch `assign.priorContext`; never forwarded to the CLI. */
  identity?: PriorContextIdentity,
  /** Durable control-plane authorization immediately before the primary CLI starts. */
  authorizeCommandStart?: (assign: SessionAssign, signal?: AbortSignal) => Promise<boolean>,
  /** HEAD captured after checkout and before setup; used for post-session facts. */
  baseline?: string,
): Promise<SessionRunResult> {
  try {
    await claimed.currentExecutionTarget?.();
  } catch (error) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorCode: "setup_failed",
        errorMessage: thrownMessage(error),
      },
      childEnvSource,
      baseline,
    );
  }
  const setup = await runSetupIfNeeded(
    processRunner,
    streamer,
    logs,
    assign,
    claimed,
    signal,
    timedOut,
    remainingMs,
    childEnvSource,
    baseline,
  );
  if (setup.failure) return setup.failure;

  try {
    await claimed.currentExecutionTarget?.();
  } catch (error) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorCode: "setup_failed",
        errorMessage: thrownMessage(error),
      },
      setup.environment,
      baseline,
      true,
    );
  }

  if (signal?.aborted) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      { status: timedOut() ? "timed_out" : "cancelled", exitCode: null },
      setup.environment,
      baseline,
      true,
    );
  }

  if (assign.resolvedArgv.length === 0) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorCode: "unknown_command_profile",
        errorMessage: "no resolved command argv for this session",
      },
      setup.environment,
      baseline,
      true,
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
    executionProfiles,
    identity,
    authorizeCommandStart,
    baseline,
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
  executionProfiles: ExecutionProfiles = emptyExecutionProfiles(),
  identity?: PriorContextIdentity,
  authorizeCommandStart?: (assign: SessionAssign, signal?: AbortSignal) => Promise<boolean>,
  baseline?: string,
): Promise<SessionRunResult> {
  const capturePolicy =
    commandRunner.outputStreams === "merged" && assign.resumeRefCapture
      ? { ...assign.resumeRefCapture, stream: "either" as const }
      : assign.resumeRefCapture;
  const resumeRef = new ResumeRefCaptureReader(capturePolicy);
  const profile = resolveExecutionProfile(executionProfiles, assign.providerAccountId);
  if (assign.providerAccountId && (!profile || !executionProfileReady(profile))) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorMessage: `execution profile unavailable for ${assign.providerAccountId}`,
      },
      environment,
      baseline,
      true,
    );
  }
  const commandEnv = profile ? applyExecutionProfile(environment, profile) : environment;
  // Written after setup (which may `git clean`/reset the checkout — resumeWireFields omits
  // `resume: true` for a fallback, so setup still runs) and removed once the process exits.
  const priorContextPath =
    assign.priorContext && identity
      ? await writePriorContextFile({
          cwd: claimed.cwd,
          sessionId: assign.sessionId,
          identity,
          ...(claimed.allowedRoots ? { allowedRoots: claimed.allowedRoots } : {}),
          onLog: (message) => streamer.write("system", message),
          ...(signal ? { signal } : {}),
          timeoutMs: Math.max(0, remainingMs()),
        })
      : null;
  if (priorContextPath) streamer.write("system", "Wrote prior-session context for this run");
  const spawnEnv = priorContextPath
    ? { ...commandEnv, HARNESS_PRIOR_CONTEXT_FILE: priorContextPath }
    : commandEnv;
  const finish = async (outcome: Parameters<typeof finishClaimedSession>[5]) => {
    // Terminal hooks run as part of finishClaimedSession. Do not expose the previous
    // session's transcript to a hook, which is neither the assigned CLI nor part of
    // its child environment.
    await removePriorContextFile(priorContextPath);
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      outcome,
      environment,
      baseline,
      true,
    );
  };
  const executeAuthorized = async (): Promise<SessionRunResult> => {
    try {
      const authorized = (await authorizeCommandStart?.(assign, signal)) ?? !signal?.aborted;
      if (!authorized || signal?.aborted) {
        return await finish({
          status: timedOut() ? "timed_out" : "cancelled",
          exitCode: null,
        });
      }
    } catch (error) {
      return await finish({
        status: "failed",
        exitCode: null,
        errorCode: "setup_failed",
        errorMessage: thrownMessage(error),
      });
    }
    streamer.write(
      "system",
      `Spawning: ${argv[0]} (argument count: ${Math.max(0, argv.length - 1)})`,
    );
    const result: ProcessResult = await commandRunner.run({
      argv,
      cwd: claimed.cwd,
      env: spawnEnv,
      timeoutMs: remainingMs(),
      ...(signal ? { signal } : {}),
      onChunk: (c) => {
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

    if (result.timedOut || timedOut()) {
      return await finish({
        status: "timed_out",
        exitCode: result.exitCode,
        ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.agentSummary !== undefined ? { agentSummary: result.agentSummary } : {}),
      });
    }

    if (result.cancelled || signal?.aborted) {
      return await finish({
        status: "cancelled",
        exitCode: result.exitCode,
        ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.agentSummary !== undefined ? { agentSummary: result.agentSummary } : {}),
      });
    }

    if (result.exitCode === 0) {
      return await finish({
        status: "completed",
        exitCode: 0,
        ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.agentSummary !== undefined ? { agentSummary: result.agentSummary } : {}),
      });
    }

    const usageLimit = detectUsageLimit({
      argv,
      failed: true,
      ...(assign.providerAccountId ? { providerAccountId: assign.providerAccountId } : {}),
      ...(result.usageLimit === true ? { adapterUsageLimit: true } : {}),
    });
    if (usageLimit) {
      return await finish({
        status: "failed",
        exitCode: result.exitCode,
        errorCode: "usage_limit",
        errorMessage: "Usage limit detected",
        ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.agentSummary !== undefined ? { agentSummary: result.agentSummary } : {}),
      });
    }

    return await finish({
      status: "failed",
      exitCode: result.exitCode,
      errorMessage: `process exited with code ${String(result.exitCode)}`,
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.agentSummary !== undefined ? { agentSummary: result.agentSummary } : {}),
    });
  };
  try {
    return await executeAuthorized();
  } finally {
    // Must run for every authorization outcome as well as process failures — otherwise
    // denied starts leave prior session context in the reused worktree.
    await removePriorContextFile(priorContextPath);
  }
}
