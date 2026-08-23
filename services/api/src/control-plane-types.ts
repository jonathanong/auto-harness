import type { HostWireMessage, TargetRef } from "@auto-harness/shared";

import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { ArchiveWriter } from "./archive-writer.ts";

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
  /** Authenticated principal that owns sessions emitted by this schedule. */
  principalId?: string;
  /** Prompt passed to the CLI when this schedule fires. Missing/blank stays empty. */
  prompt?: string;
  /** Computed for API responses; never persisted. */
  activeSessionId?: string | null;
};

export type ArchiveObject = {
  key: string;
  body: string;
  contentType: string;
};

/** Bounded durable pointer/state; archive bodies are never duplicated into DynamoDB. */
export type ArchiveMetadata = {
  key: string;
  contentType: string;
  bodyBytes: number;
  status: "pending" | "complete";
  objectStored: boolean;
  updatedAt: string;
};

export type ControlPlaneOptions = {
  /**
   * DynamoDB persistence (Local or AWS). Required for production/local server.
   * When set, durable state is written through and critical claims use conditional
   * DynamoDB updates (Invariants 1, 3, 4).
   */
  storage?: DynamoPlaneStorage;
  /** KMS-backed boundary; absent means integration writes fail closed. */
  secretEncryptor?: SecretEncryptor | undefined;
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
  sessionDrainIdFactory?: () => string;
  sessionDrainTimeoutMs?: number;
  shardCount?: number;
  ackDeadlineMs?: number;
  heartbeatStaleMs?: number;
  reconnectGraceMs?: number;
  usageLimitRetryCeiling?: number;
  archivePrefix?: string;
  /** Optional object-store boundary. Dynamo archive metadata remains durable separately. */
  archiveWriter?: ArchiveWriter | undefined;
  /** HMAC secret used to sign stable list cursors across API workers. */
  sessionCursorSecret?: string;
  onHostMessage?: (hostId: string, msg: HostWireMessage) => void;
};

export type PublicSession = Omit<SessionRecord, "principalId" | "cancelledByDrainOperationId"> & {
  url: string;
};

export type PendingAck = {
  sessionId: string;
  /** Prompt sessions hold a worktree; scheduled sessions hold the host main-checkout lease. */
  worktreeId: string | null;
  attemptId: string;
  assignedAtMs: number;
};
