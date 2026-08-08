import type { HostWireMessage, SessionStatus } from "@auto-harness/shared";

import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";

export type { ConnectionRecord } from "./db/plane-storage-types.ts";

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

export type WebhookDelivery = {
  url: string;
  sessionId: string;
  status: SessionStatus;
  deliveredAt: string;
  payload: string;
};

export type ControlPlaneOptions = {
  /**
   * DynamoDB persistence (Local or AWS). Required for production/local server.
   * When set, durable state is written through and critical claims use conditional
   * DynamoDB updates (Invariants 1, 3, 4).
   */
  storage?: DynamoPlaneStorage;
  publicBaseUrl?: string;
  now?: () => string;
  idFactory?: () => string;
  connectionIdFactory?: () => string;
  scheduleIdFactory?: () => string;
  repositoryIdFactory?: () => string;
  providerIdFactory?: () => string;
  providerAccountIdFactory?: () => string;
  commandIdFactory?: () => string;
  shardCount?: number;
  ackDeadlineMs?: number;
  heartbeatStaleMs?: number;
  usageLimitRetryCeiling?: number;
  archivePrefix?: string;
  /** Opt-in outbound webhook URL (Phase 5). */
  webhookUrl?: string | null;
  onAgentMessage?: (agentId: string, msg: HostWireMessage) => void;
};

export type PublicSession = SessionRecord & { url: string };

export type PendingAck = {
  sessionId: string;
  worktreeId: string;
  assignedAtMs: number;
};
