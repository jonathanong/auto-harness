/* eslint-disable max-lines */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  Command,
  HostCapability,
  HostRuntimeReport,
  Provider,
  ProviderAccount,
  RepositoryAdmissionState,
  TargetRef,
  UserRole,
} from "@auto-harness/shared";

import { queueOrderKey } from "../control-plane-ordering.ts";
import type { DynamoTableNames } from "./dynamo.ts";
import { statusShardAttr } from "./dynamo.ts";
import type { SessionRecord } from "./types.ts";

export type PlaneStorageCtx = {
  doc: DynamoDBDocumentClient;
  tables: DynamoTableNames;
};

export type ProviderRecord = Provider;
/**
 * `version` is an internal, monotonic DynamoDB compare-and-swap fence.  It is
 * deliberately distinct from `updatedAt`: two workers can observe the same
 * clock tick, whereas a counter cannot collide for one account row.
 *
 * It is optional only to permit hydrating rows written before the fence was
 * introduced; storage normalizes those legacy rows to version zero.
 */
export type ProviderAccountRecord = ProviderAccount & { version?: number };
export type CommandRecord = Command;

/** Authentication principal record stored in the dedicated Users table. */
export type AuthAccountRecord = {
  id: string;
  username: string;
  name?: string;
  kind: "user" | "service-account";
  role: UserRole;
  passwordHash?: string;
  apiKeyHash?: string;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionRecord = {
  connectionId: string;
  type: "host" | "client";
  hostId: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  /** Repository IDs advertised by this daemon, including zero-worktree repos. */
  repositoryIds?: string[];
  /** Empty/absent means an older daemon supports no optional capabilities. */
  capabilities?: HostCapability[];
  /** Present only when this daemon has completed the checkout-recovery preflight. */
  runtime?: HostRuntimeReport;
  /** False only for an authenticated API Gateway socket awaiting host:register. */
  registered?: false;
  /** Present only for a browser viewer connection. */
  viewerPrincipal?: {
    id: string;
    username: string;
    role: UserRole;
    kind: "admin" | "user";
    allowedRepositoryIds?: string[];
  };
  /** Durable viewer subscriptions used across API Gateway Lambda invocations. */
  viewerSubscriptions?: Array<{
    sessionId: string;
    repositoryId: string;
    status: string;
    after?: string;
  }>;
};

export type ScheduleRecord = {
  id: string;
  repositoryId: string;
  principalId?: string;
  name: string;
  target: TargetRef;
  fallbacks: TargetRef[];
  targetLabels: string[];
  cron: string;
  enabled: boolean;
  timeout: number;
  queueTtlSeconds: number;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  ref?: string;
  concurrencyId?: string;
  /** Prompt passed to the CLI when this schedule fires. Missing/blank stays empty. */
  prompt?: string;
};

export const LOG_STREAMS = ["stdout", "stderr", "system"] as const;

export type LogStream = (typeof LOG_STREAMS)[number];

/** A bounded REST history query. `since` is normalized ISO-8601 UTC. */
export type LogQuery = {
  stream?: LogStream;
  since?: string;
  /** Exact durable cursor used by viewer reconnects. */
  after?: string;
  limit: number;
};

export type LogRecord = {
  sessionId: string;
  timestampSeq: string;
  stream: string;
  content: string;
  timestamp: string;
  seq: number;
};

export type ArchiveMetadata = {
  key: string;
  contentType: string;
  bodyBytes: number;
  status: "pending" | "complete";
  objectStored: boolean;
  updatedAt: string;
};

export type RepositoryRecord = {
  id: string;
  name: string;
  /** Git remote URL and/or local path identity for operators. */
  url: string;
  defaultBranch: string;
  setupScript?: string;
  terminalHookScript?: string;
  /** Missing on legacy rows means active. */
  admissionState?: RepositoryAdmissionState;
  admissionStateChangedAt?: string;
  /**
   * The exact instant this repository was reopened after being closed. Cron
   * occurrences before this cutover belong to the closed interval and must
   * not be replayed when a scheduler observes them after activation.
   */
  activationCutoffAt?: string;
  drainRequestedAt?: string;
  drainCompletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** The durable form of a repository-list query. Storage continuation keys stay opaque. */
export type RepositoryPageQuery = {
  limit: number;
  startKey?: Record<string, unknown> | undefined;
  /** Undefined means unrestricted; an empty array is an empty principal scope. */
  allowedRepositoryIds?: readonly string[] | undefined;
};

export type RepositoryPage = {
  items: RepositoryRecord[];
  nextKey: Record<string, unknown> | null;
};

export type SessionDrainStatus = "draining" | "succeeded" | "failed" | "released";

export type SessionDrainRecord = {
  scopeKey: string;
  recordKey: string;
  operationId: string;
  repositoryId: string;
  principalId: string;
  status: SessionDrainStatus;
  requestedAt: string;
  updatedAt: string;
  deadlineAt: string;
  queuedCount: number;
  runningCount: number;
  cancelledCount: number;
  /** Opaque DynamoDB resume key for a bounded strongly-consistent ACT sweep. */
  activityCursor?: Record<string, unknown>;
  reconcileLeaseOwner?: string;
  reconcileLeaseUntil?: string;
  completedAt?: string;
  releasedAt?: string;
  failureCode?: "DEADLINE_EXCEEDED";
};

/** Enable/command override for a provider account at a repository or worktree scope. */
export type ProviderAccountOverride = { enabled?: boolean; commandId?: string };

/** Durable agent host inventory (repository/worktree config for a host). */
export type HostInventoryRecord = {
  hostId: string;
  setupScript?: string | undefined;
  requiredEnvironment?: string[] | undefined;
  /** Opaque identity last reported by a modern daemon process. */
  daemonInstanceId?: string;
  /** Start time reported by that daemon process. */
  daemonStartedAt?: string;
  /** Number of observed changes from one known daemon process identity to another. */
  restartCount?: number;
  /** Control-plane time of the most recently observed process identity change. */
  lastRestartDetectedAt?: string;
  /** Most recently registered daemon/Git compatibility facts. */
  runtime?: HostRuntimeReport;
  repositories: Array<{
    id: string;
    path: string;
    defaultBranch: string;
    // `| undefined` since callers commonly forward an already-optional value verbatim
    // (e.g. modules/shared's HostRepository/HostWorktree, which use the same idiom).
    setupScript?: string | undefined;
    terminalHookScript?: string | undefined;
    requiredEnvironment?: string[] | undefined;
    providerAccountOverrides?: Record<string, ProviderAccountOverride>;
    worktrees: Array<{
      id: string;
      name: string;
      path: string;
      labels: string[];
      setupScript?: string | undefined;
      providerAccountOverrides?: Record<string, ProviderAccountOverride>;
    }>;
  }>;
  providerAccounts: Array<{ providerAccountId: string; commandId?: string }>;
  /** Empty/absent means an older daemon supports no optional capabilities. */
  capabilities?: HostCapability[] | undefined;
  updatedAt: string;
  /**
   * Optimistic-concurrency counter. The inventory document is replaced whole by
   * read-modify-write callers, so without this two concurrent editors silently discard
   * one another's changes. Absent on rows written before versioning existed.
   */
  version?: number;
};

export function sessionToItem(session: SessionRecord): Record<string, unknown> {
  return {
    ...session,
    statusShard: statusShardAttr(session.status, session.queueShard),
    queueOrder: queueOrderKey(session),
  };
}

export function itemToSession(item: Record<string, unknown>): SessionRecord {
  const { statusShard: _ss, queueOrder: _qo, ...rest } = item;
  return rest as SessionRecord;
}

export function isConditionalFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ConditionalCheckFailedException"
  );
}

/** A transaction is retryable only when a condition, not infrastructure,
 * canceled it. AWS exposes per-item cancellation reasons; do not turn a
 * throttling or validation cancellation into a false claim loss. */
export function isConditionalTransactionFailed(err: unknown): boolean {
  if (isConditionalFailed(err)) {
    return true;
  }
  if (
    typeof err !== "object" ||
    err === null ||
    !("name" in err) ||
    (err as { name?: string }).name !== "TransactionCanceledException"
  ) {
    return false;
  }
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.some((reason) => reason.Code === "ConditionalCheckFailed") ?? false;
}

/** Whether a particular transactional item, rather than any item, lost its condition. */
export function isConditionalTransactionFailureAt(err: unknown, index: number): boolean {
  if (
    typeof err !== "object" ||
    err === null ||
    !("name" in err) ||
    (err as { name?: string }).name !== "TransactionCanceledException"
  ) {
    return false;
  }
  const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.[index]?.Code === "ConditionalCheckFailed";
}

/**
 * Normalize a DynamoDB pagination cursor.
 *
 * `LastEvaluatedKey` is absent when a scan or query is exhausted, but an empty object is
 * truthy — so `while (startKey)` never terminates if one is ever returned. Three copies
 * of this guard existed under three names while seven drain loops used none of them.
 */
export function nextPageKey(
  key: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return key && Object.keys(key).length > 0 ? key : undefined;
}
