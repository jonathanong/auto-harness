/* eslint-disable max-lines -- execution keeps process teardown and workspace cleanup coordinated. */
import { thrownMessage } from "@auto-harness/shared";
import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";
import { LogStreamer } from "./log-streamer.ts";
import {
  failSession,
  finishClaimedSession,
  harnessSessionResult,
  type SessionRunResult,
} from "./session-outcome.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import type { PriorContextIdentity } from "./prior-context-file.ts";
import type { GitHubAppConfig } from "./github-app.ts";
import type { WorktreeManager } from "./worktree-manager.ts";
import { WorkspaceManager, type ClaimedWorkspace } from "./workspace-manager.ts";

export type { SessionRunResult } from "./session-outcome.ts";

export type SessionRunnerDeps = {
  worktrees: WorktreeManager;
  /** Optional until the workspace-session protocol rolls out everywhere. */
  workspaces?: WorkspaceManager;
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
  /** Optional host-local GitHub App credential source. */
  githubApp?: GitHubAppConfig;
  onLog?: (chunk: SessionLogChunk) => void;
  now?: () => string;
  nowMs?: () => number;
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
    if (isWorkspaceAssign(assign)) return await this.runWorkspace(assign, options);
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
    // The workspace branch above is the sole legal repository-less execution
    // mode. Keep the older worktree/main-checkout path fail-closed on malformed
    // mixed-rollout frames.
    if (!assign.repositoryId) {
      clearTimeout(timeoutTimer);
      return failSession(streamer, logs, "setup_failed", "repositoryId is required", null);
    }
    const repositoryId = assign.repositoryId;

    let claimed;
    let mainClaimed = false;
    try {
      if (assign.worktreeId) {
        claimed = await this.deps.worktrees.claim(repositoryId, assign.worktreeId, signal);
      } else {
        if (!(await this.deps.worktrees.acquireMain(repositoryId, signal))) {
          clearTimeout(timeoutTimer);
          const status = expired ? "timed_out" : "cancelled";
          streamer.writeTimestampedSystem(`Session ${status}`);
          return { status, exitCode: null, result: harnessSessionResult(status), logs };
        }
        mainClaimed = true;
        // The lock can wait behind another session. Resolve the current repository object and
        // realpath-check it only after that wait, immediately before it is used.
        claimed = await this.deps.worktrees.mainClaim(repositoryId, signal);
      }
    } catch (err) {
      if (mainClaimed) this.deps.worktrees.releaseMain(repositoryId);
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
        return await finishClaimedSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimed,
          {
            status: "failed",
            exitCode: null,
            errorCode: "setup_failed",
            errorMessage: thrownMessage(err),
          },
          this.deps.childEnvSource ?? process.env,
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
          this.deps.githubApp,
          this.deps.nowMs,
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
      if (mainClaimed) {
        this.deps.worktrees.releaseMain(assign.repositoryId);
      } else if (assign.worktreeId) {
        this.deps.worktrees.release(assign.worktreeId);
      }
    }
  }

  /** Execute a host-configured non-git workspace without touching Git or repository hooks. */
  private async runWorkspace(
    assign: SessionAssign,
    options: SessionRunOptions,
  ): Promise<SessionRunResult> {
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
    const workspace = workspaceFields(assign);
    if (!workspace || !this.deps.workspaces) {
      return failSession(
        streamer,
        logs,
        "setup_failed",
        "workspace assignment is missing a configured workspace manager or slot",
        null,
      );
    }
    if (assign.resume || assign.priorContext) {
      return failSession(
        streamer,
        logs,
        "setup_failed",
        "workspace sessions do not support resume or prior-session context",
        null,
      );
    }

    let expired = false;
    const timeout = new AbortController();
    const deadlineMs = Date.now() + assign.timeout * 1000;
    const timer = setTimeout(() => {
      expired = true;
      timeout.abort();
    }, assign.timeout * 1000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    let claimed: ClaimedWorkspace | undefined;
    try {
      try {
        claimed = await this.deps.workspaces.claim(workspace.poolId, workspace.slotId, signal);
      } catch (error) {
        if (signal.aborted) {
          const status = expired ? "timed_out" : "cancelled";
          streamer.writeTimestampedSystem(`Session ${status}`);
          return { status, exitCode: null, logs };
        }
        return await failSession(streamer, logs, "setup_failed", thrownMessage(error), null);
      }
      streamer.write("system", `Claimed workspace slot ${claimed.slot.id}`);

      // Reuse the setup/command implementation with a deliberately hookless,
      // repository-free claim. `setupScript` is the control-plane-resolved workspace
      // setup profile; host setup remains first in runSetupIfNeeded.
      const claimedForRun = {
        ...(claimed.hostSetupScript ? { hostSetupScript: claimed.hostSetupScript } : {}),
        repository: { id: "", path: claimed.cwd, defaultBranch: "", worktrees: [] },
        worktree: { id: claimed.slot.id, name: claimed.slot.name, path: claimed.cwd, labels: [] },
        cwd: claimed.cwd,
        allowedRoots: claimed.allowedRoots,
        currentExecutionTarget: claimed.currentExecutionTarget,
        currentHookTarget: async () => null,
      };
      let result: SessionRunResult;
      try {
        result = await runClaimedSession(
          this.deps.processRunner,
          streamer,
          logs,
          assign,
          claimedForRun,
          signal,
          () => expired,
          () => Math.max(1, deadlineMs - Date.now()),
          this.deps.commandRunner ?? this.deps.processRunner,
          this.deps.childEnvSource ?? process.env,
          this.deps.executionProfiles,
          // Workspace sessions intentionally never fetch/write prior context.
          undefined,
        );
      } catch (error) {
        result = await failSession(streamer, logs, "setup_failed", thrownMessage(error), null);
      }
      if (assign.destroyWorkspaceAfter) {
        try {
          await this.deps.workspaces.destroyWorkspaceAfter(claimed);
        } catch (error) {
          const message = `workspace cleanup failed: ${thrownMessage(error)}`;
          streamer.write("system", message);
          streamer.flush();
          if (result.status === "completed") {
            return {
              ...result,
              status: "failed",
              errorCode: "workspace_cleanup_failed",
              errorMessage: message,
              workspaceSlotError: message,
              workspaceSlotId: claimed.slot.id,
            } as SessionRunResult;
          }
          return {
            ...result,
            workspaceSlotError: message,
            workspaceSlotId: claimed.slot.id,
          } as SessionRunResult;
        }
      }
      return { ...result, workspaceSlotId: claimed.slot.id };
    } finally {
      clearTimeout(timer);
      // destroyWorkspaceAfter releases the slot. A failure before it was called
      // (for example an unexpected runner throw) must not strand the slot.
      if (claimed) this.deps.workspaces.release(claimed);
      streamer.flush();
    }
  }
}

type WorkspaceWireFields = { poolId: string; slotId: string };

function workspaceFields(assign: SessionAssign): WorkspaceWireFields | null {
  const wire = assign as SessionAssign & {
    workspacePoolId?: unknown;
    workspaceSlotId?: unknown;
  };
  return typeof wire.workspacePoolId === "string" &&
    wire.workspacePoolId.length > 0 &&
    typeof wire.workspaceSlotId === "string" &&
    wire.workspaceSlotId.length > 0
    ? { poolId: wire.workspacePoolId, slotId: wire.workspaceSlotId }
    : null;
}

function isWorkspaceAssign(assign: SessionAssign): boolean {
  return (assign.sessionType as string | undefined) === "workspace";
}
