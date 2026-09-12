/* eslint-disable max-lines -- checkout, deferred-hook, and claim-release ordering share one fence. */
import { thrownMessage } from "@auto-harness/shared";
import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";
import { LogStreamer } from "./log-streamer.ts";
import { isCheckoutFetchFailure } from "./git-commands.ts";
import { retainClaimForDeferredTerminalHook } from "./deferred-terminal-hook.ts";
import {
  failSession,
  finishClaimedSession,
  harnessSessionResult,
  type SessionRunResult,
} from "./session-outcome.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import type { PriorContextIdentity } from "./prior-context-file.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

export type { SessionRunResult } from "./session-outcome.ts";

export type SessionRunnerDeps = {
  worktrees: WorktreeManager;
  /** Pipe-based runner for git, setup scripts, and terminal hooks. */
  processRunner: ProcessRunner;
  /** PTY-backed runner for the assigned AI CLI; defaults to processRunner for injected tests. */
  commandRunner?: ProcessRunner;
  /** Daemon environment after loading the persisted service environment file. */
  childEnvSource?: NodeJS.ProcessEnv;
  /** Daemon-local CLI homes; never forwarded to the control plane. */
  executionProfiles?: ExecutionProfiles;
  /** Used only to fetch `assign.priorContext`; never forwarded to the CLI. */
  identity?: PriorContextIdentity;
  onLog?: (chunk: SessionLogChunk) => void;
  now?: () => string;
  /** Durable control-plane authorization immediately before the primary CLI starts. */
  authorizeCommandStart?: (assign: SessionAssign, signal?: AbortSignal) => Promise<boolean>;
};

type SessionRunOptions = {
  /** Cancel requested by the control plane for this assigned session. */
  signal?: AbortSignal;
  /** Sequence after the latest persisted log for a reassigned session. */
  initialLogSeq?: number;
  /** A v6 peer durably coordinates retry disposition, terminal hook, and post-hook result. */
  deferCheckoutFetchFailureHook?: boolean;
};

export class SessionRunner {
  private readonly deps: SessionRunnerDeps;

  constructor(deps: SessionRunnerDeps) {
    this.deps = deps;
  }

  async run(assign: SessionAssign, options: SessionRunOptions = {}): Promise<SessionRunResult> {
    const logs: SessionLogChunk[] = [];
    const streamer = new LogStreamer(
      assign.sessionId,
      assign.attemptId,
      (chunk) => {
        logs.push(chunk);
        this.deps.onLog?.(chunk);
      },
      this.deps.now,
      options.initialLogSeq,
    );
    streamer.writeTimestampedSystem("Session started");

    let expired = false;
    const timeout = new AbortController();
    const deadlineMs = Date.now() + assign.timeout * 1000;
    const timeoutTimer = setTimeout(() => {
      expired = true;
      timeout.abort();
    }, assign.timeout * 1000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;

    if (!assign.worktreeId && assign.sessionType !== "scheduled") {
      clearTimeout(timeoutTimer);
      return failSession(
        streamer,
        logs,
        "setup_failed",
        "main checkout sessions must be scheduled",
        null,
      );
    }

    let claimed;
    let mainClaimed = false;
    let retainedClaim = false;
    try {
      if (assign.worktreeId) {
        claimed = await this.deps.worktrees.claim(assign.repositoryId, assign.worktreeId, signal);
      } else {
        if (!(await this.deps.worktrees.acquireMain(assign.repositoryId, signal))) {
          clearTimeout(timeoutTimer);
          const status = expired ? "timed_out" : "cancelled";
          streamer.writeTimestampedSystem(`Session ${status}`);
          return { status, exitCode: null, result: harnessSessionResult(status), logs };
        }
        mainClaimed = true;
        // The lock can wait behind another session. Resolve the current repository object and
        // realpath-check it only after that wait, immediately before it is used.
        claimed = await this.deps.worktrees.mainClaim(assign.repositoryId, signal);
      }
    } catch (err) {
      if (mainClaimed) this.deps.worktrees.releaseMain(assign.repositoryId);
      clearTimeout(timeoutTimer);
      if (signal.aborted) {
        streamer.flush();
        const status = expired ? "timed_out" : "cancelled";
        streamer.writeTimestampedSystem(`Session ${status}`);
        return { status, exitCode: null, result: harnessSessionResult(status), logs };
      }
      return failSession(streamer, logs, "setup_failed", thrownMessage(err), null);
    }

    try {
      streamer.write(
        "system",
        assign.worktreeId
          ? `Claimed worktree ${claimed.worktree.id}`
          : `Claimed main checkout ${claimed.repository.id}`,
      );

      const checkoutRef = assign.ref ?? claimed.repository.defaultBranch;
      let baseline: string | undefined;
      const finishCheckoutInterruption = () =>
        finishClaimedSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed,
          {
            status: expired ? "timed_out" : "cancelled",
            exitCode: null,
            ...(expired
              ? { errorMessage: `Session timed out while checking out ref ${checkoutRef}` }
              : {}),
          },
          this.deps.childEnvSource ?? process.env,
          baseline,
        );
      streamer.write("system", `Checking out ref ${checkoutRef}...`);

      if (signal.aborted) {
        return await finishCheckoutInterruption();
      }

      try {
        if (mainClaimed) {
          baseline = await this.deps.worktrees.prepareMainCheckout(claimed, assign.ref, signal);
        } else {
          baseline = await this.deps.worktrees.prepareCheckout(claimed, assign.ref, signal);
        }
        streamer.write(
          "system",
          `Checked out ref ${assign.ref ?? claimed.repository.defaultBranch}`,
        );
      } catch (err) {
        // A checkout can reject because its git child was aborted. Preserve the
        // requested terminal state instead of misreporting cancellation as a
        // checkout/setup failure.
        if (signal.aborted) {
          return await finishCheckoutInterruption();
        }
        const result = await finishClaimedSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed,
          {
            status: "failed",
            exitCode: null,
            errorCode: isCheckoutFetchFailure(err) ? "checkout_fetch_failed" : "setup_failed",
            errorMessage: thrownMessage(err),
            deferTerminalHook:
              isCheckoutFetchFailure(err) &&
              assign.infrastructureRetryCount === 0 &&
              options.deferCheckoutFetchFailureHook === true,
          },
          this.deps.childEnvSource ?? process.env,
        );
        if (!result.settleDeferredTerminalHook) return result;
        retainedClaim = true;
        return retainClaimForDeferredTerminalHook(
          result as Required<Pick<SessionRunResult, "settleDeferredTerminalHook">> &
            SessionRunResult,
          () => {
            if (mainClaimed) this.deps.worktrees.releaseMain(assign.repositoryId);
            else this.deps.worktrees.release(assign.worktreeId!);
          },
        );
      }
      if (signal.aborted) {
        return await finishCheckoutInterruption();
      }

      try {
        return await runClaimedSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed,
          signal,
          () => expired,
          () => Math.max(1, deadlineMs - Date.now()),
          this.deps.commandRunner ?? this.deps.processRunner,
          this.deps.childEnvSource ?? process.env,
          this.deps.executionProfiles,
          this.deps.identity,
          this.deps.authorizeCommandStart,
          baseline,
        );
      } catch (error) {
        const errorMessage = thrownMessage(error);
        // A runner error can include the original argv. Keep the transcript
        // useful without copying prompts or other opaque arguments into logs.
        streamer.write("system", "Process execution failed.");
        return await finishClaimedSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed,
          { status: "failed", exitCode: null, errorCode: "setup_failed", errorMessage },
          this.deps.childEnvSource ?? process.env,
          baseline,
        );
      }
    } finally {
      streamer.flush();
      clearTimeout(timeoutTimer);
      if (!retainedClaim) {
        if (mainClaimed) this.deps.worktrees.releaseMain(assign.repositoryId);
        else this.deps.worktrees.release(assign.worktreeId!);
      }
    }
  }
}
