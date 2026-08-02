import type {
  LogStream,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
} from "./types.js";

/** Payload used when assigning work to an agent (control plane → agent). */
export type SessionAssign = {
  sessionId: string;
  repositoryId: string;
  prompt: string;
  commandProfile: string;
  timeout: number;
  worktreeId: string | null;
  ref?: string;
  setupScript?: string;
  resume?: boolean;
  resumedFromSessionId?: string;
  cliResumeRef?: string;
  metadata?: Record<string, unknown>;
};

export type SessionLogChunk = {
  sessionId: string;
  stream: LogStream;
  content: string;
  timestamp: string;
  seq: number;
};

export type SessionTerminalStatus = Extract<
  SessionStatus,
  "completed" | "failed" | "cancelled" | "timed_out"
>;

export type SessionStatusUpdate = {
  sessionId: string;
  status: SessionStatus;
  exitCode?: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
};

export type CreateSessionFields = {
  repositoryId: string;
  prompt: string;
  commandProfile: string;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  onConflict: "queue" | "replace" | "reject";
  ref?: string;
  type?: SessionType;
  source?: SessionSource;
  concurrencyKey?: string;
  metadata?: Record<string, unknown>;
};
