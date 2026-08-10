import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type {
  Command,
  HostCapability,
  Provider,
  ProviderAccount,
  TargetRef,
} from "@auto-harness/shared";

import type { DynamoTableNames } from "./dynamo.ts";
import { statusShardAttr } from "./dynamo.ts";
import type { SessionRecord } from "./types.ts";

export type PlaneStorageCtx = {
  doc: DynamoDBDocumentClient;
  tables: DynamoTableNames;
};

export type ProviderRecord = Provider;
export type ProviderAccountRecord = ProviderAccount;
export type CommandRecord = Command;

/** Authentication principal record stored in the dedicated Users table. */
export type AuthAccountRecord = {
  id: string;
  username: string;
  name?: string;
  kind: "user" | "service-account";
  role: "read-only" | "operator" | "admin";
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
  commandProfiles: string[];
  /** Empty/absent means an older daemon supports no optional capabilities. */
  capabilities?: HostCapability[];
};

export type ScheduleRecord = {
  id: string;
  repositoryId: string;
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
};

export type LogRecord = {
  sessionId: string;
  timestampSeq: string;
  stream: string;
  content: string;
  timestamp: string;
  seq: number;
};

export type ArchiveObject = {
  key: string;
  body: string;
  contentType: string;
};

export type RepositoryRecord = {
  id: string;
  name: string;
  /** Git remote URL and/or local path identity for operators. */
  url: string;
  defaultBranch: string;
  setupScript?: string;
  terminalHookScript?: string;
  createdAt: string;
  updatedAt: string;
};

/** Enable/command override for a provider account at a repository or worktree scope. */
export type ProviderAccountOverride = { enabled?: boolean; commandId?: string };

/** Durable agent host inventory (paths + command profile argv). */
export type HostInventoryRecord = {
  hostId: string;
  repositories: Array<{
    id: string;
    path: string;
    defaultBranch: string;
    setupScript?: string;
    terminalHookScript?: string;
    providerAccountOverrides?: Record<string, ProviderAccountOverride>;
    worktrees: Array<{
      id: string;
      name: string;
      path: string;
      labels: string[];
      setupScript?: string;
      providerAccountOverrides?: Record<string, ProviderAccountOverride>;
    }>;
  }>;
  providerAccounts: Array<{ providerAccountId: string; commandId?: string }>;
  commandProfiles: Record<string, { argv: string[]; appendPrompt: boolean }>;
  /** Empty/absent means an older daemon supports no optional capabilities. */
  capabilities?: HostCapability[];
  logLevel?: "debug" | "info" | "warn" | "error";
  updatedAt: string;
};

export function sessionToItem(session: SessionRecord): Record<string, unknown> {
  return {
    ...session,
    statusShard: statusShardAttr(session.status, session.queueShard),
  };
}

export function itemToSession(item: Record<string, unknown>): SessionRecord {
  const { statusShard: _ss, ...rest } = item;
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
