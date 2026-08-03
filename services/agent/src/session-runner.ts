import type {
  SessionAssign,
  SessionErrorCode,
  SessionLogChunk,
  SessionStatus,
  SessionTerminalStatus,
} from "@auto-harness/shared";

import { resolveCommandArgv, UnknownCommandProfileError } from "./command-profiles.ts";
import type { AgentConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { runSetupScript } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runTerminalHook } from "./terminal-hook.ts";
import { detectUsageLimit } from "./usage-limit.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

export type SessionRunResult = {
  status: SessionTerminalStatus;
  exitCode: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  logs: SessionLogChunk[];
};

export type SessionRunnerDeps = {
  config: AgentConfig;
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
      return this.fail(
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
      return this.fail(
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
        return await this.finish(
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

      const setupScript =
        assign.setupScript ?? claimed.worktree.setupScript ?? claimed.repository.setupScript;
      if (setupScript && !assign.resume) {
        streamer.write("system", "Running setup script");
        const setup = await runSetupScript(
          this.deps.processRunner,
          setupScript,
          claimed.cwd,
          Math.min(assign.timeout * 1000, 600_000),
          (c) => {
            streamer.write(c.stream, c.data);
          },
        );
        if (setup.exitCode !== 0) {
          return await this.finish(
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
      }

      let argv: string[];
      try {
        argv = resolveCommandArgv(
          this.deps.config.commandProfiles,
          assign.commandProfile,
          assign.prompt,
        );
      } catch (err) {
        const message =
          err instanceof UnknownCommandProfileError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return await this.finish(
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
            errorMessage: message,
          },
        );
      }

      streamer.write("system", `Spawning: ${argv.join(" ")}`);
      let combined = "";
      const result = await this.deps.processRunner.run({
        argv,
        cwd: claimed.cwd,
        timeoutMs: assign.timeout * 1000,
        onChunk: (c) => {
          combined += c.data;
          streamer.write(c.stream, c.data);
        },
      });

      if (result.timedOut) {
        return await this.finish(
          streamer,
          logs,
          assign,
          claimed.worktree.id,
          claimed.cwd,
          claimed.repository.terminalHookScript,
          { status: "timed_out", exitCode: result.exitCode },
        );
      }

      if (detectUsageLimit(combined)) {
        return await this.finish(
          streamer,
          logs,
          assign,
          claimed.worktree.id,
          claimed.cwd,
          claimed.repository.terminalHookScript,
          {
            status: "failed",
            exitCode: result.exitCode,
            errorCode: "usage_limit",
            errorMessage: "Usage limit detected in CLI output",
          },
        );
      }

      if (result.exitCode === 0) {
        return await this.finish(
          streamer,
          logs,
          assign,
          claimed.worktree.id,
          claimed.cwd,
          claimed.repository.terminalHookScript,
          { status: "completed", exitCode: 0 },
        );
      }

      return await this.finish(
        streamer,
        logs,
        assign,
        claimed.worktree.id,
        claimed.cwd,
        claimed.repository.terminalHookScript,
        {
          status: "failed",
          exitCode: result.exitCode,
          errorMessage: `process exited with code ${String(result.exitCode)}`,
        },
      );
    } finally {
      this.deps.worktrees.release(assign.worktreeId);
    }
  }

  private async fail(
    streamer: LogStreamer,
    logs: SessionLogChunk[],
    errorCode: SessionErrorCode,
    errorMessage: string,
    exitCode: number | null,
  ): Promise<SessionRunResult> {
    streamer.write("system", errorMessage);
    return {
      status: "failed",
      exitCode,
      errorCode,
      errorMessage,
      logs,
    };
  }

  private async finish(
    streamer: LogStreamer,
    logs: SessionLogChunk[],
    assign: SessionAssign,
    worktreeId: string,
    worktreePath: string,
    hookScript: string | undefined,
    outcome: {
      status: SessionTerminalStatus;
      exitCode: number | null;
      errorCode?: SessionErrorCode;
      errorMessage?: string;
    },
  ): Promise<SessionRunResult> {
    streamer.write("system", `Session ${outcome.status}`);
    if (hookScript) {
      await runTerminalHook(this.deps.processRunner, {
        scriptPath: hookScript,
        cwd: worktreePath,
        sessionId: assign.sessionId,
        status: outcome.status as SessionStatus,
        worktreePath,
        ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
        ...(assign.ref !== undefined ? { ref: assign.ref } : {}),
        ...(assign.metadata !== undefined ? { metadata: assign.metadata } : {}),
      });
    }
    void worktreeId;
    return {
      status: outcome.status,
      exitCode: outcome.exitCode,
      logs,
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
    };
  }
}
