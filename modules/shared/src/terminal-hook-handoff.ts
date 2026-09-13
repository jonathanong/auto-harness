import { DEFERRED_TERMINAL_RESULT_PROTOCOL_VERSION } from "./constants.ts";
import type { SessionErrorCode, SessionStatus } from "./types.ts";
import { harnessSessionResult, type SessionResult } from "./session-result.ts";

/** Durable disposition for a terminal status whose local hook may still be retained. */
export type TerminalStatusAcknowledgedMessage = {
  type: "session:status-acknowledged";
  sessionId: string;
  attemptId?: string | undefined;
  retryAccepted?: boolean | undefined;
  terminalHookHandoffId?: string | undefined;
  /** Control-plane-owned expiry for a deferred terminal-hook handoff. */
  terminalHookHandoffExpiresAt?: string | undefined;
};

/** Server-owned recovery work for an agent-local terminal hook after host loss. */
export type TerminalHookHandoffMessage = {
  type: "session:terminal-hook";
  handoffId: string;
  sessionId: string;
  repositoryId: string;
  worktreeId: string | null;
  status: Extract<SessionStatus, "completed" | "failed" | "cancelled" | "timed_out">;
  /** Control-plane-owned deadline for the handoff and its completion retry. */
  expiresAt: string;
  errorCode?: SessionErrorCode;
  ref?: string;
  metadata?: Record<string, unknown>;
};

/** Durable completion acknowledgement for {@link TerminalHookHandoffMessage}. */
export type TerminalHookCompleteMessage = {
  type: "session:terminal-hook-complete";
  handoffId: string;
  sessionId: string;
  /** Collected only after the terminal hook has completed. */
  result?: SessionResult;
};

export type TerminalHookAcknowledgedMessage = {
  type: "session:terminal-hook-acknowledged";
  handoffId: string;
  sessionId: string;
};

/**
 * Protocol v6 deferred-result completions always persist a bounded result.
 * v5 host-loss completions from older daemons may omit one.
 */
export function resolveTerminalHookCompletionResult(
  protocolVersion: number,
  status: TerminalHookHandoffMessage["status"],
  result?: SessionResult,
): SessionResult | undefined {
  if (result) return result;
  return protocolVersion >= DEFERRED_TERMINAL_RESULT_PROTOCOL_VERSION
    ? harnessSessionResult(status)
    : undefined;
}
