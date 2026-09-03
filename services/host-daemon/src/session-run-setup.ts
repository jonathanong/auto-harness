import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import { createChildEnv } from "./child-env.ts";
import { createCrlfNormalizer } from "./crlf-normalize.ts";
import type { ProcessResult, ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { finishClaimedSession, type SessionRunResult } from "./session-outcome.ts";
import { runSetupScript } from "./setup-script.ts";

export type { ClaimedWorktree } from "./worktree-manager.ts";
import type { ClaimedWorktree } from "./worktree-manager.ts";

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
  if (assign.resume || setupScripts.length === 0) return { environment, failure: null };

  const finish = (outcome: Parameters<typeof finishClaimedSession>[5]) =>
    finishClaimedSession(processRunner, streamer, logs, assign, claimed, outcome, childEnvSource);
  const abortedFailure = () =>
    finish({ status: timedOut() ? "timed_out" : "cancelled", exitCode: null });
  const revalidationFailure = (error: unknown) =>
    finish({
      status: "failed",
      exitCode: null,
      errorCode: "setup_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  const stepFailure = (step: ProcessResult, failureMessage: string) => {
    if (step.timedOut || timedOut())
      return finish({ status: "timed_out", exitCode: step.exitCode });
    if (step.cancelled || signal?.aborted)
      return finish({ status: "cancelled", exitCode: step.exitCode });
    if (step.exitCode !== 0) {
      return finish({
        status: "failed",
        exitCode: step.exitCode,
        errorCode: "setup_failed",
        errorMessage: failureMessage,
      });
    }
    return null;
  };

  const setupDeadline = Date.now() + Math.min(remainingMs(), 600_000);
  const remainingStepMs = () => Math.max(1, Math.min(remainingMs(), setupDeadline - Date.now()));

  streamer.write("system", "Running setup script...");
  if (signal?.aborted) return { environment, failure: await abortedFailure() };
  // Setup runs on the plain-piped processRunner (never a PTY), so its stdout/stderr
  // never gets ONLCR's \n -> \r\n. Normalize here so the terminal viewer's xterm.js
  // returns to column 0 on every line, matching what the PTY-backed agent command
  // already gets for free. One normalizer spans both setup scripts below so a
  // \r/\n pair split across the host-setup/repo-setup boundary is still caught.
  const crlf = createCrlfNormalizer();
  for (const setupScript of setupScripts) {
    try {
      await claimed.currentExecutionTarget?.();
    } catch (error) {
      return { environment, failure: await revalidationFailure(error) };
    }
    const setup = await runSetupScript(
      processRunner,
      setupScript,
      claimed.cwd,
      remainingStepMs(),
      (c) => streamer.write(c.stream, crlf(c.stream, c.data)),
      signal,
      environment,
    );
    if (setup.environment) environment = setup.environment;
    const failure = await stepFailure(setup, "setup script failed");
    if (failure) return { environment, failure };
  }
  streamer.write("system", "Setup complete.");

  return { environment, failure: null };
}
