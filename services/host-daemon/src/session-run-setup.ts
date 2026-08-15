import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { RepositoryConfig, WorktreeConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { runSetupScript } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { finishSession, type SessionRunResult } from "./session-outcome.ts";

export type ClaimedWorktree = {
  repository: RepositoryConfig;
  worktree: WorktreeConfig;
  cwd: string;
};

export async function runSetupIfNeeded(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
  remainingMs: () => number,
): Promise<SessionRunResult | null> {
  const setupScript =
    assign.setupScript ?? claimed.worktree.setupScript ?? claimed.repository.setupScript;
  if (!setupScript || assign.resume) return null;

  streamer.write("system", "Running setup script...");
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
  const setup = await runSetupScript(
    processRunner,
    setupScript,
    claimed.cwd,
    Math.min(remainingMs(), 600_000),
    (c) => {
      streamer.write(c.stream, c.data);
    },
    signal,
  );
  if (setup.timedOut || timedOut()) {
    return await finishSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed.worktree.id,
      claimed.cwd,
      claimed.repository.terminalHookScript,
      { status: "timed_out", exitCode: setup.exitCode },
    );
  }
  if (setup.cancelled || signal?.aborted) {
    return await finishSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed.worktree.id,
      claimed.cwd,
      claimed.repository.terminalHookScript,
      { status: "cancelled", exitCode: setup.exitCode },
    );
  }
  if (setup.exitCode === 0) {
    streamer.write("system", "Setup complete.");
    return null;
  }

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
      exitCode: setup.exitCode,
      errorCode: "setup_failed",
      errorMessage: "setup script failed",
    },
  );
}
