/* eslint-disable max-lines */
import {
  formatLogSortKey,
  isTerminalSessionStatus,
  type HostToServerMessage,
} from "@auto-harness/shared";

import type { LogRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, queueWrite } from "./control-plane-state.ts";
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
  retrySessionArchiveIfNeeded,
  maybeDeliverWebhook,
  queueSessionArchive,
} from "./control-plane-lifecycle.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
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

function retainLogs(
  state: ControlPlaneState,
  rec: LogRecord,
): {
  retained: LogRecord[];
  evicted: LogRecord[];
} {
  const retained = [...(state.logs.get(rec.sessionId) ?? []), rec].toSorted((a, b) =>
    a.timestampSeq.localeCompare(b.timestampSeq),
  );
  let retainedBytes = retained.reduce((total, item) => total + Buffer.byteLength(item.content), 0);
  const evicted: LogRecord[] = [];
  while (retained.length > MAX_RETAINED_LOG_CHUNKS || retainedBytes > MAX_RETAINED_LOG_BYTES) {
    const removed = retained.shift();
    if (removed) {
      retainedBytes -= Buffer.byteLength(removed.content);
      evicted.push(removed);
    }
  }
  return { retained, evicted };
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
  const { retained, evicted } = retainLogs(state, rec);
  state.logs.set(opts.sessionId, retained);
  if (state.storage) {
    queueWrite(state, async (storage) => {
      await storage!.putLog(rec);
      state.onLogCommitted?.(rec);
    });
    for (const removed of evicted) {
      queueWrite(state, (storage) => storage!.deleteLog(removed.sessionId, removed.timestampSeq));
    }
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
  const { retained, evicted } = retainLogs(state, rec);
  if (state.storage) {
    for (const removed of evicted) {
      await state.storage.deleteLog(removed.sessionId, removed.timestampSeq);
    }
  }
  state.logs.set(opts.sessionId, retained);
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
    const { retained, evicted } = retainLogs(state, record);
    for (const removed of evicted) {
      await storage.deleteLog(removed.sessionId, removed.timestampSeq);
    }
    state.logs.set(record.sessionId, retained);
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
        commandProfiles: msg.commandProfiles,
        ...(msg.repositories ? { repositories: msg.repositories } : {}),
        ...(msg.capabilities ? { capabilities: msg.capabilities } : {}),
        ...(msg.runningSessions ? { runningSessions: msg.runningSessions } : {}),
        ...(msg.draining ? { draining: true } : {}),
      });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "session:ack": {
      const session = state.sessions.get(msg.sessionId);
      if (!session) {
        return { ok: false, error: "session not found" };
      }
      // Only the first valid ACK is a state transition. Retried or stale
      // frames remain idempotently successful, but must not create a fresh
      // peer confirmation for a different daemon assignment attempt.
      if (
        session.status !== "running" ||
        session.worktreeId !== msg.worktreeId ||
        session.attemptId !== msg.attemptId ||
        session.ackReceivedAt !== undefined
      ) {
        return { ok: true };
      }
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
      commandProfiles: msg.commandProfiles,
      ...(msg.repositories ? { repositories: msg.repositories } : {}),
      ...(msg.capabilities ? { capabilities: msg.capabilities } : {}),
      ...(msg.runningSessions ? { runningSessions: msg.runningSessions } : {}),
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
      const { retained, evicted } = retainLogs(state, {
        ...log,
        timestampSeq: formatLogSortKey(log.timestamp, log.seq),
      });
      for (const removed of evicted)
        await storage.deleteLog(removed.sessionId, removed.timestampSeq);
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
    if (!session) {
      return { ok: false, error: "session not found" };
    }
    state.sessions.set(msg.sessionId, session);
    if (
      session.status !== "running" ||
      session.ackReceivedAt !== undefined ||
      session.worktreeId !== msg.worktreeId ||
      session.attemptId !== msg.attemptId
    ) {
      return { ok: true };
    }
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
      ? await storage.getSession(msg.sessionId)
      : state.sessions.get(msg.sessionId);
  if (!session) {
    return { ok: false, error: "session not found" };
  }
  state.sessions.set(session.id, session);
  const terminal = isTerminalSessionStatus(msg.status);
  if (terminal && isTerminalSessionStatus(session.status)) {
    await retrySessionArchiveIfNeeded(state, session.id);
  }
  if (session.worktreeId !== msg.worktreeId || session.attemptId !== msg.attemptId) {
    return { ok: true };
  }
  if (!terminal) {
    return { ok: true };
  }
  if (session.status === "cancelled" && session.worktreeId) {
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
    session.assignmentConnectionId
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
  if (session.mainCheckoutLease && session.hostId && session.assignmentConnectionId) {
    const providerAccountId = session.resolvedRoute?.providerAccountId;
    if (msg.status === "failed" && msg.errorCode === "usage_limit" && providerAccountId) {
      const account = await storage.getProviderAccount(providerAccountId);
      if (!account) {
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
      } else {
        const now = state.now();
        const usageLimitedUntil = new Date(
          Date.parse(now) + account.usageLimitCooldownSeconds * 1000,
        ).toISOString();
        const requeued = await storage.requeueMainCheckoutUsageLimitedSession({
          sessionId: session.id,
          hostId: session.hostId,
          repositoryId: session.repositoryId,
          connectionId: session.assignmentConnectionId,
          attemptId: msg.attemptId,
          providerAccountId,
          queueShard: session.queueShard,
          now,
          usageLimitedUntil,
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
            usageLimitedUntil,
            lastUsageLimitedAt: now,
            updatedAt: now,
          });
        }
        state.pendingAcks.delete(session.id);
        await assignScheduledQueuedDurable(state);
        return { ok: true };
      }
    }
    const retries = session.retryCount ?? 0;
    const shouldRetry =
      msg.status === "failed" &&
      msg.errorCode === "usage_limit" &&
      retries < state.usageLimitRetryCeiling;
    const committed = await storage.releaseMainCheckoutSession({
      sessionId: session.id,
      hostId: session.hostId,
      repositoryId: session.repositoryId,
      connectionId: session.assignmentConnectionId,
      attemptId: msg.attemptId,
      status: shouldRetry ? "queued" : msg.status,
      queueShard: session.queueShard,
      ...(shouldRetry
        ? {
            retryCount: retries + 1,
            retryAfter: new Date(Date.parse(state.now()) + 1000 * 2 ** retries).toISOString(),
          }
        : { completedAt: state.now() }),
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
      status: shouldRetry ? ("queued" as const) : msg.status,
      worktreeId: null,
      ...(shouldRetry
        ? {
            hostId: null,
            retryCount: retries + 1,
            retryAfter: new Date(Date.parse(state.now()) + 1000 * 2 ** retries).toISOString(),
          }
        : { completedAt: state.now() }),
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
      maybeDeliverWebhook(state, next);
    }
    return { ok: true };
  }
  const isUsageLimit = msg.status === "failed" && msg.errorCode === "usage_limit";
  const accountId = session.resolvedRoute?.providerAccountId;
  if (isUsageLimit && accountId && session.worktreeId) {
    const now = state.now();
    const account = await storage.getProviderAccount(accountId);
    if (!account) return { ok: true };
    const usageLimitedUntil = new Date(
      Date.parse(now) + account.usageLimitCooldownSeconds * 1000,
    ).toISOString();
    const committed = await storage.requeueUsageLimitedSession({
      sessionId: session.id,
      worktreeId: session.worktreeId,
      attemptId: msg.attemptId,
      providerAccountId: accountId,
      queueShard: session.queueShard,
      now,
      usageLimitedUntil,
      ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
    });
    if (!committed) return { ok: true };
    const wt = state.worktrees.get(session.worktreeId);
    if (wt) state.worktrees.set(wt.id, { ...wt, status: "idle", currentSessionId: null });
    state.providerAccounts.set(accountId, {
      ...account,
      usageLimitedUntil,
      lastUsageLimitedAt: now,
      updatedAt: now,
    });
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
  const shouldSuppressTarget = isUsageLimit && !accountId;
  if (shouldSuppressTarget && session.worktreeId) {
    const committed = await storage.suppressProviderlessUsageLimit({
      sessionId: session.id,
      worktreeId: session.worktreeId,
      attemptId: msg.attemptId,
      queueShard: session.queueShard,
      targetIndex: session.resolvedRoute?.targetIndex ?? 0,
      ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
    });
    if (!committed) return { ok: true };
    const worktree = state.worktrees.get(session.worktreeId);
    if (worktree)
      state.worktrees.set(worktree.id, { ...worktree, status: "idle", currentSessionId: null });
    state.sessions.set(session.id, {
      ...session,
      status: "queued",
      worktreeId: null,
      hostId: null,
      suppressedTargetIndexes: [
        ...(session.suppressedTargetIndexes ?? []),
        session.resolvedRoute?.targetIndex ?? 0,
      ],
    });
    state.pendingAcks.delete(session.id);
    await assignQueuedDurable(state);
    return { ok: true };
  }
  const nextStatus = shouldSuppressTarget ? "queued" : msg.status;
  const committed = await storage.finishSession({
    sessionId: msg.sessionId,
    worktreeId: session.worktreeId,
    attemptId: msg.attemptId,
    status: nextStatus,
    queueShard: session.queueShard,
    ...(shouldSuppressTarget ? {} : { completedAt: state.now() }),
    ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
    ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
    ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
    ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
    ...(fence ? { fence } : {}),
    ...(session.concurrencyId !== undefined ? { concurrencyId: session.concurrencyId } : {}),
  });
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
    maybeDeliverWebhook(state, nextSession);
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
  if (!session) {
    return { ok: false, error: "session not found" };
  }

  if (session.worktreeId !== msg.worktreeId || session.attemptId !== msg.attemptId) {
    return { ok: true };
  }

  const terminal = isTerminalSessionStatus(msg.status);

  if (session.status !== "running") {
    if (terminal && session.mainCheckoutLease) {
      releaseScheduledLeaseLocal(state, session);
      delete session.mainCheckoutLease;
      delete session.assignmentConnectionId;
      delete session.assignmentSentAt;
      delete session.ackReceivedAt;
      delete session.reconnectDeadlineAt;
      session.worktreeId = null;
    }
    if (terminal && session.worktreeId) {
      const wt = state.worktrees.get(session.worktreeId);
      if (wt?.currentSessionId === session.id) {
        releaseWorktree(state, session.worktreeId);
      }
      session.worktreeId = null;
    }
    if (msg.cliResumeRef !== undefined) session.cliResumeRef = msg.cliResumeRef;
    persistSession(state, session);
    return { ok: true };
  }

  const releasedMainCheckout =
    terminal && session.mainCheckoutLease ? releaseScheduledLeaseLocal(state, session) : false;
  if (terminal && session.mainCheckoutLease && !releasedMainCheckout) return { ok: true };

  session.status = msg.status;
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
    } else if (session.worktreeId) {
      releaseWorktree(state, session.worktreeId);
    }

    const scheduledProviderAccountId =
      session.type === "scheduled" && msg.status === "failed" && msg.errorCode === "usage_limit"
        ? session.resolvedRoute?.providerAccountId
        : undefined;
    const scheduledRetry =
      session.type === "scheduled" &&
      msg.status === "failed" &&
      msg.errorCode === "usage_limit" &&
      !scheduledProviderAccountId &&
      (session.retryCount ?? 0) < state.usageLimitRetryCeiling;
    if (scheduledProviderAccountId) {
      const account = state.providerAccounts.get(scheduledProviderAccountId);
      if (account) {
        const now = state.now();
        account.usageLimitedUntil = new Date(
          Date.parse(now) + account.usageLimitCooldownSeconds * 1000,
        ).toISOString();
        account.lastUsageLimitedAt = now;
        account.updatedAt = now;
        state.providerAccounts.set(scheduledProviderAccountId, account);
      }
      session.status = "queued";
      session.worktreeId = null;
      session.hostId = null;
      delete session.completedAt;
      void assignScheduledQueuedDurable(state).catch(() => undefined);
    } else if (scheduledRetry) {
      const retryCount = (session.retryCount ?? 0) + 1;
      session.retryCount = retryCount;
      session.retryAfter = new Date(
        Date.parse(state.now()) + 1000 * 2 ** (retryCount - 1),
      ).toISOString();
      session.status = "queued";
      session.worktreeId = null;
      session.hostId = null;
      delete session.completedAt;
    } else if (
      session.type !== "scheduled" &&
      msg.status === "failed" &&
      msg.errorCode === "usage_limit"
    ) {
      const accountId = session.resolvedRoute?.providerAccountId;
      if (accountId) {
        const account = state.providerAccounts.get(accountId);
        if (account) {
          const now = state.now();
          account.usageLimitedUntil = new Date(
            Date.parse(now) + account.usageLimitCooldownSeconds * 1000,
          ).toISOString();
          account.lastUsageLimitedAt = now;
          account.updatedAt = now;
          state.providerAccounts.set(accountId, account);
        }
      } else {
        session.suppressedTargetIndexes = [
          ...(session.suppressedTargetIndexes ?? []),
          session.resolvedRoute?.targetIndex ?? 0,
        ];
      }
      session.status = "queued";
      session.worktreeId = null;
      session.hostId = null;
      delete session.completedAt;
      void assignQueued(state);
    } else {
      session.worktreeId = null;
      // A continuation reference is single-use: a resumed command must report
      // a fresh one if it wants to support another native continuation.
      if (session.resumedFromSessionId && msg.cliResumeRef === undefined) {
        delete session.cliResumeRef;
      }
      queueSessionArchive(state, session.id);
      void maybeDeliverWebhook(state, session);
    }
  }
  persistSession(state, session);
  return { ok: true };
}
