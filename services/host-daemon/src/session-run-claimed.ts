import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { RepositoryConfig, WorktreeConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { runSetupScript } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { finishSession, type SessionRunResult } from "./session-outcome.ts";
import { detectUsageLimit } from "./usage-limit.ts";

type ClaimedWorktree = {
  repository: RepositoryConfig;
  worktree: WorktreeConfig;
  cwd: string;
};

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
): Promise<SessionRunResult> {
  const setupFail = await runSetupIfNeeded(processRunner, streamer, logs, assign, claimed);
  if (setupFail) return setupFail;

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
  );
}

async function runSetupIfNeeded(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
): Promise<SessionRunResult | null> {
  const setupScript =
    assign.setupScript ?? claimed.worktree.setupScript ?? claimed.repository.setupScript;
  if (!setupScript || assign.resume) return null;

  streamer.write("system", "Running setup script");
  const setup = await runSetupScript(
    processRunner,
    setupScript,
    claimed.cwd,
    Math.min(assign.timeout * 1000, 600_000),
    (c) => {
      streamer.write(c.stream, c.data);
    },
  );
  if (setup.exitCode === 0) return null;

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

async function runProcessAndFinish(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  argv: string[],
): Promise<SessionRunResult> {
  streamer.write("system", `Spawning: ${argv.join(" ")}`);
  let combined = "";
  const result = await processRunner.run({
    argv,
    cwd: claimed.cwd,
    timeoutMs: assign.timeout * 1000,
    onChunk: (c) => {
      combined += c.data;
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

  if (result.timedOut) {
    return await finish({ status: "timed_out", exitCode: result.exitCode });
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
