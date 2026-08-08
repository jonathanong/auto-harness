import type {
  LogStream,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
} from "./types.ts";

/** Payload used when assigning work to an agent (control plane → agent). */
export type SessionAssign = {
  sessionId: string;
  repositoryId: string;
  prompt: string;
  /** Final argv, already resolved control-plane-side (cascade walk + prompt append per Command.appendPrompt). */
  resolvedArgv: string[];
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
  /** Exactly one of providerAccountId/commandId is set. */
  providerAccountId?: string;
  commandId?: string;
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

/** Wire messages on the agent control channel (REST-backed local hub or API GW WS). */
export type HostWireMessage =
  | {
      type: "session:assign";
      sessionId: string;
      repositoryId: string;
      prompt: string;
      resolvedArgv: string[];
      timeout: number;
      worktreeId: string | null;
      ref?: string;
      setupScript?: string;
      resume?: boolean;
      resumedFromSessionId?: string;
      cliResumeRef?: string;
      metadata?: Record<string, unknown>;
      assignedAt: string;
    }
  | { type: "session:cancel"; sessionId: string }
  | { type: "host:drain" };

export type HostToServerMessage =
  | {
      type: "host:register";
      agentId: string;
      worktrees: Array<{
        id: string;
        name: string;
        repositoryId: string;
        path: string;
        labels: string[];
      }>;
      commandProfiles: string[];
    }
  | { type: "session:ack"; sessionId: string }
  | {
      type: "session:status";
      sessionId: string;
      status: SessionStatus;
      exitCode?: number | null;
      errorCode?: SessionErrorCode;
      errorMessage?: string;
      cliResumeRef?: string;
    }
  | {
      type: "session:log";
      sessionId: string;
      stream: LogStream;
      content: string;
      timestamp: string;
      seq: number;
    }
  | { type: "host:keepalive"; agentId: string; at: string };
