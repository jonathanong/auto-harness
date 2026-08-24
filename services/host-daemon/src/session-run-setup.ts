import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import { createChildEnv } from "./child-env.ts";
import type { RepositoryConfig, WorktreeConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { finishClaimedSession, type SessionRunResult } from "./session-outcome.ts";
import { runSetupScript } from "./setup-script.ts";

export type ClaimedWorktree = {
  hostSetupScript?: string;
  repository: RepositoryConfig;
  worktree: WorktreeConfig;
  cwd: string;
  allowedRoots?: string[];
  /** Re-check daemon inventory policy at each executable boundary. */
  currentExecutionTarget?: () => Promise<void>;
};

type SessionSetupResult = {
  environment: NodeJS.ProcessEnv;
  failure: SessionRunResult | null;
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
  childEnvSource: NodeJS.ProcessEnv = process.env,
): Promise<SessionSetupResult> {
  let environment = createChildEnv(childEnvSource);
  const scopedSetupScript =
    assign.setupScript ?? claimed.worktree.setupScript ?? claimed.repository.setupScript;
  const setupScripts = [claimed.hostSetupScript, scopedSetupScript].filter(
    (script): script is string => Boolean(script),
  );
  if (setupScripts.length === 0 || assign.resume) return { environment, failure: null };

  streamer.write("system", "Running setup script...");
  if (signal?.aborted) {
    return {
      environment,
      failure: await finishClaimedSession(
        processRunner,
        streamer,
        logs,
        assign,
        claimed,
        { status: timedOut() ? "timed_out" : "cancelled", exitCode: null },
        childEnvSource,
      ),
    };
  }
  const setupDeadline = Date.now() + Math.min(remainingMs(), 600_000);
  for (const setupScript of setupScripts) {
    const setup = await runSetupScript(
      processRunner,
      setupScript,
      claimed.cwd,
      Math.max(1, Math.min(remainingMs(), setupDeadline - Date.now())),
      (c) => {
        streamer.write(c.stream, c.data);
      },
      signal,
      environment,
    );
    if (setup.environment) environment = setup.environment;
    if (setup.timedOut || timedOut()) {
      return {
        environment,
        failure: await finishClaimedSession(
          processRunner,
          streamer,
          logs,
          assign,
          claimed,
          { status: "timed_out", exitCode: setup.exitCode },
          childEnvSource,
        ),
      };
    }
    if (setup.cancelled || signal?.aborted) {
      return {
        environment,
        failure: await finishClaimedSession(
          processRunner,
          streamer,
          logs,
          assign,
          claimed,
          { status: "cancelled", exitCode: setup.exitCode },
          childEnvSource,
        ),
      };
    }
    if (setup.exitCode !== 0) {
      return {
        environment,
        failure: await finishClaimedSession(
          processRunner,
          streamer,
          logs,
          assign,
          claimed,
          {
            status: "failed",
            exitCode: setup.exitCode,
            errorCode: "setup_failed",
            errorMessage: "setup script failed",
          },
          childEnvSource,
        ),
      };
    }
  }

  streamer.write("system", "Setup complete.");
  return { environment, failure: null };
}
