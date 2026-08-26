import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import { createChildEnv } from "./child-env.ts";
import {
  installWorkspaceDependencies,
  invalidateImportMethodMarker,
  isPnpmWorkspace,
} from "./dependency-install.ts";
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
  const mayNeedDependencyInstall = !assign.resume && isPnpmWorkspace(claimed.cwd);
  if (assign.resume || (setupScripts.length === 0 && !mayNeedDependencyInstall)) {
    return { environment, failure: null };
  }

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

  if (setupScripts.length > 0) {
    // A setup script can run its own uninstrumented `pnpm install`, which
    // would resolve pnpm's unpinned auto/hardlink default and re-alias this
    // worktree's node_modules — but leave the daemon's own "copy" marker
    // from a prior install untouched. Invalidate it before any setup script
    // runs, so the install below this block can never wrongly trust a
    // marker whose claim a setup script had the chance to invalidate
    // (jonathanong/auto-harness#350 Codex review).
    invalidateImportMethodMarker(claimed.cwd);
    streamer.write("system", "Running setup script...");
    if (signal?.aborted) return { environment, failure: await abortedFailure() };
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
        (c) => streamer.write(c.stream, c.data),
        signal,
        environment,
      );
      if (setup.environment) environment = setup.environment;
      const failure = await stepFailure(setup, "setup script failed");
      if (failure) return { environment, failure };
    }
    streamer.write("system", "Setup complete.");
  }

  // Re-check after setup scripts run: a script may check out a different ref
  // and add or remove the lockfile, so the pre-setup snapshot can be stale.
  if (!assign.resume && isPnpmWorkspace(claimed.cwd)) {
    if (signal?.aborted) return { environment, failure: await abortedFailure() };
    try {
      await claimed.currentExecutionTarget?.();
    } catch (error) {
      return { environment, failure: await revalidationFailure(error) };
    }
    streamer.write("system", "Installing workspace dependencies...");
    // Independent deadline: setup scripts may have already spent most of
    // setupDeadline, but that says nothing about how much session time is
    // actually left. Cap the install off the *current* remaining session
    // time instead of reusing the pre-setup-loop deadline, so a slow setup
    // script doesn't silently starve the install step.
    const installDeadline = Date.now() + Math.min(remainingMs(), 600_000);
    const remainingInstallMs = () =>
      Math.max(1, Math.min(remainingMs(), installDeadline - Date.now()));
    const install = await installWorkspaceDependencies(
      processRunner,
      claimed.cwd,
      remainingInstallMs(),
      (c) => streamer.write(c.stream, c.data),
      signal,
      environment,
    );
    const failure = await stepFailure(install, "workspace dependency install failed");
    if (failure) return { environment, failure };
    streamer.write("system", "Workspace dependencies installed.");
  }

  return { environment, failure: null };
}
