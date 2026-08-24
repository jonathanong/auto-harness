/* eslint-disable max-lines */
import {
  formatLogSortKey,
  isTerminalSessionStatus,
  type HostToServerMessage,
} from "@auto-harness/shared";

import type { LogRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, queueWrite, trackLogPersist } from "./control-plane-state.ts";
import {
  heartbeat,
  heartbeatDurable,
  drainHost,
  drainHostDurable,
  registerHost,
  registerHostDurable,
} from "./control-plane-agents.ts";
import {
  archiveSessionLogs,
  planSessionTransition,
  queueSessionArchive,
  retrySessionArchiveIfNeeded,
  transitionEffect,
} from "./control-plane-lifecycle.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import {
  finishSessionOptsFromPlan,
  requeueUsageLimitedSessionOptsFromPlan,
  suppressProviderlessUsageLimitOptsFromPlan,
} from "./db/plane-storage-sessions.ts";
import type { SessionRecord } from "./db/types.ts";
import type {
  SessionTransitionContext,
  SessionTransitionEvent,
} from "./session-transition-planner.ts";
import { assignQueued, assignQueuedDurable } from "./control-plane-assign.ts";
import {
  assignScheduledQueuedDurable,
  releaseScheduledLeaseLocal,
} from "./control-plane-scheduled-assign.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { ingestUsage, ingestUsageDurable } from "./control-plane-usage.ts";

const MAX_LOG_CHUNK_BYTES = 32 * 1024;
export const MAX_DURABLE_LOG_BATCH_SIZE = 25;
const MAX_RETAINED_LOG_CHUNKS = 10_000;
const MAX_RETAINED_LOG_BYTES = 10 * 1024 * 1024;

function legacyHostRuntime() {
  return {
    daemonVersion: "legacy/unknown",
    gitVersion: null,
    gitReady: false,
    gitReadinessReason: "git_readiness_unreported" as const,
  };
}

/**
 * Running size of each retained list, keyed by the list itself so it is discarded
 * whenever the list is replaced wholesale (a durable read rebuilds it). Without this the
 * bound cost a full re-measure of every retained chunk on every incoming chunk.
 */
const retainedByteTotals = new WeakMap<LogRecord[], number>();

function measure(records: readonly LogRecord[]): number {
  return records.reduce((total, item) => total + Buffer.byteLength(item.content), 0);
}

/**
 * Bound the in-memory replay cache for one session and return the retained list.
 *
 * Eviction is **only** a cache bound. Evicted chunks are deliberately not reported to the
 * caller: DynamoDB holds the durable transcript that `archiveSessionLogs` reads, and
 * deleting evicted rows there — which this used to do — silently destroyed the beginning
 * of any session that outgrew the window. Durable retention belongs to the SessionLogs
 * TTL (docs/plan.md Phase 2), not to a cache eviction.
 */
function retainLogs(state: ControlPlaneState, rec: LogRecord): LogRecord[] {
  const retained = state.logs.get(rec.sessionId) ?? [];
  let bytes = retainedByteTotals.get(retained) ?? measure(retained);

  // Chunks arrive in order, so this is an append in the common case. The walk back only
  // pays when a reconnect replays out of order, and it avoids re-sorting the whole list.
  let index = retained.length;
  while (index > 0 && retained[index - 1]!.timestampSeq.localeCompare(rec.timestampSeq) > 0) {
    index -= 1;
  }
  retained.splice(index, 0, rec);
  bytes += Buffer.byteLength(rec.content);

  while (retained.length > MAX_RETAINED_LOG_CHUNKS || bytes > MAX_RETAINED_LOG_BYTES) {
    const removed = retained.shift();
    if (!removed) break;
    bytes -= Buffer.byteLength(removed.content);
  }
  retainedByteTotals.set(retained, bytes);
  return retained;
}

function hostStatusEvent(
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
): Extract<SessionTransitionEvent, { type: "status" }> {
  return {
    type: "status",
    worktreeId: msg.worktreeId,
    attemptId: msg.attemptId,
    status: msg.status,
    ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
    ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
    ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
    ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
  };
}

function plannerContext(
  state: ControlPlaneState,
  source: SessionTransitionContext["source"],
  providerAccount?: SessionTransitionContext["providerAccount"],
): SessionTransitionContext {
  return {
    now: state.now(),
    source,
    usageLimitRetryCeiling: state.usageLimitRetryCeiling,
    ...(providerAccount !== undefined ? { providerAccount } : {}),
  };
}

function cachedProviderAccount(
  state: ControlPlaneState,
  session: SessionRecord | null | undefined,
): SessionTransitionContext["providerAccount"] {
  const accountId = session?.resolvedRoute?.providerAccountId;
  if (!accountId) return undefined;
  return state.providerAccounts.get(accountId) ?? null;
}

export function appendLog(
  state: ControlPlaneState,
  opts: {
    sessionId: string;
    stream: string;
    content: string;
    timestamp: string;
    seq: number;
  },
): LogRecord {
  const timestampSeq = formatLogSortKey(opts.timestamp, opts.seq);
  const rec: LogRecord = {
    sessionId: opts.sessionId,
    timestampSeq,
    stream: opts.stream,
    content: opts.content,
    timestamp: opts.timestamp,
    seq: opts.seq,
  };
  state.logs.set(opts.sessionId, retainLogs(state, rec));
  if (state.storage) {
    const persisted = queueWrite(state, async (storage) => {
      await storage!.putLog(rec);
      state.onLogCommitted?.(rec);
    });
    trackLogPersist(state, opts.sessionId, persisted);
  } else state.onLogCommitted?.(rec);
  return rec;
}

/** Persist first, then publish the log to the local cache. */
export async function appendLogDurable(
  state: ControlPlaneState,
  opts: {
    sessionId: string;
    stream: string;
    content: string;
    timestamp: string;
    seq: number;
  },
): Promise<LogRecord> {
  const rec: LogRecord = {
    sessionId: opts.sessionId,
    timestampSeq: formatLogSortKey(opts.timestamp, opts.seq),
    stream: opts.stream,
    content: opts.content,
    timestamp: opts.timestamp,
    seq: opts.seq,
  };
  if (state.storage) {
    await state.storage.putLog(rec);
  }
  state.logs.set(opts.sessionId, retainLogs(state, rec));
  state.onLogCommitted?.(rec);
  return rec;
}

export function getLogs(state: ControlPlaneState, sessionId: string): LogRecord[] {
  return [...(state.logs.get(sessionId) ?? [])];
}

type LogMessage = Extract<HostToServerMessage, { type: "session:log" }>;

/**
 * Commit adjacent WebSocket log frames in one bounded, connection-fenced
 * transaction. Records keep their agent-assigned sort keys and are published
 * to readers only after the whole transaction succeeds.
 */
export async function handleHostLogBatchDurable(
  state: ControlPlaneState,
  messages: readonly LogMessage[],
  sourceConnectionId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (messages.length === 0 || messages.length > MAX_DURABLE_LOG_BATCH_SIZE) {
    return { ok: false, error: "invalid log batch size" };
  }
  if (!state.storage) {
    for (const message of messages) {
      const result = handleHostMessage(state, message, sourceConnectionId);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  const storage = state.storage;
  let hostId: string | undefined;
  for (const message of messages) {
    if (Buffer.byteLength(message.content) > MAX_LOG_CHUNK_BYTES) {
      return { ok: false, error: "log chunk exceeds 32 KiB" };
    }
    const session =
      state.sessions.get(message.sessionId) ?? (await storage.getSession(message.sessionId));
    if (!session?.hostId || (hostId !== undefined && session.hostId !== hostId)) {
      return { ok: false, error: "stale host connection" };
    }
    hostId = session.hostId;
  }
  if (!hostId || (await storage.getHostLock(hostId)) !== sourceConnectionId) {
    return { ok: false, error: "stale host connection" };
  }
  const records = messages.map((message) => ({
    sessionId: message.sessionId,
    stream: message.stream,
    content: message.content,
    timestamp: message.timestamp,
    seq: message.seq,
    timestampSeq: formatLogSortKey(message.timestamp, message.seq),
  }));
  if (!(await storage.putLogsFenced(records, { hostId, connectionId: sourceConnectionId }))) {
    return { ok: false, error: "stale host connection" };
  }
  for (const record of records) {
    state.logs.set(record.sessionId, retainLogs(state, record));
    state.onLogCommitted?.(record);
  }
  return { ok: true };
}

export function handleHostMessage(
  state: ControlPlaneState,
  msg: HostToServerMessage,
  sourceConnectionId?: string,
): { ok: boolean; error?: string } {
  switch (msg.type) {
    case "host:register": {
      const r = registerHost(state, {
        hostId: msg.hostId,
        worktrees: msg.worktrees,
        ...(msg.repositories ? { repositories: msg.repositories } : {}),
        ...(msg.capabilities ? { capabilities: msg.capabilities } : {}),
        ...(msg.runningSessions ? { runningSessions: msg.runningSessions } : {}),
        ...(msg.daemonInstanceId && msg.daemonStartedAt
          ? {
              daemonIdentity: {
                instanceId: msg.daemonInstanceId,
                startedAt: msg.daemonStartedAt,
              },
            }
          : {}),
        runtime: msg.runtime ?? legacyHostRuntime(),
        ...(msg.draining ? { draining: true } : {}),
      });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "session:ack": {
      const session = state.sessions.get(msg.sessionId);
      if (!session) return { ok: false, error: "session not found" };
      const plan = planSessionTransition(
        session,
        { type: "ack", worktreeId: msg.worktreeId, attemptId: msg.attemptId },
        plannerContext(state, "local"),
      );
      const rejected = transitionEffect(plan, "reject");
      if (rejected) return { ok: false, error: rejected.error };
      if (!transitionEffect(plan, "ack")) return { ok: true };
      session.ackReceivedAt = state.now();
      state.pendingAcks.delete(msg.sessionId);
      if (session.hostId) {
        // In-memory control planes use the same peer-confirmation contract as
        // the durable WebSocket path. A completed send is not permission for
        // the daemon to start the CLI; this callback represents the accepted
        // in-memory state transition.
        state.onHostMessage?.(session.hostId, {
          type: "session:acknowledged",
          sessionId: session.id,
        });
      }
      return { ok: true };
    }
    case "session:status": {
      return applySessionStatus(state, msg);
    }
    case "session:usage": {
      return ingestUsage(state, msg);
    }
    case "session:log": {
      if (Buffer.byteLength(msg.content) > MAX_LOG_CHUNK_BYTES) {
        return { ok: false, error: "log chunk exceeds 32 KiB" };
      }
      appendLog(state, {
        sessionId: msg.sessionId,
        stream: msg.stream,
        content: msg.content,
        timestamp: msg.timestamp,
        seq: msg.seq,
      });
      return { ok: true };
    }
    case "host:keepalive": {
      return heartbeat(state, msg.hostId, msg.at)
        ? { ok: true }
        : { ok: false, error: "agent not connected" };
    }
    case "host:status": {
      const result = drainHost(state, msg.hostId, sourceConnectionId);
      return result.ok ? { ok: true } : { ok: false, error: "stale host connection" };
    }
  }
  return { ok: false, error: "unsupported host message" };
}

/**
 * Storage-backed message path. Critical ack/status transitions await their
 * conditional DynamoDB write before mutating the process cache. The original
 * synchronous handler remains the storage-less local CAS implementation.
 */
export async function handleHostMessageDurable(
  state: ControlPlaneState,
  msg: HostToServerMessage,
  sourceConnectionId?: string,
  replaceExisting = false,
  consumePendingConnection = false,
): Promise<{
  ok: boolean;
  error?: string;
  connectionId?: string;
  /** Present only after the durable ack transaction committed. */
  sessionAcknowledged?: string;
  /** Present only after the host's drain flag committed. */
  hostDraining?: string;
}> {
  if (msg.type === "host:register") {
    const result = await registerHostDurable(state, {
      hostId: msg.hostId,
      worktrees: msg.worktrees,
      ...(msg.repositories ? { repositories: msg.repositories } : {}),
      ...(msg.capabilities ? { capabilities: msg.capabilities } : {}),
      ...(msg.runningSessions ? { runningSessions: msg.runningSessions } : {}),
      ...(msg.daemonInstanceId && msg.daemonStartedAt
        ? {
            daemonIdentity: {
              instanceId: msg.daemonInstanceId,
              startedAt: msg.daemonStartedAt,
            },
          }
        : {}),
      runtime: msg.runtime ?? legacyHostRuntime(),
      ...(msg.draining ? { draining: true } : {}),
      replaceExisting,
      ...(sourceConnectionId ? { connectionId: sourceConnectionId } : {}),
      ...(consumePendingConnection ? { consumePendingConnection: true } : {}),
    });
    return result.ok
      ? { ok: true, connectionId: result.connectionId }
      : { ok: false, error: result.error };
  }
  if (!state.storage) {
    // The synchronous in-memory transition emits its own confirmation through
    // `onHostMessage`. Keeping it out of this result prevents a local WS hub
    // from delivering the same confirmation once through its bridge and once
    // as a direct socket response.
    return handleHostMessage(state, msg, sourceConnectionId);
  }
  const storage = state.storage;
  let fence: { hostId: string; connectionId: string } | undefined;
  if (sourceConnectionId) {
    const hostId =
      msg.type === "host:keepalive" || msg.type === "host:status"
        ? msg.hostId
        : (state.sessions.get(msg.sessionId)?.hostId ??
          (await storage.getSession(msg.sessionId))?.hostId);
    if (!hostId || (await storage.getHostLock(hostId)) !== sourceConnectionId) {
      return { ok: false, error: "stale host connection" };
    }
    fence = { hostId, connectionId: sourceConnectionId };
  }
  if (msg.type === "host:keepalive") {
    return (await heartbeatDurable(state, msg.hostId, msg.at))
      ? { ok: true }
      : { ok: false, error: "agent not connected" };
  }
  if (msg.type === "host:status") {
    const result = await drainHostDurable(state, msg.hostId, sourceConnectionId);
    return result.ok
      ? { ok: true, hostDraining: msg.hostId }
      : { ok: false, error: "stale host connection" };
  }
  if (msg.type === "session:log") {
    if (Buffer.byteLength(msg.content) > MAX_LOG_CHUNK_BYTES) {
      return { ok: false, error: "log chunk exceeds 32 KiB" };
    }
    const log = {
      sessionId: msg.sessionId,
      stream: msg.stream,
      content: msg.content,
      timestamp: msg.timestamp,
      seq: msg.seq,
    };
    if (fence) {
      if (
        !(await storage.putLogFenced(
          { ...log, timestampSeq: formatLogSortKey(log.timestamp, log.seq) },
          fence,
        ))
      ) {
        return { ok: false, error: "stale host connection" };
      }
      const retained = retainLogs(state, {
        ...log,
        timestampSeq: formatLogSortKey(log.timestamp, log.seq),
      });
      state.logs.set(log.sessionId, retained);
      state.onLogCommitted?.({ ...log, timestampSeq: formatLogSortKey(log.timestamp, log.seq) });
    } else {
      await appendLogDurable(state, log);
    }
    return { ok: true };
  }
  if (msg.type === "session:ack") {
    // Any API node can receive this frame. The process map is only a cache;
    // fetch the authoritative row before testing an execution fence.
    const session = await state.storage.getSession(msg.sessionId);
    if (!session) return { ok: false, error: "session not found" };
    const plan = planSessionTransition(
      session,
      { type: "ack", worktreeId: msg.worktreeId, attemptId: msg.attemptId },
      plannerContext(state, "durable"),
    );
    const rejected = transitionEffect(plan, "reject");
    if (rejected) return { ok: false, error: rejected.error };
    state.sessions.set(msg.sessionId, session);
    if (!transitionEffect(plan, "ack")) return { ok: true };
    const acknowledgedAt = state.now();
    const accepted = await state.storage.acknowledgeSession({
      sessionId: msg.sessionId,
      worktreeId: msg.worktreeId,
      attemptId: msg.attemptId,
      acknowledgedAt,
      ...(fence ? { fence } : {}),
    });
    if (accepted) {
      const { assignmentSentAt: _, ...acknowledged } = session;
      state.sessions.set(msg.sessionId, {
        ...acknowledged,
        ackReceivedAt: session.ackReceivedAt ?? acknowledgedAt,
      });
      state.pendingAcks.delete(msg.sessionId);
      return { ok: true, sessionAcknowledged: msg.sessionId };
    }
    return { ok: true };
  }
  if (msg.type === "session:status") {
    return applySessionStatusDurable(state, msg, storage, fence);
  }
  if (msg.type === "session:usage") {
    return ingestUsageDurable(state, msg, fence);
  }
  return { ok: false, error: "unsupported host message" };
}

async function applySessionStatusDurable(
  state: ControlPlaneState,
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
  storage: NonNullable<ControlPlaneState["storage"]>,
  fence?: { hostId: string; connectionId: string },
): Promise<{ ok: boolean; error?: string }> {
  if (msg.usage) {
    const usageResult = await ingestUsageDurable(
      state,
      {
        type: "session:usage",
        sessionId: msg.sessionId,
        worktreeId: msg.worktreeId,
        attemptId: msg.attemptId,
        usage: msg.usage,
      },
      fence,
    );
    if (!usageResult.ok) return usageResult;
  }
  // Do not trust a potentially missing or stale per-process session cache:
  // this node may not be the scheduler that emitted the assignment.
  const session =
    typeof storage.getSession === "function"
      ? await storage.getSession(msg.sessionId, true)
      : state.sessions.get(msg.sessionId);
  if (!session) {
    return { ok: false, error: "session not found" };
  }
  state.sessions.set(session.id, session);
  let providerAccount: SessionTransitionContext["providerAccount"];
  let loadedAccount: ReturnType<ControlPlaneState["providerAccounts"]["get"]> | null | undefined;
  const accountId = session.resolvedRoute?.providerAccountId;
  if (
    msg.status === "failed" &&
    msg.errorCode === "usage_limit" &&
    accountId &&
    session.worktreeId === msg.worktreeId &&
    session.attemptId === msg.attemptId
  ) {
    loadedAccount =
      typeof storage.getProviderAccount === "function"
        ? await storage.getProviderAccount(accountId)
        : state.providerAccounts.get(accountId);
    providerAccount = loadedAccount ?? null;
  }
  const plan = planSessionTransition(
    session,
    hostStatusEvent(msg),
    plannerContext(state, "durable", providerAccount),
  );
  const rejected = transitionEffect(plan, "reject");
  if (rejected) return { ok: false, error: rejected.error };
  if (transitionEffect(plan, "retry_archive")) {
    await retrySessionArchiveIfNeeded(state, session.id);
  }
  if (transitionEffect(plan, "ignore")) return { ok: true };
  if (
    session.status === "cancelled" &&
    session.worktreeId &&
    transitionEffect(plan, "release_worktree")
  ) {
    const worktreeId = session.worktreeId;
    const released = await storage.releaseCancelledSessionWorktree({
      sessionId: session.id,
      worktreeId,
      online: true,
      cliResumeRef: msg.cliResumeRef,
      fence,
      attemptId: msg.attemptId,
      concurrencyId: session.concurrencyId,
    });
    if (released) {
      const wt = state.worktrees.get(worktreeId);
      if (wt?.currentSessionId === session.id) {
        state.worktrees.set(worktreeId, {
          ...wt,
          status: "idle",
          currentSessionId: null,
          online: true,
        });
      }
      state.sessions.set(session.id, {
        ...session,
        worktreeId: null,
        ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
      });
      state.pendingAcks.delete(session.id);
    }
    return { ok: true };
  }
  if (
    session.status === "cancelled" &&
    session.mainCheckoutLease &&
    session.hostId &&
    session.assignmentConnectionId &&
    transitionEffect(plan, "release_lease")
  ) {
    const released = await storage.releaseMainCheckoutSession({
      sessionId: session.id,
      hostId: session.hostId,
      repositoryId: session.repositoryId,
      connectionId: session.assignmentConnectionId,
      attemptId: msg.attemptId,
      status: "cancelled",
      expectedStatus: "cancelled",
      queueShard: session.queueShard,
      completedAt: session.completedAt ?? state.now(),
      exitCode: msg.exitCode,
      errorCode: msg.errorCode,
      reason: msg.errorMessage,
      cliResumeRef: msg.cliResumeRef,
      concurrencyId: session.concurrencyId,
    });
    if (released) {
      releaseScheduledLeaseLocal(state, session);
      const { mainCheckoutLease: _, ...next } = {
        ...session,
        worktreeId: null,
        ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
        ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
        ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
        ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
      };
      delete next.assignmentConnectionId;
      delete next.assignmentSentAt;
      delete next.ackReceivedAt;
      delete next.reconnectDeadlineAt;
      state.sessions.set(session.id, next);
      state.pendingAcks.delete(session.id);
    }
    return { ok: true };
  }
  if (session.status !== "running") {
    return { ok: true };
  }
  const cooldown = transitionEffect(plan, "cooldown");
  const requeue = transitionEffect(plan, "requeue");
  const suppress = transitionEffect(plan, "suppress_target");
  const finish = transitionEffect(plan, "finish");
  if (session.mainCheckoutLease && session.hostId && session.assignmentConnectionId) {
    const providerAccountId = session.resolvedRoute?.providerAccountId;
    if (requeue?.reason === "missing_account" && providerAccountId) {
      state.providerAccounts.delete(providerAccountId);
      const requeued = await storage.releaseMainCheckoutSession({
        sessionId: session.id,
        hostId: session.hostId,
        repositoryId: session.repositoryId,
        connectionId: session.assignmentConnectionId,
        attemptId: msg.attemptId,
        status: "queued",
        queueShard: session.queueShard,
        reason: "provider account missing; requeued",
        errorCode: "usage_limit",
      });
      if (!requeued) return { ok: true };
      releaseScheduledLeaseLocal(state, session);
      state.sessions.set(session.id, {
        ...queueReconnectSession(session, "provider account missing; requeued"),
        errorCode: "usage_limit",
      });
      state.pendingAcks.delete(session.id);
      await assignScheduledQueuedDurable(state);
      return { ok: true };
    }
    if (requeue && cooldown && providerAccountId) {
      const now = state.now();
      const requeued = await storage.requeueMainCheckoutUsageLimitedSession({
        sessionId: session.id,
        hostId: session.hostId,
        repositoryId: session.repositoryId,
        connectionId: session.assignmentConnectionId,
        attemptId: msg.attemptId,
        providerAccountId,
        queueShard: session.queueShard,
        now,
        usageLimitedUntil: cooldown.usageLimitedUntil,
        errorMessage: msg.errorMessage,
      });
      if (!requeued) return { ok: true };
      releaseScheduledLeaseLocal(state, session);
      state.sessions.set(session.id, {
        ...queueReconnectSession(session, msg.errorMessage ?? "provider usage limit; requeued"),
        errorCode: "usage_limit",
      });
      const cachedAccount = state.providerAccounts.get(providerAccountId);
      if (cachedAccount) {
        state.providerAccounts.set(providerAccountId, {
          ...cachedAccount,
          usageLimitedUntil: cooldown.usageLimitedUntil,
          lastUsageLimitedAt: now,
          updatedAt: now,
        });
      }
      state.pendingAcks.delete(session.id);
      await assignScheduledQueuedDurable(state);
      return { ok: true };
    }
    const shouldRetry = requeue?.reason === "usage_limit_retry";
    const committed = await storage.releaseMainCheckoutSession({
      sessionId: session.id,
      hostId: session.hostId,
      repositoryId: session.repositoryId,
      connectionId: session.assignmentConnectionId,
      attemptId: msg.attemptId,
      status: shouldRetry ? "queued" : (finish?.status ?? msg.status),
      queueShard: session.queueShard,
      ...(requeue?.reason === "usage_limit_retry"
        ? { retryCount: requeue.retryCount, retryAfter: requeue.retryAfter }
        : { completedAt: finish?.completedAt ?? state.now() }),
      ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
      ...(msg.errorCode ? { errorCode: msg.errorCode } : {}),
      ...(msg.cliResumeRef ? { cliResumeRef: msg.cliResumeRef } : {}),
      ...(msg.errorMessage ? { reason: msg.errorMessage } : {}),
      ...(!shouldRetry && session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
    });
    if (!committed) return { ok: true };
    releaseScheduledLeaseLocal(state, session);
    const { mainCheckoutLease: _, ...next } = {
      ...session,
      status: shouldRetry ? ("queued" as const) : (finish?.status ?? msg.status),
      worktreeId: null,
      ...(requeue?.reason === "usage_limit_retry"
        ? { hostId: null, retryCount: requeue.retryCount, retryAfter: requeue.retryAfter }
        : { completedAt: finish?.completedAt ?? state.now() }),
      ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
      ...(msg.errorCode ? { errorCode: msg.errorCode } : {}),
      ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
      ...(msg.cliResumeRef ? { cliResumeRef: msg.cliResumeRef } : {}),
    };
    delete next.assignmentConnectionId;
    delete next.assignmentSentAt;
    delete next.ackReceivedAt;
    delete next.reconnectDeadlineAt;
    if (shouldRetry) delete next.startedAt;
    state.sessions.set(session.id, next);
    state.pendingAcks.delete(session.id);
    if (!shouldRetry) {
      await archiveSessionLogs(state, session.id);
    }
    return { ok: true };
  }
  if (cooldown && requeue && session.worktreeId) {
    const now = state.now();
    const committed = await storage.requeueUsageLimitedSession(
      requeueUsageLimitedSessionOptsFromPlan(session, plan, { now, attemptId: msg.attemptId }),
    );
    if (!committed) return { ok: true };
    const wt = state.worktrees.get(session.worktreeId);
    if (wt) state.worktrees.set(wt.id, { ...wt, status: "idle", currentSessionId: null });
    const account = loadedAccount ?? state.providerAccounts.get(cooldown.providerAccountId);
    if (account) {
      state.providerAccounts.set(cooldown.providerAccountId, {
        ...account,
        usageLimitedUntil: cooldown.usageLimitedUntil,
        lastUsageLimitedAt: now,
        updatedAt: now,
      });
    }
    state.sessions.set(session.id, {
      ...session,
      status: "queued",
      worktreeId: null,
      hostId: null,
      errorCode: "usage_limit",
      errorMessage: msg.errorMessage ?? "provider usage limit; requeued",
    });
    state.pendingAcks.delete(session.id);
    await assignQueuedDurable(state);
    return { ok: true };
  }
  const shouldSuppressTarget = suppress !== undefined;
  if (shouldSuppressTarget && session.worktreeId) {
    const committed = await storage.suppressProviderlessUsageLimit(
      suppressProviderlessUsageLimitOptsFromPlan(session, plan, { attemptId: msg.attemptId }),
    );
    if (!committed) return { ok: true };
    const worktree = state.worktrees.get(session.worktreeId);
    if (worktree)
      state.worktrees.set(worktree.id, { ...worktree, status: "idle", currentSessionId: null });
    state.sessions.set(session.id, {
      ...session,
      status: "queued",
      worktreeId: null,
      hostId: null,
      suppressedTargetIndexes: [...(session.suppressedTargetIndexes ?? []), suppress.targetIndex],
    });
    state.pendingAcks.delete(session.id);
    await assignQueuedDurable(state);
    return { ok: true };
  }
  const committed = await storage.finishSession(
    finishSessionOptsFromPlan(session, plan, {
      attemptId: msg.attemptId,
      ...(fence ? { fence } : {}),
    }),
  );
  if (!committed) {
    return { ok: true };
  }
  const worktreeId = session.worktreeId;
  if (worktreeId) {
    const wt = state.worktrees.get(worktreeId);
    if (wt) {
      state.worktrees.set(worktreeId, {
        ...wt,
        status: "idle",
        currentSessionId: null,
      });
    }
  }
  const nextStatus = shouldSuppressTarget ? "queued" : (finish?.status ?? msg.status);
  const nextSession = {
    ...session,
    status: nextStatus,
    ...(shouldSuppressTarget ? {} : { completedAt: state.now() }),
    worktreeId: null,
    hostId: null,
    ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
    ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
    ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
    ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
    ...(shouldSuppressTarget
      ? {
          suppressedTargetIndexes: [
            ...(session.suppressedTargetIndexes ?? []),
            session.resolvedRoute?.targetIndex ?? 0,
          ],
        }
      : {}),
  };
  state.sessions.set(msg.sessionId, nextSession);
  state.pendingAcks.delete(msg.sessionId);
  if (!shouldSuppressTarget) {
    await archiveSessionLogs(state, msg.sessionId);
  }
  if (shouldSuppressTarget) await assignQueuedDurable(state);
  return { ok: true };
}

function applySessionStatus(
  state: ControlPlaneState,
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
): { ok: boolean; error?: string } {
  if (msg.usage) {
    const usageResult = ingestUsage(state, {
      type: "session:usage",
      sessionId: msg.sessionId,
      worktreeId: msg.worktreeId,
      attemptId: msg.attemptId,
      usage: msg.usage,
    });
    if (!usageResult.ok) return usageResult;
  }
  const session = state.sessions.get(msg.sessionId);
  if (!session) return { ok: false, error: "session not found" };
  const plan = planSessionTransition(
    session,
    hostStatusEvent(msg),
    plannerContext(state, "local", cachedProviderAccount(state, session)),
  );
  const rejected = transitionEffect(plan, "reject");
  if (rejected) return { ok: false, error: rejected.error };
  if (transitionEffect(plan, "ignore")) return { ok: true };

  const terminal = isTerminalSessionStatus(msg.status);
  const patch = transitionEffect(plan, "patch_report");

  if (session.status !== "running") {
    if (transitionEffect(plan, "release_lease") && session.mainCheckoutLease) {
      releaseScheduledLeaseLocal(state, session);
      delete session.mainCheckoutLease;
      delete session.assignmentConnectionId;
      delete session.assignmentSentAt;
      delete session.ackReceivedAt;
      delete session.reconnectDeadlineAt;
      session.worktreeId = null;
    }
    if (transitionEffect(plan, "release_worktree") && session.worktreeId) {
      const wt = state.worktrees.get(session.worktreeId);
      if (wt?.currentSessionId === session.id) {
        releaseWorktree(state, session.worktreeId);
      }
      session.worktreeId = null;
    }
    if (patch?.cliResumeRef !== undefined) session.cliResumeRef = patch.cliResumeRef;
    persistSession(state, session);
    return { ok: true };
  }

  const releasedMainCheckout = transitionEffect(plan, "release_lease")
    ? releaseScheduledLeaseLocal(state, session)
    : false;
  if (
    transitionEffect(plan, "release_lease") &&
    session.mainCheckoutLease &&
    !releasedMainCheckout
  ) {
    return { ok: true };
  }

  session.status = patch?.status ?? msg.status;
  if (msg.exitCode !== undefined) {
    session.exitCode = msg.exitCode;
  }
  if (msg.errorCode !== undefined) {
    session.errorCode = msg.errorCode;
  }
  if (msg.errorMessage !== undefined) {
    session.errorMessage = msg.errorMessage;
  }
  if (msg.cliResumeRef !== undefined) {
    session.cliResumeRef = msg.cliResumeRef;
  }

  if (terminal) {
    session.completedAt = state.now();
    state.pendingAcks.delete(msg.sessionId);
    if (session.mainCheckoutLease) {
      delete session.mainCheckoutLease;
      delete session.assignmentConnectionId;
      delete session.assignmentSentAt;
      delete session.ackReceivedAt;
      delete session.reconnectDeadlineAt;
    } else if (transitionEffect(plan, "release_worktree") && session.worktreeId) {
      releaseWorktree(state, session.worktreeId);
    }

    const cooldown = transitionEffect(plan, "cooldown");
    const requeue = transitionEffect(plan, "requeue");
    const suppress = transitionEffect(plan, "suppress_target");
    const finish = transitionEffect(plan, "finish");
    if (cooldown) {
      const account = state.providerAccounts.get(cooldown.providerAccountId);
      if (account) {
        account.usageLimitedUntil = cooldown.usageLimitedUntil;
        account.lastUsageLimitedAt = state.now();
        account.updatedAt = state.now();
        state.providerAccounts.set(cooldown.providerAccountId, account);
      }
    }
    if (suppress) {
      session.suppressedTargetIndexes = [
        ...(session.suppressedTargetIndexes ?? []),
        suppress.targetIndex,
      ];
    }
    if (requeue) {
      session.status = "queued";
      session.worktreeId = null;
      session.hostId = null;
      delete session.completedAt;
      if (requeue.reason === "usage_limit_retry") {
        session.retryCount = requeue.retryCount;
        session.retryAfter = requeue.retryAfter;
      }
      const reschedule = transitionEffect(plan, "reschedule");
      if (reschedule?.kind === "scheduled") {
        void assignScheduledQueuedDurable(state).catch(() => undefined);
      } else if (reschedule) {
        void assignQueued(state);
      }
    } else if (finish) {
      session.worktreeId = null;
      // A continuation reference is single-use: a resumed command must report
      // a fresh one if it wants to support another native continuation.
      if (finish.clearResumeRef) {
        delete session.cliResumeRef;
      }
      queueSessionArchive(state, session.id);
    }
  }
  persistSession(state, session);
  return { ok: true };
}
