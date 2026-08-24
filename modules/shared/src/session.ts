import type {
  LogStream,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
} from "./types.ts";
import type { CommandResumeSpec } from "./command-resume.ts";
import type { HostCapability } from "./host-capabilities.ts";
import type { HostRuntimeReport } from "./host-runtime.ts";
import type { HostRunningAttempt } from "./host-registration.ts";
import type { SessionUsage } from "./usage.ts";

export type SessionResumeSpec = CommandResumeSpec & {
  /** Frozen normal command argv, without an appended prompt. */
  argv: string[];
  appendPrompt: boolean;
  /** See Command.appendPromptSeparator. Explicit `| undefined` since callers commonly
   * forward a Command's own already-optional field verbatim. */
  appendPromptSeparator?: boolean | undefined;
};

/** Payload used when assigning work to an agent (control plane → agent). */
export type SessionAssign = {
  sessionId: string;
  sessionType?: SessionType;
  /** Immutable execution-attempt fence supplied by the scheduler. */
  attemptId: string;
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
  resumeRefCapture?: import("./providers.ts").ResumeRefCapture;
  metadata?: Record<string, unknown>;
  /** Non-secret resolved route metadata for observability. */
  providerAccountId?: string;
  commandId?: string;
  targetIndex?: number;
};

export type SessionLogChunk = {
  sessionId: string;
  /** Immutable assignment fence echoed from `session:assign`. */
  attemptId: string;
  stream: LogStream;
  content: string;
  timestamp: string;
  seq: number;
};

export type SessionTerminalStatus = Extract<
  SessionStatus,
  "completed" | "failed" | "cancelled" | "timed_out"
>;

export type SessionActiveStatus = Extract<SessionStatus, "queued" | "running">;

export type SessionStatusUpdate = {
  sessionId: string;
  status: SessionStatus;
  exitCode?: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
};

export type CreateSessionFields = {
  repositoryId: string;
  prompt: string;
  /** Primary routing target, followed by fallbacks when it has no capacity. */
  target: TargetRef;
  fallbacks?: TargetRef[];
  /** Absolute queue lifetime, measured from creation. */
  queueTtlSeconds?: number;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  ref?: string;
  type?: SessionType;
  source?: SessionSource;
  /** Suppresses duplicate queued/running work globally while this session is active. */
  concurrencyId?: string;
  metadata?: Record<string, unknown>;
};

/** A provider selects an eligible attached account; a command runs exactly that command. */
export type TargetRef =
  | { providerId: string; commandId?: never }
  | { commandId: string; providerId?: never };

/** Wire messages on the agent control channel (REST-backed local hub or API GW WS). */
export type HostWireMessage =
  | {
      type: "session:assign";
      sessionId: string;
      sessionType?: SessionType;
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
      resumeRefCapture?: import("./providers.ts").ResumeRefCapture;
      metadata?: Record<string, unknown>;
      providerAccountId?: string;
      commandId?: string;
      targetIndex?: number;
      assignedAt: string;
      /** Immutable execution-attempt fence; echo in ACK and status messages. */
      attemptId: string;
    }
  /** Sent only after the control plane durably commits `session:ack` for the
   * current host connection. A successful WebSocket write is not an ACK. */
  | { type: "session:acknowledged"; sessionId: string; attemptId: string }
  | { type: "session:cancel"; sessionId: string; attemptId: string }
  /** Durable acknowledgement of an agent-initiated drain request. */
  | { type: "host:draining"; hostId: string }
  | { type: "host:drain" }
  /** Confirms a `host:register` was accepted; opens the daemon's registration barrier. */
  | { type: "host:registered"; hostId: string; connectionId?: string | undefined };

export type HostToServerMessage =
  | {
      type: "host:register";
      hostId: string;
      worktrees: Array<{
        id: string;
        name: string;
        repositoryId: string;
        path: string;
        labels: string[];
      }>;
      /** Explicit repository paths keep zero-worktree repositories dispatchable. */
      repositories?: import("./host-registration.ts").HostRepositoryRegistration[];
      /** Optional for compatibility with daemons released before capabilities. */
      capabilities?: HostCapability[];
      /** Running daemon-owned sessions, used to reconcile an interrupted socket. */
      runningSessions?: string[];
      /** Attempt-fenced reconnect claims; ignored when the attempt is no longer current. */
      runningAttempts?: HostRunningAttempt[];
      /** Host control-channel protocol. Missing means a legacy daemon (version 0). */
      protocolVersion?: number;
      /** Stable for one daemon process and reused across socket reconnects. */
      daemonInstanceId?: string;
      /** Process start time reported alongside daemonInstanceId. */
      daemonStartedAt?: string;
      /** Git checkout-recovery readiness and daemon package version. Missing means legacy. */
      runtime?: HostRuntimeReport;
      /** A reconnecting daemon retains drain until this shutdown completes. */
      draining?: true;
    }
  | { type: "session:ack"; sessionId: string; worktreeId: string | null; attemptId: string }
  | {
      type: "session:status";
      sessionId: string;
      worktreeId: string | null;
      attemptId: string;
      status: SessionStatus;
      exitCode?: number | null;
      errorCode?: SessionErrorCode;
      errorMessage?: string;
      cliResumeRef?: string;
      usage?: SessionUsage;
    }
  | {
      type: "session:usage";
      sessionId: string;
      worktreeId: string | null;
      attemptId: string;
      usage: SessionUsage;
    }
  | {
      type: "session:log";
      sessionId: string;
      /** Required at protocol version 1+. Legacy daemons may omit it. */
      attemptId?: string;
      stream: LogStream;
      content: string;
      timestamp: string;
      seq: number;
    }
  /** One-way, connection-fenced request to remove this host from scheduling. */
  | { type: "host:status"; hostId: string; draining: true }
  | { type: "host:keepalive"; hostId: string; at: string };
