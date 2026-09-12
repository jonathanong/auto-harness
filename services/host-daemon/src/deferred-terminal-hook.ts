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
  return async (runHook: boolean) => {
    if (!runHook) return undefined;
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
    const scriptPath = current.repository.terminalHookScript;
    if (scriptPath) {
      await runTerminalHook(options.processRunner, {
        scriptPath,
        cwd: current.cwd,
        sessionId: options.assign.sessionId,
        status: options.status as SessionStatus,
        worktreePath: current.cwd,
        childEnvSource: options.childEnvSource,
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
    });
  };
}

/** Keep the checkout claim until the v6 retry disposition settles its retained hook and result. */
export function retainClaimForDeferredTerminalHook(
  result: SessionRunResult & {
    settleDeferredTerminalHook: (
      runHook: boolean,
    ) => Promise<import("@auto-harness/shared").SessionResult | undefined>;
  },
  release: () => void,
): SessionRunResult {
  let settled = false;
  return {
    ...result,
    settleDeferredTerminalHook: async (runHook) => {
      if (settled) return;
      settled = true;
      try {
        return await result.settleDeferredTerminalHook(runHook);
      } finally {
        release();
      }
    },
  };
}
