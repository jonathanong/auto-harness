import type {
  SessionErrorCode,
  SessionLogChunk,
  SessionTerminalStatus,
  SessionUsage,
  SessionResult,
} from "@auto-harness/shared";

export type SessionRunResult = {
  status: SessionTerminalStatus;
  exitCode: number | null;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
  result?: SessionResult;
  /** Settles a retained first-fetch-failure hook before its worktree claim releases. */
  settleDeferredTerminalHook?: (
    runHook: boolean,
    /** The v7 control-plane handoff lease, when settlement is recovery-owned. */
    deadlineAtMs?: number,
  ) => Promise<SessionResult | undefined>;
  logs: SessionLogChunk[];
  /** Local cleanup/quarantine state; the daemon forwards the terminal failure normally. */
  workspaceSlotError?: string;
  /** Echoed in the terminal frame so the control plane can release/quarantine this slot atomically. */
  workspaceSlotId?: string;
};

export type SessionOutcome = {
  status: SessionTerminalStatus;
  exitCode: number | null;
  /** Do not run the terminal hook when cancellation wins before command start. */
  suppressTerminalHook?: boolean;
  deferTerminalHook?: boolean;
  errorCode?: SessionErrorCode;
  errorMessage?: string;
  cliResumeRef?: string;
  usage?: SessionUsage;
  agentSummary?: string;
};

export type ClaimedHookTarget = {
  worktree: { id: string };
  cwd: string;
  repository: { terminalHookScript?: string };
  allowedRoots?: readonly string[];
  currentHookTarget: () => Promise<{
    cwd: string;
    repository: { terminalHookScript?: string };
    allowedRoots?: readonly string[];
  } | null>;
};
