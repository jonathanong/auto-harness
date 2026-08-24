import type { SessionErrorCode, SessionStatus } from "@auto-harness/shared";

import { assertPathWithinAllowedRoots, resolveHookPath } from "./allowed-roots.ts";
import { createChildEnv } from "./child-env.ts";
import type { ProcessRunner } from "./executor.ts";

type TerminalHookInput = {
  scriptPath: string;
  cwd: string;
  sessionId: string;
  status: SessionStatus;
  errorCode?: SessionErrorCode;
  ref?: string;
  metadata?: Record<string, unknown>;
  worktreePath: string;
  timeoutMs?: number;
  childEnvSource?: NodeJS.ProcessEnv;
  allowedRoots?: readonly string[];
};

/**
 * Invoke repo-local terminal hook script (D3). Failures are logged and swallowed.
 */
export async function runTerminalHook(
  runner: ProcessRunner,
  input: TerminalHookInput,
  log: (message: string) => void = console.error,
): Promise<void> {
  let scriptPath = input.scriptPath;
  const env: NodeJS.ProcessEnv = {
    ...createChildEnv(input.childEnvSource ?? process.env),
    HARNESS_SESSION_ID: input.sessionId,
    HARNESS_STATUS: input.status,
    HARNESS_WORKTREE_PATH: input.worktreePath,
  };
  if (input.errorCode) {
    env.HARNESS_ERROR_CODE = input.errorCode;
  }
  if (input.ref) {
    env.HARNESS_REF = input.ref;
  }
  if (input.metadata) {
    env.HARNESS_METADATA = JSON.stringify(input.metadata);
  }

  try {
    scriptPath = resolveHookPath(input.cwd, input.scriptPath);
    if (input.allowedRoots?.length) {
      // Execute the exact canonical path that was checked. Keeping the
      // symlink spelling here would re-open a TOCTOU window between the
      // containment check and spawning the shell.
      scriptPath = await assertPathWithinAllowedRoots(scriptPath, input.allowedRoots);
    }
  } catch (err) {
    log(
      `terminal hook blocked for session ${input.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  try {
    const result = await runner.run({
      argv: ["/bin/sh", scriptPath],
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs ?? 60_000,
      onChunk: () => {
        /* discard hook output */
      },
    });
    if (result.exitCode !== 0) {
      log(`terminal hook exited ${String(result.exitCode)} for session ${input.sessionId}`);
    }
  } catch (err) {
    log(
      `terminal hook failed for session ${input.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
