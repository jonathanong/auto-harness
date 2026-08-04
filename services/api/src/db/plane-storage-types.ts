import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoTableNames } from "./dynamo.ts";
import { statusShardAttr } from "./dynamo.ts";
import type { SessionRecord } from "./types.ts";

export type PlaneStorageCtx = {
  doc: DynamoDBDocumentClient;
  tables: DynamoTableNames;
};

export type ConnectionRecord = {
  connectionId: string;
  type: "agent" | "client";
  agentId: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  commandProfiles: string[];
};

export type ScheduleRecord = {
  id: string;
  repositoryId: string;
  name: string;
  commandProfile: string;
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

/** Durable agent host inventory (paths + command profile argv). */
export type AgentHostRecord = {
  agentId: string;
  repositories: Array<{
    id: string;
    path: string;
    defaultBranch: string;
    setupScript?: string;
    terminalHookScript?: string;
    worktrees: Array<{
      id: string;
      name: string;
      path: string;
      labels: string[];
      setupScript?: string;
    }>;
  }>;
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
