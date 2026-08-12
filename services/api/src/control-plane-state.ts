import { randomBytes } from "node:crypto";

import {
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_QUEUE_SHARD_COUNT,
  newId,
  type HostWireMessage,
} from "@auto-harness/shared";

import type {
  HostInventoryRecord,
  CommandRecord,
  DynamoPlaneStorage,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./db/plane-storage.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { hydrateFromStorage } from "./control-plane-hydrate.ts";
import type {
  ArchiveObject,
  ConnectionRecord,
  ControlPlaneOptions,
  LogRecord,
  PendingAck,
  PublicSession,
  ScheduleRecord,
  WebhookDelivery,
} from "./control-plane-types.ts";
import type { AuditLogRecord } from "./audit-types.ts";
import type { UsageRecord } from "./usage.ts";
import type { ArchiveWriter } from "./archive-writer.ts";

/** Shared mutable state bag for ControlPlane subsystems. */
export type ControlPlaneState = {
  storage: DynamoPlaneStorage | undefined;
  pendingPersists: Promise<void>[];
  /**
   * Serializes fire-and-forget durable writes without starting the next write
   * until the preceding one has settled. The recovered tail deliberately keeps
   * later writes runnable after an earlier write fails.
   */
  writeTail: Promise<void>;
  sessions: Map<string, SessionRecord>;
  worktrees: Map<string, WorktreeRecord>;
  connections: Map<string, ConnectionRecord>;
  /** hostId → connectionId (at most one live agent connection — Invariant 3). */
  hostConnection: Map<string, string>;
  logs: Map<string, LogRecord[]>;
  schedules: Map<string, ScheduleRecord>;
  repositories: Map<string, RepositoryRecord>;
  hostInventories: Map<string, HostInventoryRecord>;
  /** Invalidates host inventory scans that began before a local inventory mutation committed. */
  hostInventoryRevision: number;
  providers: Map<string, ProviderRecord>;
  providerAccounts: Map<string, ProviderAccountRecord>;
  commands: Map<string, CommandRecord>;
  /** Ciphertext-only cache; REST reads always refresh it from durable storage. */
  slackIntegration: SlackIntegrationRecord | undefined;
  secretEncryptor: SecretEncryptor | undefined;
  /** Append-only audit records hydrated for local/in-memory reads. */
  auditLogs: Map<string, AuditLogRecord>;
  usageRecords: Map<string, UsageRecord>;
  archives: Map<string, ArchiveObject>;
  archiveWriter: ArchiveWriter | undefined;
  webhookDeliveries: WebhookDelivery[];
  pendingAcks: Map<string, PendingAck>;
  /** In-memory counterpart of HostLocks.mainCheckoutLeases. Key is a pair
   * encoded with NUL, which repository IDs cannot contain on supported APIs. */
  mainCheckoutLeases: Map<string, { sessionId: string; connectionId: string }>;
  /** Agents in drain: no new assigns; worktrees stay offline after release (Phase 5). */
  drainingHosts: Set<string>;
  /**
   * Agents without a live connection that still need heartbeat-style reclaim
   * (e.g. after disconnect while busy). lastHeartbeatAt is when they went offline.
   */
  disconnectedHosts: Map<string, { lastHeartbeatAt: string }>;
  publicBaseUrl: string;
  now: () => string;
  idFactory: () => string;
  attemptIdFactory: () => string;
  connectionIdFactory: () => string;
  scheduleIdFactory: () => string;
  repositoryIdFactory: () => string;
  providerIdFactory: () => string;
  providerAccountIdFactory: () => string;
  commandIdFactory: () => string;
  auditIdFactory: () => string;
  shardCount: number;
  ackDeadlineMs: number;
  heartbeatStaleMs: number;
  reconnectGraceMs: number;
  usageLimitRetryCeiling: number;
  archivePrefix: string;
  sessionCursorSecret: string;
  webhookUrl: string | null;
  onHostMessage: ((hostId: string, msg: HostWireMessage) => void) | undefined;
  /** Called only after a log is durable (or committed in the in-memory plane). */
  onLogCommitted: ((record: LogRecord) => void) | undefined;
};

export function createControlPlaneState(options: ControlPlaneOptions = {}): ControlPlaneState {
  return {
    storage: options.storage,
    pendingPersists: [],
    writeTail: Promise.resolve(),
    sessions: new Map(),
    worktrees: new Map(),
    connections: new Map(),
    hostConnection: new Map(),
    logs: new Map(),
    schedules: new Map(),
    repositories: new Map(),
    hostInventories: new Map(),
    hostInventoryRevision: 0,
    providers: new Map(),
    providerAccounts: new Map(),
    commands: new Map(),
    slackIntegration: undefined,
    secretEncryptor: options.secretEncryptor,
    auditLogs: new Map(),
    usageRecords: new Map(),
    archives: new Map(),
    archiveWriter: options.archiveWriter,
    webhookDeliveries: [],
    pendingAcks: new Map(),
    mainCheckoutLeases: new Map(),
    drainingHosts: new Set(),
    disconnectedHosts: new Map(),
    publicBaseUrl: options.publicBaseUrl ?? "http://localhost:7421",
    now: options.now ?? (() => new Date().toISOString()),
    idFactory: options.idFactory ?? (() => `sess-${randomBytes(4).toString("hex")}`),
    attemptIdFactory:
      options.attemptIdFactory ?? (() => `attempt-${randomBytes(12).toString("hex")}`),
    connectionIdFactory:
      options.connectionIdFactory ?? (() => `conn-${randomBytes(4).toString("hex")}`),
    scheduleIdFactory: options.scheduleIdFactory
      ? options.scheduleIdFactory
      : () => `sched-${randomBytes(4).toString("hex")}`,
    repositoryIdFactory: options.repositoryIdFactory ? options.repositoryIdFactory : newId,
    providerIdFactory: options.providerIdFactory ? options.providerIdFactory : newId,
    providerAccountIdFactory: options.providerAccountIdFactory
      ? options.providerAccountIdFactory
      : newId,
    commandIdFactory: options.commandIdFactory ? options.commandIdFactory : newId,
    auditIdFactory: options.auditIdFactory
      ? options.auditIdFactory
      : () => `audit-${randomBytes(12).toString("hex")}`,
    shardCount: options.shardCount ? options.shardCount : DEFAULT_QUEUE_SHARD_COUNT,
    ackDeadlineMs: options.ackDeadlineMs ? options.ackDeadlineMs : DEFAULT_ACK_DEADLINE_MS,
    heartbeatStaleMs: options.heartbeatStaleMs
      ? options.heartbeatStaleMs
      : DEFAULT_HEARTBEAT_STALE_MS,
    reconnectGraceMs: options.reconnectGraceMs ?? 75_000,
    usageLimitRetryCeiling: options.usageLimitRetryCeiling ?? 3,
    archivePrefix: options.archivePrefix ? options.archivePrefix : DEFAULT_ARCHIVE_PREFIX,
    sessionCursorSecret:
      options.sessionCursorSecret ??
      process.env.HARNESS_CURSOR_SECRET ??
      process.env.HARNESS_SESSION_SECRET ??
      randomBytes(32).toString("base64url"),
    webhookUrl: options.webhookUrl ? options.webhookUrl : null,
    onHostMessage: options.onHostMessage,
    onLogCommitted: undefined,
  };
}
export function queueWrite(
  state: ControlPlaneState,
  write: (storage: DynamoPlaneStorage | undefined) => Promise<void>,
): void {
  const storage = state.storage;
  const queued = state.writeTail.then(() => write(storage));
  // Preserve the failure on `queued` for settleStorage, but recover the tail
  // so one failed asynchronous write does not permanently poison the queue.
  state.writeTail = queued.catch(() => undefined);
  state.pendingPersists.push(queued);
}

export function persistSession(state: ControlPlaneState, session: SessionRecord): void {
  state.sessions.set(session.id, { ...session });
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putSession({ ...session }));
  }
}

export function persistWorktree(state: ControlPlaneState, wt: WorktreeRecord): void {
  state.worktrees.set(wt.id, { ...wt });
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putWorktree({ ...wt }));
  }
}

export function toPublic(state: ControlPlaneState, session: SessionRecord): PublicSession {
  return {
    ...session,
    url: `${state.publicBaseUrl}/sessions/${session.id}`,
  };
}

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export { hydrateFromStorage };
export async function settleStorage(state: ControlPlaneState): Promise<void> {
  const pending = state.pendingPersists;
  state.pendingPersists = [];
  const results = await Promise.allSettled(pending);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
