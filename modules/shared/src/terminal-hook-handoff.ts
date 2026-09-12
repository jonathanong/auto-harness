import type { SessionErrorCode, SessionStatus } from "./types.ts";
import type { SessionResult } from "./session-result.ts";

/** Durable disposition for a terminal status whose local hook may still be retained. */
export type TerminalStatusAcknowledgedMessage = {
  type: "session:status-acknowledged";
  sessionId: string;
  attemptId?: string | undefined;
  retryAccepted?: boolean | undefined;
  terminalHookHandoffId?: string | undefined;
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
