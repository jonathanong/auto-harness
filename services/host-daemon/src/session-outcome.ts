import { normalizeSessionResult, thrownMessage } from "@auto-harness/shared";
import type {
  SessionAssign,
  SessionErrorCode,
  SessionLogChunk,
  SessionStatus,
  SessionTerminalStatus,
} from "@auto-harness/shared";
import type { SessionUsage } from "@auto-harness/shared";
import type { SessionResult } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { createDeferredTerminalHookSettlement } from "./deferred-terminal-hook.ts";
import { runTerminalHook } from "./terminal-hook.ts";
import { collectSessionResult } from "./session-result.ts";

export type SessionRunResult = {
  status: SessionTerminalStatus;
  exitCode: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
  result?: SessionResult;
  /** Settles a retained first-fetch-failure hook before its worktree claim releases. */
  settleDeferredTerminalHook?: (runHook: boolean) => Promise<SessionResult | undefined>;
  logs: SessionLogChunk[];
};

type SessionOutcome = {
  status: SessionTerminalStatus;
  exitCode: number | null;
  deferTerminalHook?: boolean;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
  agentSummary?: string;
};

type ClaimedHookTarget = {
  worktree: { id: string };
  cwd: string;
  repository: { terminalHookScript?: string };
  allowedRoots?: readonly string[];
  currentHookTarget: () => Promise<{
    cwd: string;
    repository: { terminalHookScript?: string };
    allowedRoots?: readonly string[];
  } | null>;
};

/** Every daemon-owned terminal path has a queryable fallback, even without a checkout. */
export function harnessSessionResult(status: SessionTerminalStatus): SessionResult {
  return { summary: `Session ${status}`, summarySource: "harness" };
}

/** A stale claim can still report the agent's own outcome without probing its old checkout. */
function summaryOnlySessionResult(outcome: SessionOutcome): SessionResult {
  const summary = outcome.agentSummary?.trim();
  return summary
    ? normalizeSessionResult({ summary, summarySource: "agent" })!
    : harnessSessionResult(outcome.status);
}

export async function failSession(
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  errorCode: SessionErrorCode,
  errorMessage: string,
  exitCode: number | null,
): Promise<SessionRunResult> {
  streamer.flush();
  streamer.write("system", errorMessage);
  streamer.writeTimestampedSystem("Session failed");
  return {
    status: "failed",
    exitCode,
    errorCode,
    errorMessage,
    result: harnessSessionResult("failed"),
    logs,
  };
}

async function finishSession(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  worktreeId: string,
  worktreePath: string,
  hookScript: string | undefined,
  outcome: SessionOutcome,
  childEnvSource: NodeJS.ProcessEnv = process.env,
  allowedRoots: readonly string[] = [],
  baseline?: string,
  canProbeResult = true,
  environmentIsChild = false,
): Promise<SessionRunResult> {
  streamer.flush();
  if (hookScript) {
    await runTerminalHook(processRunner, {
      scriptPath: hookScript,
      cwd: worktreePath,
      sessionId: assign.sessionId,
      status: outcome.status as SessionStatus,
      worktreePath,
      childEnvSource,
      ...(allowedRoots.length ? { allowedRoots } : {}),
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      ...(assign.ref !== undefined ? { ref: assign.ref } : {}),
      ...(assign.metadata !== undefined ? { metadata: assign.metadata } : {}),
    });
  }
  streamer.writeTimestampedSystem(`Session ${outcome.status}`);
  const result =
    canProbeResult && (baseline !== undefined || outcome.agentSummary !== undefined)
      ? await collectSessionResult({
          runner: processRunner,
          cwd: worktreePath,
          status: outcome.status,
          ...(baseline !== undefined ? { baseline } : {}),
          ...(outcome.agentSummary !== undefined ? { agentSummary: outcome.agentSummary } : {}),
          environment: childEnvSource,
          ...(environmentIsChild ? { environmentIsChild: true } : {}),
        })
      : canProbeResult
        ? harnessSessionResult(outcome.status)
        : summaryOnlySessionResult(outcome);
  void worktreeId;
  return {
    status: outcome.status,
    exitCode: outcome.exitCode,
    logs,
    ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
    ...(outcome.cliResumeRef !== undefined ? { cliResumeRef: outcome.cliResumeRef } : {}),
    ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    result,
  };
}

export async function finishClaimedSession(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedHookTarget,
  outcome: SessionOutcome,
  childEnvSource: NodeJS.ProcessEnv = process.env,
  baseline?: string,
  environmentIsChild = false,
): Promise<SessionRunResult> {
  let refreshed: Awaited<ReturnType<ClaimedHookTarget["currentHookTarget"]>> | undefined;
  try {
    refreshed = await claimed.currentHookTarget?.();
  } catch (error) {
    streamer.write(
      "system",
      `terminal hook revalidation failed for session ${assign.sessionId}: ${thrownMessage(error)}`,
    );
    refreshed = null;
  }
  const target = refreshed;
  const finish = await finishSession(
    processRunner,
    streamer,
    logs,
    assign,
    claimed.worktree.id,
    target?.cwd ?? claimed.cwd,
    outcome.deferTerminalHook ? undefined : target?.repository.terminalHookScript,
    outcome,
    childEnvSource,
    target?.allowedRoots ?? [],
    baseline,
    // The first checkout failure must not publish pre-hook facts: a v6 peer
    // turns the terminal disposition into a durable hook handoff and archives
    // only its post-hook completion result.
    !outcome.deferTerminalHook && target !== null && target !== undefined,
    environmentIsChild,
  );
  if (!outcome.deferTerminalHook) return finish;
  const { result: _result, ...deferredFinish } = finish;
  return {
    ...deferredFinish,
    settleDeferredTerminalHook: createDeferredTerminalHookSettlement({
      processRunner,
      streamer,
      assign,
      claimed,
      status: outcome.status,
      errorCode: outcome.errorCode,
      childEnvSource,
      ...(baseline !== undefined ? { baseline } : {}),
      environmentIsChild,
    }),
  };
}
