import type { HostWireMessage, SessionStatus, TargetRef } from "@auto-harness/shared";

import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";

export type { ConnectionRecord } from "./db/plane-storage-types.ts";
export type { LogQuery, LogRecord } from "./db/plane-storage-types.ts";

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
  /** Computed for API responses; never persisted. */
  activeSessionId?: string | null;
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
  /** Factory for immutable scheduler assignment fences. */
  attemptIdFactory?: () => string;
  connectionIdFactory?: () => string;
  scheduleIdFactory?: () => string;
  repositoryIdFactory?: () => string;
  providerIdFactory?: () => string;
  providerAccountIdFactory?: () => string;
  commandIdFactory?: () => string;
  auditIdFactory?: () => string;
  shardCount?: number;
  ackDeadlineMs?: number;
  heartbeatStaleMs?: number;
  reconnectGraceMs?: number;
  usageLimitRetryCeiling?: number;
  archivePrefix?: string;
  /** HMAC secret used to sign session-list cursors across API workers. */
  sessionCursorSecret?: string;
  /** Opt-in outbound webhook URL (Phase 5). */
  webhookUrl?: string | null;
  onHostMessage?: (hostId: string, msg: HostWireMessage) => void;
};

export type PublicSession = SessionRecord & { url: string };

export type PendingAck = {
  sessionId: string;
  /** Prompt sessions hold a worktree; scheduled sessions hold the host main-checkout lease. */
  worktreeId: string | null;
  attemptId: string;
  assignedAtMs: number;
};
