import { thrownMessage, type SessionAssign, type SessionStatus } from "@auto-harness/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
import {
  GITHUB_APP_TOKEN_MARGIN_MS,
  mintInstallationToken,
  withoutAmbientGitHubTokens,
  withInstallationToken,
  withIsolatedGitHubConfigDir,
  type GitHubAppConfig,
} from "./github-app.ts";
import { SecretRedactingProcessRunner } from "./secret-redacting-runner.ts";
import { collectSessionResult } from "./session-result.ts";
import type { SessionRunResult } from "./session-outcome.ts";
import { runTerminalHook } from "./terminal-hook.ts";

type DeferredTerminalHookOptions = {
  processRunner: ProcessRunner;
  streamer: LogStreamer;
  assign: SessionAssign;
  claimed: {
    currentHookTarget: () => Promise<{
      cwd: string;
      repository: { terminalHookScript?: string };
      allowedRoots?: readonly string[];
    } | null>;
  };
  status: SessionRunResult["status"];
  errorCode: SessionRunResult["errorCode"];
  childEnvSource: NodeJS.ProcessEnv;
  baseline?: string;
  environmentIsChild: boolean;
  /** App credentials must be minted afresh because recovery outlives the original assignment. */
  githubApp?: GitHubAppConfig;
  nowMs?: () => number;
};

const RECOVERY_CREDENTIAL_TIMEOUT_MS = 60_000;

function recoveryDeadline(deadlineAtMs: number | undefined): {
  signal: AbortSignal;
  deadlineAtMs: number;
  dispose: () => void;
} {
  const controller = new AbortController();
  const deadline = Math.min(
    deadlineAtMs ?? Number.POSITIVE_INFINITY,
    Date.now() + RECOVERY_CREDENTIAL_TIMEOUT_MS,
  );
  const timeoutMs = deadline - Date.now();
  const timer = timeoutMs <= 0 ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  if (timeoutMs <= 0) controller.abort();
  return {
    signal: controller.signal,
    deadlineAtMs: deadline,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Revalidate the retained claim, run its hook, then collect the observable post-hook result. */
export function createDeferredTerminalHookSettlement(options: DeferredTerminalHookOptions) {
  return async (runHook: boolean, deadlineAtMs?: number) => {
    if (!runHook) return undefined;
    if (
      deadlineAtMs !== undefined &&
      (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now())
    )
      return undefined;
    let current: Awaited<ReturnType<typeof options.claimed.currentHookTarget>> | undefined;
    try {
      current = await options.claimed.currentHookTarget();
    } catch (error) {
      options.streamer.write(
        "system",
        `terminal hook revalidation failed for session ${options.assign.sessionId}: ${thrownMessage(error)}`,
      );
      return undefined;
    }
    if (!current) return undefined;
    if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) return undefined;
    const repositoryId = options.assign.repositoryId;
    const mappedGitHubApp =
      typeof repositoryId === "string" &&
      (options.githubApp?.repositories.has(repositoryId) ?? false);
    let isolatedGitHubConfigDir: string | undefined;
    const credentialDeadline = mappedGitHubApp ? recoveryDeadline(deadlineAtMs) : undefined;
    let effectiveDeadlineAtMs = deadlineAtMs;
    let terminalEnvironment = mappedGitHubApp
      ? withoutAmbientGitHubTokens(options.childEnvSource)
      : options.childEnvSource;
    let terminalRunner = options.processRunner;
    try {
      if (mappedGitHubApp) {
        isolatedGitHubConfigDir = await mkdtemp(join(tmpdir(), "auto-harness-gh-config-"));
        terminalEnvironment = withIsolatedGitHubConfigDir(
          terminalEnvironment,
          isolatedGitHubConfigDir,
        );
        const token = await mintInstallationToken(
          options.githubApp!,
          repositoryId!,
          credentialDeadline!.signal,
          fetch,
          options.nowMs,
        );
        if (
          !token ||
          token.expiresAtMs - (options.nowMs ?? Date.now)() <= GITHUB_APP_TOKEN_MARGIN_MS
        ) {
          options.streamer.write("system", "GitHub App credential provisioning failed");
          return undefined;
        }
        effectiveDeadlineAtMs = Math.min(
          deadlineAtMs ?? Number.POSITIVE_INFINITY,
          token.expiresAtMs - GITHUB_APP_TOKEN_MARGIN_MS,
          credentialDeadline!.deadlineAtMs,
        );
        if (effectiveDeadlineAtMs <= Date.now()) return undefined;
        terminalEnvironment = withInstallationToken(terminalEnvironment, options.githubApp!, token);
        terminalRunner = new SecretRedactingProcessRunner(options.processRunner, token.token);
      }
      const scriptPath = current.repository.terminalHookScript;
      if (scriptPath) {
        const remainingMs =
          effectiveDeadlineAtMs === undefined ? undefined : effectiveDeadlineAtMs - Date.now();
        if (remainingMs !== undefined && remainingMs <= 0) return undefined;
        await runTerminalHook(terminalRunner, {
          scriptPath,
          cwd: current.cwd,
          sessionId: options.assign.sessionId,
          status: options.status as SessionStatus,
          worktreePath: current.cwd,
          childEnvSource: terminalEnvironment,
          ...(remainingMs !== undefined ? { timeoutMs: Math.min(60_000, remainingMs) } : {}),
          ...(current.allowedRoots?.length ? { allowedRoots: current.allowedRoots } : {}),
          ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
          ...(options.assign.ref !== undefined ? { ref: options.assign.ref } : {}),
          ...(options.assign.metadata !== undefined ? { metadata: options.assign.metadata } : {}),
        });
      }
      return await collectSessionResult({
        runner: terminalRunner,
        cwd: current.cwd,
        status: options.status,
        ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
        environment: terminalEnvironment,
        ...(options.environmentIsChild ? { environmentIsChild: true } : {}),
        ...(effectiveDeadlineAtMs !== undefined ? { deadlineAtMs: effectiveDeadlineAtMs } : {}),
      });
    } catch (error) {
      if (mappedGitHubApp) {
        options.streamer.write("system", "GitHub App credential provisioning failed");
        return undefined;
      }
      throw error;
    } finally {
      credentialDeadline?.dispose();
      if (isolatedGitHubConfigDir) {
        try {
          await rm(isolatedGitHubConfigDir, { force: true, recursive: true });
        } catch (error) {
          console.error("failed to remove isolated GitHub config directory", error);
        }
      }
    }
  };
}

/** Keep the checkout claim until the v6 retry disposition settles its retained hook and result. */
export function retainClaimForDeferredTerminalHook(
  result: SessionRunResult & {
    settleDeferredTerminalHook: (
      runHook: boolean,
      deadlineAtMs?: number,
    ) => Promise<import("@auto-harness/shared").SessionResult | undefined>;
  },
  release: () => void,
): SessionRunResult {
  let settled = false;
  let settlement: ReturnType<typeof result.settleDeferredTerminalHook> | undefined;
  return {
    ...result,
    settleDeferredTerminalHook: (runHook, deadlineAtMs) => {
      // Shutdown and the retry disposition can arrive while the hook is still
      // running. They must wait for, and report, the same terminal result.
      if (settlement) return settlement;
      if (settled) return Promise.resolve(undefined);
      settled = true;
      let pending: ReturnType<typeof result.settleDeferredTerminalHook>;
      try {
        pending = result.settleDeferredTerminalHook(runHook, deadlineAtMs);
      } catch (error) {
        pending = Promise.reject(error);
      }
      const current = pending.finally(release);
      settlement = current;
      const clear = () => {
        if (settlement === current) settlement = undefined;
      };
      void current.then(clear, clear);
      return current;
    },
  };
}
