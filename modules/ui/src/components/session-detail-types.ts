export type SessionSummary = {
  id: string;
  type?: "prompt" | "scheduled" | "workspace" | null;
  status: string;
  repositoryId?: string | null;
  /** Workspace sessions have no repository or worktree; they run in a pool slot. */
  workspacePoolId?: string | null;
  workspaceSlotId?: string | null;
  setupProfileId?: string | null;
  hostId?: string | null;
  worktreeId?: string | null;
  targetLabel?: string | null;
  targetDisplayNames?: string[] | null;
  target?: { providerId?: string; commandId?: string } | null;
  fallbacks?: Array<{ providerId?: string; commandId?: string }> | null;
  queueTtlSeconds?: number | null;
  queueExpiresAt?: string | null;
  resolvedProviderAccountId?: string | null;
  resolvedCommandId?: string | null;
  resolvedHostId?: string | null;
  resolvedRoute?: {
    targetIndex?: number;
    providerAccountId?: string | null;
    commandId?: string | null;
    hostId?: string | null;
    worktreeId?: string | null;
    workspacePoolId?: string | null;
    workspaceSlotId?: string | null;
  } | null;
  resumedFromSessionId?: string | null;
  resumeFallback?: boolean | null;
  resolvedArgv?: string[] | null;
  prompt?: string | null;
  source?: string | null;
  priority?: number | null;
  concurrencyId?: string | null;
  ref?: string | null;
  timeout?: number | null;
  ackReceivedAt?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Number of bounded infrastructure retries already consumed (maximum one). */
  infrastructureRetryCount?: number | null;
  /** Most recent infrastructure failure that caused an automatic retry. */
  lastInfrastructureErrorCode?: "checkout_fetch_failed" | "host_lost" | string | null;
  metadata?: { createdBy?: unknown } | null;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
};
