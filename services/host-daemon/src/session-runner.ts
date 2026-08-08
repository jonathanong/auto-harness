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

export class SessionRunner {
  private readonly deps: SessionRunnerDeps;

  constructor(deps: SessionRunnerDeps) {
    this.deps = deps;
  }

  async run(assign: SessionAssign): Promise<SessionRunResult> {
    const logs: SessionLogChunk[] = [];
    const streamer = new LogStreamer(
      assign.sessionId,
      (chunk) => {
        logs.push(chunk);
        this.deps.onLog?.(chunk);
      },
      this.deps.now,
    );

    if (!assign.worktreeId) {
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

      try {
        await this.deps.worktrees.prepareCheckout(claimed, assign.ref);
        streamer.write(
          "system",
          `Checked out ref ${assign.ref ?? claimed.repository.defaultBranch}`,
        );
      } catch (err) {
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

      return await runClaimedSession(this.deps.processRunner, streamer, logs, assign, claimed);
    } finally {
      this.deps.worktrees.release(assign.worktreeId);
    }
  }
}
