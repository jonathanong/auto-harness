import type { HostWireMessage, TargetRef } from "@auto-harness/shared";

import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { ArchiveWriter } from "./archive-writer.ts";
import type { ArchiveReader } from "./archive-reader.ts";
import type { SlackIdentityClient, SlackOAuthClient } from "./slack-oauth-types.ts";

export type { ConnectionRecord } from "./db/plane-storage-types.ts";
export type { LogQuery, LogRecord } from "./db/plane-storage-types.ts";

export type ScheduleRecord = {
  id: string;
  /** Empty string is the internal sentinel for a workspace-only schedule. */
  repositoryId: string;
  workspacePoolId?: string;
  setupProfileId?: string;
  destroyWorkspaceAfter?: boolean;
  name: string;
  target: TargetRef;
  fallbacks: TargetRef[];
  targetDisplayNames: string[];
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
  objectKey?: string;
  body: string;
  contentType: string;
};

/** Bounded durable pointer/state; archive bodies are never duplicated into DynamoDB. */
export type ArchiveMetadata = {
  key: string;
  objectKey?: string;
  contentType: string;
  bodyBytes: number;
  status: "pending" | "complete";
  objectStored: boolean;
  updatedAt: string;
  retryState?: "pending" | "processing";
  retryOrder?: string;
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
  /** Optional bounded Slack boundary used to verify manually configured event ingress. */
  slackOAuthClient?: SlackOAuthClient | undefined;
  /** Optional bounded Slack boundary used to identify manually supplied bot tokens. */
  slackIdentityClient?: SlackIdentityClient | undefined;
  publicBaseUrl?: string;
  now?: () => string;
  idFactory?: () => string;
  /** Factory for immutable scheduler assignment fences. */
  attemptIdFactory?: () => string;
  connectionIdFactory?: () => string;
  scheduleIdFactory?: () => string;
  repositoryIdFactory?: () => string;
  workspacePoolIdFactory?: () => string;
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
  archivePrefix?: string;
  /** Optional object-store boundary. Dynamo archive metadata remains durable separately. */
  archiveWriter?: ArchiveWriter | undefined;
  /** Optional object-store read boundary for verified, short-lived archive downloads. */
  archiveReader?: ArchiveReader | undefined;
  /** HMAC secret used to sign stable list cursors across API workers. */
  sessionCursorSecret?: string;
  onHostMessage?: (hostId: string, msg: HostWireMessage) => void;
  /**
   * When set, {@link ControlPlane.enqueueAssignment} calls this instead of running
   * the sweep in-process. AWS REST uses it to Event-invoke the cron function.
   */
  onAssignmentRequested?: () => void | Promise<void>;
};

export type PublicSession = Omit<
  SessionRecord,
  | "repositoryId"
  | "principalId"
  | "cancelledByDrainOperationId"
  | "activeHostId"
  | "activeHostOrder"
  | "sessionApiKeyHash"
  | "descendantCount"
> & {
  repositoryId: string | null;
  url: string;
};

export type PendingAck = {
  sessionId: string;
  /** Prompt sessions hold a worktree; scheduled sessions hold the host main-checkout lease. */
  worktreeId: string | null;
  attemptId: string;
  assignedAtMs: number;
};
