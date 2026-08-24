/* eslint-disable max-lines -- state shape and the durable write queue share one file. */
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
  ArchiveMetadata,
  ConnectionRecord,
  ControlPlaneOptions,
  LogRecord,
  PendingAck,
  PublicSession,
  ScheduleRecord,
} from "./control-plane-types.ts";
import type { AuditLogRecord } from "./audit-types.ts";
import type { UsageRecord } from "./usage.ts";
import type { ArchiveWriter } from "./archive-writer.ts";
import { enqueueSlackSessionLifecycle } from "./slack-session-runtime.ts";

/** Shared mutable state bag for ControlPlane subsystems. */
export type ControlPlaneState = {
  storage: DynamoPlaneStorage | undefined;
  /**
   * Durable writes still in flight. Fulfilled writes prune themselves; rejected ones stay
   * until settleStorage surfaces them. Retaining every settled write, as this used to,
   * grew one promise per write for the life of the process.
   */
  pendingPersists: Promise<void>[];
  /**
   * Log writes an archive must observe before it snapshots durable logs, keyed by
   * session. Keyed, because archiving one session used to await every log write since
   * process start, making archive cost scale with total output rather than the session's.
   */
  pendingLogPersists: Map<string, Set<Promise<void>>>;
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
  /** Invalidates repository scans that began before a local repository mutation committed. */
  repositoryRevision: number;
  hostInventories: Map<string, HostInventoryRecord>;
  /** Invalidates host inventory scans that began before a local inventory mutation committed. */
  hostInventoryRevision: number;
  providers: Map<string, ProviderRecord>;
  providerAccounts: Map<string, ProviderAccountRecord>;
  commands: Map<string, CommandRecord>;
  /** Ciphertext-only cache; REST reads always refresh it from durable storage. */
  slackIntegration: SlackIntegrationRecord | undefined;
  /** True when this process (or its deployed sibling cron) can run the Slack outbox. */
  slackOutboundEnabled: boolean;
  secretEncryptor: SecretEncryptor | undefined;
  /** Append-only audit records hydrated for local/in-memory reads. */
  auditLogs: Map<string, AuditLogRecord>;
  usageRecords: Map<string, UsageRecord>;
  archives: Map<string, ArchiveMetadata>;
  archiveWriter: ArchiveWriter | undefined;
  pendingAcks: Map<string, PendingAck>;
  /** In-memory counterpart of HostLocks.mainCheckoutLeases. Key is a pair
   * encoded with NUL, which repository IDs cannot contain on supported APIs. */
  mainCheckoutLeases: Map<string, { sessionId: string; connectionId: string }>;
  /**
   * In-memory counterpart of ConcurrencyLocks provider-account slots.
   * Keyed by the internal `provider-lease:` concurrency id.
   */
  providerAccountLeases: Map<
    string,
    {
      sessionId: string;
      attemptId: string;
      slot: number;
      hostId: string;
      providerAccountId: string;
    }
  >;
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
  sessionDrainIdFactory: () => string;
  shardCount: number;
  ackDeadlineMs: number;
  heartbeatStaleMs: number;
  reconnectGraceMs: number;
  sessionDrainTimeoutMs: number;
  usageLimitRetryCeiling: number;
  archivePrefix: string;
  /** Shared HMAC key for session-list and repository-list cursors. */
  sessionCursorSecret: string;
  onHostMessage: ((hostId: string, msg: HostWireMessage) => void) | undefined;
  /** Called only after a log is durable (or committed in the in-memory plane). */
  onLogCommitted: ((record: LogRecord) => void) | undefined;
};

export function createControlPlaneState(options: ControlPlaneOptions = {}): ControlPlaneState {
  if (
    options.archiveWriter &&
    (options.archivePrefix ?? DEFAULT_ARCHIVE_PREFIX) !== DEFAULT_ARCHIVE_PREFIX
  ) {
    throw new Error(`Archive writers require the ${DEFAULT_ARCHIVE_PREFIX} key prefix`);
  }
  return {
    storage: options.storage,
    pendingPersists: [],
    pendingLogPersists: new Map(),
    writeTail: Promise.resolve(),
    sessions: new Map(),
    worktrees: new Map(),
    connections: new Map(),
    hostConnection: new Map(),
    logs: new Map(),
    schedules: new Map(),
    repositories: new Map(),
    repositoryRevision: 0,
    hostInventories: new Map(),
    hostInventoryRevision: 0,
    providers: new Map(),
    providerAccounts: new Map(),
    commands: new Map(),
    slackIntegration: undefined,
    slackOutboundEnabled: false,
    secretEncryptor: options.secretEncryptor,
    auditLogs: new Map(),
    usageRecords: new Map(),
    archives: new Map(),
    archiveWriter: options.archiveWriter,
    pendingAcks: new Map(),
    mainCheckoutLeases: new Map(),
    providerAccountLeases: new Map(),
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
    sessionDrainIdFactory:
      options.sessionDrainIdFactory ?? (() => `drain-${randomBytes(12).toString("hex")}`),
    shardCount: options.shardCount ? options.shardCount : DEFAULT_QUEUE_SHARD_COUNT,
    ackDeadlineMs: options.ackDeadlineMs ? options.ackDeadlineMs : DEFAULT_ACK_DEADLINE_MS,
    heartbeatStaleMs: options.heartbeatStaleMs
      ? options.heartbeatStaleMs
      : DEFAULT_HEARTBEAT_STALE_MS,
    reconnectGraceMs: options.reconnectGraceMs ?? 75_000,
    sessionDrainTimeoutMs: options.sessionDrainTimeoutMs ?? 15 * 60_000,
    usageLimitRetryCeiling: options.usageLimitRetryCeiling ?? 3,
    archivePrefix: options.archivePrefix ? options.archivePrefix : DEFAULT_ARCHIVE_PREFIX,
    sessionCursorSecret:
      options.sessionCursorSecret ??
      process.env.HARNESS_CURSOR_SECRET ??
      process.env.HARNESS_SESSION_SECRET ??
      randomBytes(32).toString("base64url"),
    onHostMessage: options.onHostMessage,
    onLogCommitted: undefined,
  };
}
const noop = (): void => undefined;

export function queueWrite(
  state: ControlPlaneState,
  // Most storage calls resolve to a status/record value queueWrite deliberately never reads
  // (it only tracks completion/failure) — Promise<unknown> lets callers pass those directly.
  write: (storage: DynamoPlaneStorage | undefined) => Promise<unknown>,
): Promise<void> {
  const storage = state.storage;
  const queued: Promise<void> = state.writeTail.then(() => write(storage)).then(() => undefined);
  // Preserve the failure on `queued` for settleStorage, but recover the tail
  // so one failed asynchronous write does not permanently poison the queue.
  state.writeTail = queued.catch(() => undefined);
  state.pendingPersists.push(queued);
  void queued.then(() => {
    const index = state.pendingPersists.indexOf(queued);
    if (index >= 0) state.pendingPersists.splice(index, 1);
  }, noop);
  return queued;
}

/**
 * Track a session's log write so an archive of that session waits for it.
 *
 * Only a *successful* write is pruned. `archiveSessionLogs` awaits `Promise.all` over
 * this session's pending set, so a write left in it after failing makes that `Promise.all`
 * reject too — surfacing the incomplete transcript to the caller instead of silently
 * publishing an archive that is missing the chunk the failed write never persisted.
 * Pruning on `finally()` (settled, not just resolved) used to erase that signal.
 *
 * `.then(onSuccess, onFailure)` rather than `.finally()` for the same reason `queueWrite`
 * uses it: `.finally()` returns a new promise that passes the original rejection through,
 * so discarding it with a bare `void` (no `.catch()` on that *derived* promise) was itself
 * an unhandled rejection whenever `persisted` failed — independent of whether `persisted`
 * was already otherwise handled.
 */
export function trackLogPersist(
  state: ControlPlaneState,
  sessionId: string,
  persisted: Promise<void>,
): void {
  const pending = state.pendingLogPersists.get(sessionId) ?? new Set<Promise<void>>();
  pending.add(persisted);
  state.pendingLogPersists.set(sessionId, pending);
  void persisted.then(() => {
    pending.delete(persisted);
    if (pending.size === 0) state.pendingLogPersists.delete(sessionId);
  }, noop);
}

export function persistSession(state: ControlPlaneState, session: SessionRecord): void {
  const stored = { ...session };
  state.sessions.set(session.id, stored);
  if (state.storage) {
    queueWrite(state, async (storage) => {
      await storage!.putSession(stored);
      await enqueueSlackSessionLifecycle(state, stored);
    });
  }
}

/** Durable writers that already persisted the row still enqueue Slack here. */
export function noteSlackSessionLifecycle(state: ControlPlaneState, session: SessionRecord): void {
  const stored = { ...session };
  queueWrite(state, () => enqueueSlackSessionLifecycle(state, stored));
}

export function persistWorktree(state: ControlPlaneState, wt: WorktreeRecord): void {
  state.worktrees.set(wt.id, { ...wt });
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putWorktree({ ...wt }));
  }
}

export function toPublic(state: ControlPlaneState, session: SessionRecord): PublicSession {
  const {
    principalId: _principalId,
    cancelledByDrainOperationId: _cancelledByDrainOperationId,
    ...publicSession
  } = session;
  return {
    ...publicSession,
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
  state.pendingLogPersists = new Map();
  const results = await Promise.allSettled(pending);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
