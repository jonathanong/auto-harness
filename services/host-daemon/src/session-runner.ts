import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { failSession, finishSession, type SessionRunResult } from "./session-outcome.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

export type { SessionRunResult } from "./session-outcome.ts";

export type SessionRunnerDeps = {
  worktrees: WorktreeManager;
  processRunner: ProcessRunner;
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
      (chunk) => {
        logs.push(chunk);
        this.deps.onLog?.(chunk);
      },
      this.deps.now,
      options.initialLogSeq,
    );

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

    if (!assign.worktreeId) {
      clearTimeout(timeoutTimer);
      return failSession(
        streamer,
        logs,
        "setup_failed",
        "scheduled/main-checkout sessions are not implemented in Phase 1 local runner",
        null,
      );
    }

    let claimed;
    try {
      claimed = this.deps.worktrees.claim(assign.repositoryId, assign.worktreeId);
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
      streamer.write("system", `Claimed worktree ${claimed.worktree.id}`);

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
        );
      }

      try {
        await this.deps.worktrees.prepareCheckout(claimed, assign.ref, signal);
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
        );
      }

      return await runClaimedSession(
        this.deps.processRunner,
        streamer,
        logs,
        assign,
        claimed,
        signal,
        () => expired,
        () => Math.max(1, deadlineMs - Date.now()),
      );
    } finally {
      clearTimeout(timeoutTimer);
      this.deps.worktrees.release(assign.worktreeId);
    }
  }
}
