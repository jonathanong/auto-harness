/* eslint-disable max-lines -- wire session contracts stay colocated for protocol compatibility. */
import type {
  LogStream,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
} from "./types.ts";
import type {
  TerminalHookAcknowledgedMessage,
  TerminalHookCompleteMessage,
  TerminalHookHandoffMessage,
  TerminalStatusAcknowledgedMessage,
} from "./terminal-hook-handoff.ts";
import type { CommandResumeSpec } from "./command-resume.ts";
import type { HostCapability, HostCapabilitiesAdvertisement } from "./host-capabilities.ts";
import type { HostRuntimeReport } from "./host-runtime.ts";
import type { HostRunningAttempt, ProviderAccountReadiness } from "./host-registration.ts";
import type { SessionUsage } from "./usage.ts";
import type { SessionResult } from "./session-result.ts";
import type { WorkspacePoolAttachment } from "./workspace.ts";

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
  repositoryId: string | null;
  prompt: string;
  /** Final argv, already resolved control-plane-side (cascade walk + prompt append per Command.appendPrompt). */
  resolvedArgv: string[];
  timeout: number;
  worktreeId: string | null;
  /** Automatic infrastructure retries consumed before this assignment. */
  infrastructureRetryCount?: number;
  /** Present only for a workspace session; the assigned slot is host-local. */
  workspacePoolId?: string;
  workspaceSlotId?: string;
  setupProfileId?: string;
  destroyWorkspaceAfter?: boolean;
  ref?: string;
  setupScript?: string;
  resume?: boolean;
  resumedFromSessionId?: string;
  cliResumeRef?: string;
  resumeRefCapture?: import("./providers.ts").ResumeRefCapture;
  metadata?: Record<string, unknown>;
  /** Daemon-local execution profile key; selects CLI HOME/env on the host. */
  providerAccountId?: string;
  /** Non-secret resolved route breadcrumb for observability. */
  commandId?: string;
  targetIndex?: number;
  /** The session this run continues, when the resume routed fresh instead of
   * natively. Presence tells a capability-advertising daemon to fetch
   * `GET /sessions/<this session id>/prior-context` and write the result to
   * the fixed prior-context path. No URL or path ever crosses the wire. */
  priorContext?: { sourceSessionId: string };
};

export type SessionLogChunk = {
  sessionId: string;
  /** Immutable assignment fence echoed from `session:assign`. */
  attemptId: string;
  stream: LogStream;
  content: string;
  timestamp: string;
  seq: number;
  /** Source-side chunks dropped immediately before this frame. */
  dropped?: number;
};

export type SessionTerminalStatus = Extract<
  SessionStatus,
  "completed" | "failed" | "cancelled" | "timed_out"
>;

export type SessionActiveStatus = Extract<SessionStatus, "queued" | "running">;

export type SessionStatusUpdate = {
  sessionId: string;
  status: SessionStatus;
  workspaceSlotId?: string;
  workspaceSlotError?: string;
  exitCode?: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
  result?: SessionResult;
};

export type CreateSessionFields = {
  repositoryId: string | null;
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
  /** Non-git workspace pool selected at admission time. */
  workspacePoolId?: string;
  /** Approved pool-local setup profile; raw setup scripts are never session input. */
  setupProfileId?: string;
  destroyWorkspaceAfter?: boolean;
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
      repositoryId: string | null;
      prompt: string;
      resolvedArgv: string[];
      timeout: number;
      worktreeId: string | null;
      /** Automatic infrastructure retries consumed before this assignment. */
      infrastructureRetryCount?: number;
      workspacePoolId?: string;
      workspaceSlotId?: string;
      setupProfileId?: string;
      destroyWorkspaceAfter?: boolean;
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
      /** The session this run continues, when the resume routed fresh instead of
       * natively. Presence tells a capability-advertising daemon to fetch
       * `GET /sessions/<this session id>/prior-context` and write the result to
       * the fixed prior-context path. No URL or path ever crosses the wire. */
      priorContext?: { sourceSessionId: string };
      assignedAt: string;
      /** Immutable execution-attempt fence; echo in ACK and status messages. */
      attemptId: string;
    }
  /** Sent only after the control plane durably commits `session:ack` for the
   * current host connection. A successful WebSocket write is not an ACK. */
  | { type: "session:acknowledged"; sessionId: string; attemptId?: string | undefined }
  /** Sent only after the control plane durably authorizes the primary CLI to launch. */
  | { type: "session:command-start-acknowledged"; sessionId: string; attemptId: string }
  | TerminalStatusAcknowledgedMessage
  | TerminalHookHandoffMessage
  | TerminalHookAcknowledgedMessage
  | { type: "session:cancel"; sessionId: string; attemptId?: string | undefined }
  /** Durable acknowledgement of an agent-initiated drain request. */
  | { type: "host:draining"; hostId: string }
  | { type: "host:drain" }
  /** Confirms a `host:register` was accepted; opens the daemon's registration barrier. */
  | {
      type: "host:registered";
      hostId: string;
      connectionId?: string | undefined;
      /** Control-plane protocol. Missing means a pre-keepalive-ack peer. */
      protocolVersion?: number | undefined;
    }
  /** Sent only after the control plane durably applies `host:keepalive`.
   * A successful daemon WebSocket write is not peer evidence. */
  | { type: "host:keepalive-ack"; hostId: string; at: string };

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
      /** Host-local workspace slots in the daemon's initial inventory snapshot. */
      workspacePools?: WorkspacePoolAttachment[];
      /**
       * Feature flags (legacy array) or `{ features, maxConcurrentAssignments }`.
       * parseHostMessage flattens this to a feature array plus a sibling cap.
       */
      capabilities?: HostCapability[] | HostCapabilitiesAdvertisement;
      /** Host-wide concurrent assignment cap; omitted means a legacy daemon. */
      maxConcurrentAssignments?: number;
      /** Ready local execution profiles; credentials never appear here. */
      providerAccountReadiness?: ProviderAccountReadiness[];
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
  /** Host asks the control plane to durably mark the primary CLI launch boundary. */
  | {
      type: "session:command-start";
      sessionId: string;
      worktreeId: string | null;
      attemptId: string;
    }
  | {
      type: "session:status";
      sessionId: string;
      worktreeId: string | null;
      workspaceSlotId?: string;
      workspaceSlotError?: string;
      attemptId: string;
      status: SessionStatus;
      exitCode?: number | null;
      errorCode?: SessionErrorCode;
      errorMessage?: string;
      cliResumeRef?: string;
      usage?: SessionUsage;
      result?: SessionResult;
      deferTerminalHookResult?: true;
    }
  | {
      type: "session:usage";
      sessionId: string;
      worktreeId: string | null;
      attemptId: string;
      usage: SessionUsage;
    }
  | TerminalHookCompleteMessage
  | {
      type: "session:log";
      sessionId: string;
      /** Required at protocol version 1+. Legacy daemons may omit it. */
      attemptId?: string | undefined;
      stream: LogStream;
      content: string;
      timestamp: string;
      seq: number;
      /** Source-side chunks dropped immediately before this frame. */
      dropped?: number;
    }
  /** One-way, connection-fenced request to remove this host from scheduling. */
  | { type: "host:status"; hostId: string; draining: true }
  | {
      type: "host:keepalive";
      hostId: string;
      at: string;
      /** Sessions this daemon currently owns: still running, or a terminal status
       * awaiting acknowledgement. Missing means a pre-reconciliation daemon. */
      runningSessions?: string[];
    };
