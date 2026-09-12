import { thrownMessage, type SessionAssign, type SessionStatus } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import type { LogStreamer } from "./log-streamer.ts";
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
};

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
    const scriptPath = current.repository.terminalHookScript;
    if (scriptPath) {
      const remainingMs = deadlineAtMs === undefined ? undefined : deadlineAtMs - Date.now();
      if (remainingMs !== undefined && remainingMs <= 0) return undefined;
      await runTerminalHook(options.processRunner, {
        scriptPath,
        cwd: current.cwd,
        sessionId: options.assign.sessionId,
        status: options.status as SessionStatus,
        worktreePath: current.cwd,
        childEnvSource: options.childEnvSource,
        ...(remainingMs !== undefined ? { timeoutMs: Math.min(60_000, remainingMs) } : {}),
        ...(current.allowedRoots?.length ? { allowedRoots: current.allowedRoots } : {}),
        ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
        ...(options.assign.ref !== undefined ? { ref: options.assign.ref } : {}),
        ...(options.assign.metadata !== undefined ? { metadata: options.assign.metadata } : {}),
      });
    }
    return await collectSessionResult({
      runner: options.processRunner,
      cwd: current.cwd,
      status: options.status,
      ...(options.baseline !== undefined ? { baseline: options.baseline } : {}),
      environment: options.childEnvSource,
      ...(options.environmentIsChild ? { environmentIsChild: true } : {}),
      ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
    });
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
