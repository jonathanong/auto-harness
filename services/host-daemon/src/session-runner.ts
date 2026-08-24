import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { failSession, finishSession, type SessionRunResult } from "./session-outcome.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
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
  onLog?: (chunk: SessionLogChunk) => void;
  now?: () => string;
};

type SessionRunOptions = {
  /** Cancel requested by the control plane for this assigned session. */
  signal?: AbortSignal;
  /** Sequence after the latest persisted log for a reassigned session. */
  initialLogSeq?: number;
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
    try {
      if (assign.worktreeId) {
        claimed = this.deps.worktrees.claim(assign.repositoryId, assign.worktreeId);
      } else {
        claimed = this.deps.worktrees.mainClaim(assign.repositoryId);
        if (!(await this.deps.worktrees.acquireMain(assign.repositoryId, signal))) {
          clearTimeout(timeoutTimer);
          const status = expired ? "timed_out" : "cancelled";
          streamer.writeTimestampedSystem(`Session ${status}`);
          return { status, exitCode: null, logs };
        }
        mainClaimed = true;
      }
    } catch (err) {
      clearTimeout(timeoutTimer);
      return failSession(
        streamer,
        logs,
        "setup_failed",
        err instanceof Error ? err.message : String(err),
        null,
      );
    }

    try {
      streamer.write(
        "system",
        assign.worktreeId
          ? `Claimed worktree ${claimed.worktree.id}`
          : `Claimed main checkout ${claimed.repository.id}`,
      );

      if (signal.aborted) {
        return await finishSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed.worktree.id,
          claimed.cwd,
          claimed.repository.terminalHookScript,
          { status: expired ? "timed_out" : "cancelled", exitCode: null },
          this.deps.childEnvSource ?? process.env,
        );
      }

      try {
        if (mainClaimed) {
          await this.deps.worktrees.prepareMainCheckout(claimed, assign.ref, signal);
        } else {
          await this.deps.worktrees.prepareCheckout(claimed, assign.ref, signal);
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
          return await finishSession(
            this.deps.processRunner,
            streamer,
            logs,
            assign,
            claimed.worktree.id,
            claimed.cwd,
            claimed.repository.terminalHookScript,
            { status: expired ? "timed_out" : "cancelled", exitCode: null },
            this.deps.childEnvSource ?? process.env,
          );
        }
        return await finishSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed.worktree.id,
          claimed.cwd,
          claimed.repository.terminalHookScript,
          {
            status: "failed",
            exitCode: null,
            errorCode: "setup_failed",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          this.deps.childEnvSource ?? process.env,
        );
      }

      if (signal.aborted) {
        return await finishSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed.worktree.id,
          claimed.cwd,
          claimed.repository.terminalHookScript,
          { status: expired ? "timed_out" : "cancelled", exitCode: null },
          this.deps.childEnvSource ?? process.env,
        );
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
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // A runner error can include the original argv. Keep the transcript
        // useful without copying prompts or other opaque arguments into logs.
        streamer.write("system", "Process execution failed.");
        return await finishSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed.worktree.id,
          claimed.cwd,
          claimed.repository.terminalHookScript,
          { status: "failed", exitCode: null, errorCode: "setup_failed", errorMessage },
          this.deps.childEnvSource ?? process.env,
        );
      }
    } finally {
      streamer.flush();
      clearTimeout(timeoutTimer);
      if (mainClaimed) {
        this.deps.worktrees.releaseMain(assign.repositoryId);
      } else if (assign.worktreeId) {
        this.deps.worktrees.release(assign.worktreeId);
      }
    }
  }
}
