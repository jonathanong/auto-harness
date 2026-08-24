import type {
  SessionAssign,
  SessionErrorCode,
  SessionLogChunk,
  SessionStatus,
  SessionTerminalStatus,
} from "@auto-harness/shared";
import type { SessionUsage } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { runTerminalHook } from "./terminal-hook.ts";

export type SessionRunResult = {
  status: SessionTerminalStatus;
  exitCode: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
  logs: SessionLogChunk[];
};

type SessionOutcome = {
  status: SessionTerminalStatus;
  exitCode: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
};

type ClaimedHookTarget = {
  worktree: { id: string };
  cwd: string;
  repository: { path: string; terminalHookScript?: string };
  allowedRoots?: readonly string[];
  currentHookTarget?: () => Promise<{
    cwd: string;
    repository: { path: string; terminalHookScript?: string };
    allowedRoots?: readonly string[];
  } | null>;
};

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
  repositoryPath?: string,
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
      ...(repositoryPath !== undefined ? { repositoryPath } : {}),
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      ...(assign.ref !== undefined ? { ref: assign.ref } : {}),
      ...(assign.metadata !== undefined ? { metadata: assign.metadata } : {}),
    });
  }
  streamer.writeTimestampedSystem(`Session ${outcome.status}`);
  void worktreeId;
  return {
    status: outcome.status,
    exitCode: outcome.exitCode,
    logs,
    ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
    ...(outcome.cliResumeRef !== undefined ? { cliResumeRef: outcome.cliResumeRef } : {}),
    ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
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
): Promise<SessionRunResult> {
  let refreshed:
    | Awaited<ReturnType<NonNullable<ClaimedHookTarget["currentHookTarget"]>>>
    | undefined;
  try {
    refreshed = await claimed.currentHookTarget?.();
  } catch {
    refreshed = null;
  }
  const target = refreshed ?? (claimed.currentHookTarget ? null : claimed);
  return finishSession(
    processRunner,
    streamer,
    logs,
    assign,
    claimed.worktree.id,
    target?.cwd ?? claimed.cwd,
    target?.repository.terminalHookScript,
    outcome,
    childEnvSource,
    target?.allowedRoots ?? [],
    target?.repository.path ?? claimed.repository.path,
  );
}
