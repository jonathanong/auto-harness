/* eslint-disable max-lines */
import {
  formatLogSortKey,
  type HostToServerMessage,
  type SessionStatus,
} from "@auto-harness/shared";

import type { LogRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, queueWrite } from "./control-plane-state.ts";
import {
  heartbeat,
  heartbeatDurable,
  registerHost,
  registerHostDurable,
} from "./control-plane-agents.ts";
import { archiveSessionLogs, maybeDeliverWebhook } from "./control-plane-lifecycle.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";

const MAX_LOG_CHUNK_BYTES = 32 * 1024;
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
    queueWrite(state, state.storage.putLog(rec));
    for (const removed of evicted) {
      queueWrite(state, state.storage.deleteLog(removed.sessionId, removed.timestampSeq));
    }
  }
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
  return rec;
}

export function getLogs(state: ControlPlaneState, sessionId: string): LogRecord[] {
  return [...(state.logs.get(sessionId) ?? [])];
}

export function handleHostMessage(
  state: ControlPlaneState,
  msg: HostToServerMessage,
): { ok: boolean; error?: string } {
  switch (msg.type) {
    case "host:register": {
      const r = registerHost(state, {
        hostId: msg.hostId,
        worktrees: msg.worktrees,
        commandProfiles: msg.commandProfiles,
      });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "session:ack": {
      const session = state.sessions.get(msg.sessionId);
      if (!session) {
        return { ok: false, error: "session not found" };
      }
      if (session.status !== "running") {
        return { ok: true };
      }
      session.ackReceivedAt = state.now();
      state.pendingAcks.delete(msg.sessionId);
      return { ok: true };
    }
    case "session:status": {
      return applySessionStatus(state, msg);
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
  }
}

/**
 * Storage-backed message path. Critical ack/status transitions await their
 * conditional DynamoDB write before mutating the process cache. The original
 * synchronous handler remains the storage-less local CAS implementation.
 */
export async function handleHostMessageDurable(
  state: ControlPlaneState,
  msg: HostToServerMessage,
): Promise<{ ok: boolean; error?: string; connectionId?: string }> {
  if (msg.type === "host:register") {
    const result = await registerHostDurable(state, {
      hostId: msg.hostId,
      worktrees: msg.worktrees,
      commandProfiles: msg.commandProfiles,
    });
    return result.ok
      ? { ok: true, connectionId: result.connectionId }
      : { ok: false, error: result.error };
  }
  if (!state.storage) {
    return handleHostMessage(state, msg);
  }
  if (msg.type === "host:keepalive") {
    return (await heartbeatDurable(state, msg.hostId, msg.at))
      ? { ok: true }
      : { ok: false, error: "agent not connected" };
  }
  if (msg.type === "session:log") {
    if (Buffer.byteLength(msg.content) > MAX_LOG_CHUNK_BYTES) {
      return { ok: false, error: "log chunk exceeds 32 KiB" };
    }
    await appendLogDurable(state, {
      sessionId: msg.sessionId,
      stream: msg.stream,
      content: msg.content,
      timestamp: msg.timestamp,
      seq: msg.seq,
    });
    return { ok: true };
  }
  if (msg.type === "session:ack") {
    const session = state.sessions.get(msg.sessionId);
    if (!session) {
      return { ok: false, error: "session not found" };
    }
    const accepted = await state.storage.acknowledgeSession(msg.sessionId, state.now());
    if (accepted) {
      state.sessions.set(msg.sessionId, {
        ...session,
        ackReceivedAt: session.ackReceivedAt ?? state.now(),
      });
      state.pendingAcks.delete(msg.sessionId);
    }
    return { ok: true };
  }
  if (msg.type === "session:status") {
    return applySessionStatusDurable(state, msg);
  }
  return { ok: false, error: "unsupported host message" };
}

async function applySessionStatusDurable(
  state: ControlPlaneState,
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
): Promise<{ ok: boolean; error?: string }> {
  const session = state.sessions.get(msg.sessionId);
  if (!session) {
    return { ok: false, error: "session not found" };
  }
  const terminal =
    msg.status === "completed" ||
    msg.status === "failed" ||
    msg.status === "cancelled" ||
    msg.status === "timed_out";
  if (!terminal) {
    return { ok: true };
  }
  if (session.status === "cancelled" && session.worktreeId) {
    const worktreeId = session.worktreeId;
    const released = await state.storage.releaseCancelledSessionWorktree({
      sessionId: session.id,
      worktreeId,
    });
    if (released) {
      const wt = state.worktrees.get(worktreeId);
      if (wt?.currentSessionId === session.id) {
        state.worktrees.set(worktreeId, { ...wt, status: "idle", currentSessionId: null });
      }
      state.sessions.set(session.id, { ...session, worktreeId: null, hostId: null });
      state.pendingAcks.delete(session.id);
    }
    return { ok: true };
  }
  if (session.status !== "running") {
    return { ok: true };
  }
  const retries = session.retryCount ?? 0;
  const shouldRetry =
    msg.status === "failed" &&
    msg.errorCode === "usage_limit" &&
    retries < state.usageLimitRetryCeiling;
  const retryCount = shouldRetry ? retries + 1 : undefined;
  const retryAfter = shouldRetry
    ? new Date(Date.parse(state.now()) + 1000 * 2 ** retries).toISOString()
    : undefined;
  const nextStatus = shouldRetry ? "queued" : msg.status;
  const committed = await state.storage.finishSession({
    sessionId: msg.sessionId,
    worktreeId: session.worktreeId,
    status: nextStatus,
    queueShard: session.queueShard,
    ...(shouldRetry ? {} : { completedAt: state.now() }),
    ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
    ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
    ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
    ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
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
    ...(shouldRetry ? {} : { completedAt: state.now() }),
    worktreeId: null,
    hostId: null,
    ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
    ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
    ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
    ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
  state.sessions.set(msg.sessionId, nextSession);
  state.pendingAcks.delete(msg.sessionId);
  if (!shouldRetry) {
    await archiveSessionLogs(state, msg.sessionId);
    maybeDeliverWebhook(state, nextSession);
  }
  return { ok: true };
}

function applySessionStatus(
  state: ControlPlaneState,
  msg: {
    sessionId: string;
    status: SessionStatus;
    exitCode?: number | null;
    errorCode?: string;
    errorMessage?: string;
    cliResumeRef?: string;
  },
): { ok: boolean; error?: string } {
  const session = state.sessions.get(msg.sessionId);
  if (!session) {
    return { ok: false, error: "session not found" };
  }

  const terminal =
    msg.status === "completed" ||
    msg.status === "failed" ||
    msg.status === "cancelled" ||
    msg.status === "timed_out";

  if (session.status !== "running") {
    if (terminal && session.worktreeId) {
      const wt = state.worktrees.get(session.worktreeId);
      if (wt?.currentSessionId === session.id) {
        releaseWorktree(state, session.worktreeId);
      }
      session.worktreeId = null;
      session.hostId = null;
    }
    return { ok: true };
  }

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
    if (session.worktreeId) {
      releaseWorktree(state, session.worktreeId);
    }

    let retries = 0;
    if (session.retryCount !== undefined) {
      retries = session.retryCount;
    }
    if (
      msg.status === "failed" &&
      msg.errorCode === "usage_limit" &&
      retries < state.usageLimitRetryCeiling
    ) {
      const retryCount = retries + 1;
      session.retryCount = retryCount;
      const backoffMs = 1000 * 2 ** (retryCount - 1);
      session.retryAfter = new Date(Date.parse(state.now()) + backoffMs).toISOString();
      session.status = "queued";
      session.worktreeId = null;
      session.hostId = null;
      delete session.completedAt;
    } else {
      session.worktreeId = null;
      void archiveSessionLogs(state, session.id);
      void maybeDeliverWebhook(state, session);
    }
  }
  persistSession(state, session);
  return { ok: true };
}
