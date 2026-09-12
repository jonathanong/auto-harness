import type { SessionErrorCode, SessionStatus } from "./types.ts";

/** Server-owned recovery work for an agent-local terminal hook after host loss. */
export type TerminalHookHandoffMessage = {
  type: "session:terminal-hook";
  handoffId: string;
  sessionId: string;
  repositoryId: string;
  worktreeId: string | null;
  status: Extract<SessionStatus, "completed" | "failed" | "cancelled" | "timed_out">;
  errorCode?: SessionErrorCode;
  ref?: string;
  metadata?: Record<string, unknown>;
};

/** Durable completion acknowledgement for {@link TerminalHookHandoffMessage}. */
export type TerminalHookCompleteMessage = {
  type: "session:terminal-hook-complete";
  handoffId: string;
  sessionId: string;
};

export type TerminalHookAcknowledgedMessage = {
  type: "session:terminal-hook-acknowledged";
  handoffId: string;
  sessionId: string;
};
