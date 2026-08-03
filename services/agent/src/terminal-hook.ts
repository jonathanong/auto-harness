import type { SessionErrorCode, SessionStatus } from "@auto-harness/shared";

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
};

/**
 * Invoke repo-local terminal hook script (D3). Failures are logged and swallowed.
 */
export async function runTerminalHook(
  runner: ProcessRunner,
  input: TerminalHookInput,
  log: (message: string) => void = console.error,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
    const result = await runner.run({
      argv: ["/bin/sh", input.scriptPath],
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
