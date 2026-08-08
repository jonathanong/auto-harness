import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Command, Provider, ProviderAccount } from "@auto-harness/shared";

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

export type ConnectionRecord = {
  connectionId: string;
  type: "host" | "client";
  hostId: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  commandProfiles: string[];
};

export type ScheduleRecord = {
  id: string;
  repositoryId: string;
  name: string;
  /** Exactly one of providerAccountId/commandId is set. */
  providerAccountId?: string;
  commandId?: string;
  targetLabel: string;
  cron: string;
  enabled: boolean;
  timeout: number;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  ref?: string;
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
