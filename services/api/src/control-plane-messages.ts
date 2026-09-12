/* eslint-disable max-lines */
import {
  formatLogSortKey,
  isTerminalSessionStatus,
  normalizeSessionResult,
  SESSION_RESULT_PROTOCOL_VERSION,
  TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION,
  type HostToServerMessage,
} from "@auto-harness/shared";

import type { LogRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  noteSlackSessionLifecycle,
  persistSession,
  queueWrite,
  trackLogPersist,
} from "./control-plane-state.ts";
import { sessionLogsTtlEpochSeconds } from "./db/dynamo.ts";
import { connectionProtocolVersion } from "./control-plane-protocol.ts";
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
import {
  removeReleasedRetiredWorkspaceSlot,
  removeReleasedRetiredWorkspaceSlotDurable,
} from "./control-plane-workspace-slot-retirement.ts";
import {
  emitCooldown,
  emitInfrastructureRetry,
  emitInfrastructureRetryExhausted,
  emitLogDrops,
  emitLogSeqGap,
  emitStaleAttemptLogDrop,
} from "./operational-metrics.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
  releaseTimedOutProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";
import {
  finishSessionOptsFromPlan,
  requeueUsageLimitedSessionOptsFromPlan,
  requeueUsageLimitedWorkspaceSessionOptsFromPlan,
  suppressProviderlessUsageLimitOptsFromPlan,
} from "./db/plane-storage-sessions.ts";
import { hydrateAssignmentConnectionDurable } from "./control-plane-assignment-readiness.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import type { SessionRecord } from "./db/types.ts";
import type {
  SessionTransitionContext,
  SessionTransitionEvent,
} from "./session-transition-planner.ts";
import { assignQueued } from "./control-plane-assign.ts";
import {
  assignScheduledQueuedDurable,
  releaseScheduledLeaseLocal,
} from "./control-plane-scheduled-assign.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { requestAssignment } from "./request-assignment.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { ingestUsage, ingestUsageDurable } from "./control-plane-usage.ts";
import {
  pendingTerminalHookHandoffs,
  settleTerminalHookHandoff,
} from "./control-plane-terminal-hook-handoff.ts";

const MAX_LOG_CHUNK_BYTES = 32 * 1024;

async function requestAssignmentAfterHostEvent(
  state: ControlPlaneState,
  connectionId: string | undefined,
): Promise<void> {
  if (connectionId) {
    try {
      await hydrateAssignmentConnectionDurable(state, connectionId);
    } catch {
      // Continue with the durable assignment sweep.
    }
  }
  await requestAssignment(state);
}

export const MAX_DURABLE_LOG_BATCH_SIZE = 25;
const MAX_RETAINED_LOG_CHUNKS = 10_000;
const MAX_RETAINED_LOG_BYTES = 10 * 1024 * 1024;

type LogMessage = Extract<HostToServerMessage, { type: "session:log" }>;

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

function logRecord(opts: {
  sessionId: string;
  stream: string;
  content: string;
  timestamp: string;
  seq: number;
  dropped?: number;
}): LogRecord {
  return {
    sessionId: opts.sessionId,
    timestampSeq: formatLogSortKey(opts.timestamp, opts.seq),
    stream: opts.stream,
    content: opts.content,
    timestamp: opts.timestamp,
    seq: opts.seq,
    ...(opts.dropped !== undefined ? { dropped: opts.dropped } : {}),
    ttl: sessionLogsTtlEpochSeconds(),
  };
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

/**
 * The retained cache is ordered by `timestampSeq`, not by `seq` — a source
 * clock that ever moves backward (NTP correction, VM stall) can insert a
 * higher-seq record ahead of a still-later-arriving lower-seq one, so the
 * highest seq known is not necessarily the array's last element. A full
 * scan is the only way to get this right; it's cheap relative to the
 * DynamoDB write already on this same path, and correctness matters more
 * than the last few percent of speed for a detector whose only job is
 * flagging real loss without false alarms.
 */
function maxKnownSeq(retained: readonly LogRecord[] | undefined): number | undefined {
  if (!retained || retained.length === 0) return undefined;
  let max = retained[0]!.seq;
  for (let i = 1; i < retained.length; i++) {
    if (retained[i]!.seq > max) max = retained[i]!.seq;
  }
  return max;
}

/**
 * `seq` is a per-session monotonic counter the *agent* assigns, contiguous
 * with no self-inflicted gaps (a source-side drop still consumes a seq for
 * its own "N chunk(s) dropped" notice — see LogStreamer.recordDrop). So any
 * forward jump in what the control plane actually stores is genuine loss
 * somewhere in the ingest pipeline, not an expected/legitimate gap. `seq`
 * resets to 0 at the start of every attempt, which is not a gap either.
 *
 * Deliberately can't throw: this runs on the log ingest hot path, and a
 * detector that took log ingest down with it would be worse than the bug
 * it's meant to surface. `state.logs` may be missing or stale (a fresh
 * container, a different container serving a prior batch) — treat that as
 * "unknown, don't report" rather than guessing a gap that isn't real.
 */
function detectLogSeqGap(state: ControlPlaneState, rec: LogRecord): void {
  if (rec.seq <= 0) return;
  const lastSeq = maxKnownSeq(state.logs.get(rec.sessionId));
  if (lastSeq === undefined || rec.seq <= lastSeq) return;
  emitLogSeqGap(rec.seq - lastSeq - 1);
}

/** Every log-commit path funnels through here so seq-gap detection covers all of them. */
function commitLogRecord(state: ControlPlaneState, rec: LogRecord): LogRecord[] {
  detectLogSeqGap(state, rec);
  return retainLogs(state, rec);
}

function hostStatusEvent(
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
): Extract<SessionTransitionEvent, { type: "status" }> {
  const result = msg.result === undefined ? undefined : normalizeSessionResult(msg.result);
  return {
    type: "status",
    worktreeId: msg.worktreeId,
    attemptId: msg.attemptId,
    status: msg.status,
    ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
    ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
    ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
    ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

function isFirstCheckoutFetchFailure(
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
  session: SessionRecord | undefined,
): boolean {
  return (
    msg.status === "failed" &&
    msg.errorCode === "checkout_fetch_failed" &&
    (session?.infrastructureRetryCount ?? 0) === 0
  );
}

function deferredCheckoutFailureHandoff(
  state: ControlPlaneState,
  session: SessionRecord,
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
): SessionRecord["terminalHookHandoff"] | undefined {
  if (!session.hostId) return undefined;
  return {
    handoffId: state.idFactory(),
    hostId: session.hostId,
    repositoryId: session.repositoryId,
    worktreeId: session.worktreeId ?? null,
    ...(session.mainCheckoutLease ? { mainCheckoutLease: true as const } : {}),
    status: msg.status as Extract<
      SessionRecord["status"],
      "completed" | "failed" | "cancelled" | "timed_out"
    >,
    ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
    expiresAt: new Date(Date.parse(state.now()) + 24 * 60 * 60 * 1000).toISOString(),
    ...(session.ref !== undefined ? { ref: session.ref } : {}),
    ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
  };
}

/**
 * A terminal-status transaction may lose its conditional write to an
 * overlapping copy of the same status report. `finishSession` treats that as
 * success once the row has the requested terminal status, but the winning
 * invocation may have generated a different handoff id. Read the durable row
 * before acknowledging so the daemon can only complete the handoff that was
 * actually stored.
 */
async function committedDeferredCheckoutFailureHandoff(
  state: ControlPlaneState,
  sessionId: string,
  proposed: NonNullable<SessionRecord["terminalHookHandoff"]>,
): Promise<NonNullable<SessionRecord["terminalHookHandoff"]> | undefined> {
  const current = await state.storage?.getSession(sessionId, true);
  const handoff = current?.terminalHookHandoff;
  return current?.status === proposed.status &&
    handoff?.hostId === proposed.hostId &&
    handoff.errorCode === "checkout_fetch_failed"
    ? handoff
    : undefined;
}

/** Keep a deferred hook's retry decision stable across a resent moot report. */
function settledCheckoutFetchRetryDisposition(
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
  session: SessionRecord | null | undefined,
): boolean | undefined {
  if (msg.status !== "failed" || msg.errorCode !== "checkout_fetch_failed") return undefined;
  // The retry is a property of the logical session, not of the particular
  // failure report that arrived first. A disconnected daemon may report a
  // checkout failure after reconnect-deadline recovery has already consumed
  // the one retry as `host_lost`; that still means this old attempt's deferred
  // hook must be settled as accepted.
  return session?.infrastructureRetryAttemptId === msg.attemptId;
}

/** Return the durable handoff that must accompany a replayed deferred failure. */
function deferredCheckoutFailureHandoffId(
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
  session: SessionRecord | null | undefined,
): string | undefined {
  return msg.deferTerminalHookResult === true &&
    session?.terminalHookHandoff?.errorCode === "checkout_fetch_failed"
    ? session.terminalHookHandoff.handoffId
    : undefined;
}

/** Return the exact durable expiry for a replayed deferred failure handoff. */
function deferredCheckoutFailureHandoffExpiresAt(
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
  session: SessionRecord | null | undefined,
  protocolVersion: number,
): string | undefined {
  return protocolVersion < TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION ||
    deferredCheckoutFailureHandoffId(msg, session) === undefined
    ? undefined
    : session?.terminalHookHandoff?.expiresAt;
}

function plannerContext(
  state: ControlPlaneState,
  source: SessionTransitionContext["source"],
  providerAccount?: SessionTransitionContext["providerAccount"],
  protocolVersion?: number,
): SessionTransitionContext {
  return {
    now: state.now(),
    source,
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(providerAccount !== undefined ? { providerAccount } : {}),
  };
}

function releaseWorkspaceSlotLocal(
  state: ControlPlaneState,
  session: SessionRecord,
  errorMessage?: string,
): void {
  const slotId = session.workspaceSlotId;
  if (!slotId) return;
  const slot = state.workspaceSlots.get(slotId);
  if (slot?.currentSessionId === session.id) {
    const { errorMessage: _errorMessage, ...cleanSlot } = slot;
    state.workspaceSlots.set(slotId, {
      ...cleanSlot,
      status: errorMessage === undefined ? "idle" : "error",
      currentSessionId: null,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
    removeReleasedRetiredWorkspaceSlot(state, slotId);
  }
  session.workspaceSlotId = null;
  delete session.workspaceSlotLease;
}

function ignoreStaleAttempt(
  state: ControlPlaneState,
  session: SessionRecord | null | undefined,
  event: Extract<SessionTransitionEvent, { type: "log" | "reconnect_claim" }>,
  source: SessionTransitionContext["source"],
): boolean {
  if (!session) return false;
  return Boolean(
    transitionEffect(
      planSessionTransition(session, event, plannerContext(state, source)),
      "ignore",
    ),
  );
}

function resolvedLogAttemptId(
  session: SessionRecord | null | undefined,
  message: LogMessage,
): string | undefined {
  return message.attemptId ?? session?.attemptId;
}

function logAttemptFence(
  messages: readonly { sessionId: string; attemptId?: string | undefined }[],
): Array<{ sessionId: string; attemptId: string }> {
  const attempts: Array<{ sessionId: string; attemptId: string }> = [];
  for (const message of messages) {
    if (message.attemptId)
      attempts.push({ sessionId: message.sessionId, attemptId: message.attemptId });
  }
  return attempts;
}

/** Durable log fencing must not trust a warm worker's session cache. */
async function loadDurableSession(
  state: ControlPlaneState,
  storage: NonNullable<ControlPlaneState["storage"]>,
  sessionId: string,
): Promise<SessionRecord | null> {
  const session =
    typeof storage.getSession === "function"
      ? await storage.getSession(sessionId, true)
      : state.sessions.get(sessionId);
  if (session) state.sessions.set(session.id, session);
  return session ?? null;
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
    dropped?: number;
  },
): LogRecord {
  const rec = logRecord(opts);
  emitLogDrops(opts.dropped);
  state.logs.set(opts.sessionId, commitLogRecord(state, rec));
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
    dropped?: number;
  },
): Promise<LogRecord> {
  const rec = logRecord(opts);
  emitLogDrops(opts.dropped);
  if (state.storage) {
    await state.storage.putLog(rec);
  }
  state.logs.set(opts.sessionId, commitLogRecord(state, rec));
  state.onLogCommitted?.(rec);
  return rec;
}

export function getLogs(state: ControlPlaneState, sessionId: string): LogRecord[] {
  return [...(state.logs.get(sessionId) ?? [])];
}

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
  const accepted: LogMessage[] = [];
  const loaded = new Map<string, SessionRecord | null>();
  for (const message of messages) {
    if (Buffer.byteLength(message.content) > MAX_LOG_CHUNK_BYTES) {
      return { ok: false, error: "log chunk exceeds 32 KiB" };
    }
    if (!loaded.has(message.sessionId)) {
      loaded.set(message.sessionId, await loadDurableSession(state, storage, message.sessionId));
    }
    const session = loaded.get(message.sessionId) ?? null;
    const attemptId = resolvedLogAttemptId(session, message);
    if (
      attemptId !== undefined &&
      ignoreStaleAttempt(state, session, { type: "log", attemptId }, "durable")
    ) {
      // The only discard site whose batch-mates still commit — worth its own
      // counter, distinct from the general seq-gap detector below, since it
      // names a specific known cause rather than just the resulting symptom.
      emitStaleAttemptLogDrop();
      continue;
    }
    if (!session?.hostId || (hostId !== undefined && session.hostId !== hostId)) {
      return { ok: false, error: "stale host connection" };
    }
    hostId = session.hostId;
    accepted.push(attemptId !== undefined ? { ...message, attemptId } : message);
  }
  if (accepted.length === 0) return { ok: true };
  if (!hostId || (await storage.getHostLock(hostId)) !== sourceConnectionId) {
    return { ok: false, error: "stale host connection" };
  }
  const records = accepted.map((message) => logRecord(message));
  const attempts = logAttemptFence(accepted);
  if (
    !(await storage.putLogsFenced(records, {
      hostId,
      connectionId: sourceConnectionId,
      ...(attempts.length > 0 ? { attempts } : {}),
    }))
  ) {
    return { ok: false, error: "stale host connection" };
  }
  for (const record of records) {
    state.logs.set(record.sessionId, commitLogRecord(state, record));
    state.onLogCommitted?.(record);
  }
  return { ok: true };
}

export function handleHostMessage(
  state: ControlPlaneState,
  msg: HostToServerMessage,
  sourceConnectionId?: string,
): { ok: boolean; error?: string; retryAccepted?: boolean | undefined } {
  switch (msg.type) {
    case "host:register": {
      const r = registerHost(state, {
        hostId: msg.hostId,
        worktrees: msg.worktrees,
        ...(msg.repositories ? { repositories: msg.repositories } : {}),
        ...(msg.workspacePools ? { workspacePools: msg.workspacePools } : {}),
        ...(msg.capabilities
          ? {
              capabilities: Array.isArray(msg.capabilities)
                ? msg.capabilities
                : msg.capabilities.features,
            }
          : {}),
        ...(msg.maxConcurrentAssignments !== undefined
          ? { maxConcurrentAssignments: msg.maxConcurrentAssignments }
          : {}),
        ...(msg.providerAccountReadiness
          ? { providerAccountReadiness: msg.providerAccountReadiness }
          : {}),
        ...(msg.runningSessions ? { runningSessions: msg.runningSessions } : {}),
        ...(msg.runningAttempts ? { runningAttempts: msg.runningAttempts } : {}),
        ...(msg.protocolVersion !== undefined ? { protocolVersion: msg.protocolVersion } : {}),
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
      if (!r.ok) return { ok: false, error: r.error };
      for (const session of connectionProtocolVersion(state.connections.get(r.connectionId)) >=
      TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION
        ? state.sessions.values()
        : []) {
        const handoff = session.terminalHookHandoff;
        if (!handoff || handoff.hostId !== msg.hostId) continue;
        state.onHostMessage?.(msg.hostId, {
          type: "session:terminal-hook",
          handoffId: handoff.handoffId,
          sessionId: session.id,
          repositoryId: handoff.repositoryId,
          worktreeId: handoff.worktreeId,
          status: handoff.status,
          expiresAt: handoff.expiresAt,
          ...(handoff.errorCode !== undefined ? { errorCode: handoff.errorCode } : {}),
          ...(handoff.ref !== undefined ? { ref: handoff.ref } : {}),
          ...(handoff.metadata !== undefined ? { metadata: handoff.metadata } : {}),
        });
      }
      return { ok: true };
    }
    case "session:ack": {
      const session = state.sessions.get(msg.sessionId);
      if (!session) return { ok: false, error: "session not found" };
      const plan = planSessionTransition(
        session,
        { type: "ack", worktreeId: msg.worktreeId, attemptId: msg.attemptId },
        plannerContext(state, "local"),
      );
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
          attemptId: msg.attemptId,
        });
      }
      return { ok: true };
    }
    case "session:command-start": {
      const session = state.sessions.get(msg.sessionId);
      if (!session) return { ok: false, error: "session not found" };
      const plan = planSessionTransition(
        session,
        { type: "command_start", worktreeId: msg.worktreeId, attemptId: msg.attemptId },
        plannerContext(state, "local"),
      );
      const accepted = !transitionEffect(plan, "ignore") && !transitionEffect(plan, "reject");
      if (accepted && transitionEffect(plan, "authorize_command_start")) {
        session.primaryCommandStartState = "authorized";
      }
      if (accepted && session.hostId && session.primaryCommandStartState === "authorized") {
        state.onHostMessage?.(session.hostId, {
          type: "session:command-start-acknowledged",
          sessionId: session.id,
          attemptId: msg.attemptId,
        });
      }
      return { ok: true };
    }
    case "session:status": {
      // Captured before mutation: a terminal report can clear session.hostId.
      const owner = state.sessions.get(msg.sessionId)?.hostId;
      const result = applySessionStatus(state, msg);
      if (result.ok && owner) {
        state.onHostMessage?.(owner, {
          type: "session:status-acknowledged",
          sessionId: msg.sessionId,
          attemptId: msg.attemptId,
          ...(result.retryAccepted !== undefined ? { retryAccepted: result.retryAccepted } : {}),
        });
      }
      return result.error === undefined
        ? { ok: result.ok }
        : { ok: result.ok, error: result.error };
    }
    case "session:usage": {
      return ingestUsage(state, msg);
    }
    case "session:terminal-hook-complete": {
      const handoff = state.sessions.get(msg.sessionId)?.terminalHookHandoff;
      if (!handoff) return { ok: false, error: "terminal hook handoff not found" };
      const completedResult =
        msg.result === undefined ? undefined : normalizeSessionResult(msg.result);
      if (msg.result !== undefined && completedResult === undefined) {
        return { ok: false, error: "invalid session result" };
      }
      void settleTerminalHookHandoff(state, {
        sessionId: msg.sessionId,
        handoffId: msg.handoffId,
        hostId: handoff.hostId,
        ...(sourceConnectionId ? { connectionId: sourceConnectionId } : {}),
        ...(completedResult ? { result: completedResult } : {}),
      }).then((settled) => {
        if (settled) {
          state.onHostMessage?.(handoff.hostId, {
            type: "session:terminal-hook-acknowledged",
            sessionId: msg.sessionId,
            handoffId: msg.handoffId,
          });
        }
      });
      return { ok: true };
    }
    case "session:log": {
      if (Buffer.byteLength(msg.content) > MAX_LOG_CHUNK_BYTES) {
        return { ok: false, error: "log chunk exceeds 32 KiB" };
      }
      const session = state.sessions.get(msg.sessionId);
      const attemptId = resolvedLogAttemptId(session, msg);
      if (
        attemptId !== undefined &&
        ignoreStaleAttempt(state, session, { type: "log", attemptId }, "local")
      ) {
        emitStaleAttemptLogDrop();
        return { ok: true };
      }
      appendLog(state, {
        sessionId: msg.sessionId,
        stream: msg.stream,
        content: msg.content,
        timestamp: msg.timestamp,
        seq: msg.seq,
        ...(msg.dropped !== undefined ? { dropped: msg.dropped } : {}),
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
  /** Protocol from the transport's already-authenticated durable connection row. */
  sourceProtocolVersion?: number,
): Promise<{
  ok: boolean;
  error?: string;
  connectionId?: string;
  /** Present only after the durable ack transaction committed. */
  sessionAcknowledged?: string;
  /** Present only after command launch is durably authorized. */
  sessionCommandStartAcknowledged?: { sessionId: string; attemptId: string };
  /** Present only after a `session:status` report was durably applied. */
  sessionStatusAcknowledged?: {
    sessionId: string;
    attemptId: string;
    retryAccepted?: boolean | undefined;
    terminalHookHandoffId?: string | undefined;
    terminalHookHandoffExpiresAt?: string | undefined;
  };
  /** Present only after a replacement daemon durably settles its hook handoff. */
  sessionTerminalHookAcknowledged?: { sessionId: string; handoffId: string };
  /** Pending hooks to deliver after this daemon's socket becomes current. */
  terminalHookHandoffs?: Array<
    Extract<import("@auto-harness/shared").HostWireMessage, { type: "session:terminal-hook" }>
  >;
  /** Present only after the host's drain flag committed. */
  hostDraining?: string;
}> {
  if (msg.type === "host:register") {
    const result = await registerHostDurable(state, {
      hostId: msg.hostId,
      worktrees: msg.worktrees,
      ...(msg.repositories ? { repositories: msg.repositories } : {}),
      ...(msg.workspacePools ? { workspacePools: msg.workspacePools } : {}),
      ...(msg.capabilities
        ? {
            capabilities: Array.isArray(msg.capabilities)
              ? msg.capabilities
              : msg.capabilities.features,
          }
        : {}),
      ...(msg.maxConcurrentAssignments !== undefined
        ? { maxConcurrentAssignments: msg.maxConcurrentAssignments }
        : {}),
      ...(msg.providerAccountReadiness
        ? { providerAccountReadiness: msg.providerAccountReadiness }
        : {}),
      ...(msg.runningSessions ? { runningSessions: msg.runningSessions } : {}),
      ...(msg.runningAttempts ? { runningAttempts: msg.runningAttempts } : {}),
      ...(msg.protocolVersion !== undefined ? { protocolVersion: msg.protocolVersion } : {}),
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
    if (!result.ok) return { ok: false, error: result.error };
    const handoffs = await pendingTerminalHookHandoffs(state, msg.hostId, {
      connectionId: result.connectionId,
      protocolVersion: connectionProtocolVersion(state.connections.get(result.connectionId)),
    });
    return {
      ok: true,
      connectionId: result.connectionId,
      ...(handoffs.length > 0 ? { terminalHookHandoffs: handoffs } : {}),
    };
  }
  if (
    msg.type === "session:status" &&
    msg.result !== undefined &&
    sourceConnectionId !== undefined &&
    (sourceProtocolVersion ??
      connectionProtocolVersion(state.connections.get(sourceConnectionId))) <
      SESSION_RESULT_PROTOCOL_VERSION
  ) {
    return { ok: false, error: "session result requires host protocol 3" };
  }
  if (!state.storage) {
    // The synchronous in-memory transition emits its own confirmation through
    // `onHostMessage`. Keeping it out of this result prevents a local WS hub
    // from delivering the same confirmation once through its bridge and once
    // as a direct socket response.
    const result = handleHostMessage(state, msg, sourceConnectionId);
    if (
      result.ok &&
      msg.type === "session:status" &&
      (isTerminalSessionStatus(msg.status) || msg.errorCode === "usage_limit")
    ) {
      await requestAssignment(state);
    }
    if (result.ok && msg.type === "host:keepalive" && msg.runningSessions !== undefined) {
      // The synchronous local handler above only updates the heartbeat
      // timestamp; run the same keepalive-time reconciliation the durable
      // path gets via `heartbeatDurable`, so a non-durable control plane also
      // bounds a lost/orphaned session to one keepalive interval.
      const terminalHookHandoffSessionIds: string[] = [];
      const requeued = await reconcileHostOwnedSessions(
        state,
        msg.hostId,
        state.hostConnection.get(msg.hostId),
        new Set(msg.runningSessions),
        "daemon no longer reports session as running; requeued",
        terminalHookHandoffSessionIds,
      );
      if (requeued.length > 0) await requestAssignment(state);
      if (terminalHookHandoffSessionIds.length > 0) {
        const handoffs = await pendingTerminalHookHandoffs(state, msg.hostId, {
          sessionIds: terminalHookHandoffSessionIds,
        });
        return { ...result, ...(handoffs.length > 0 ? { terminalHookHandoffs: handoffs } : {}) };
      }
    }
    return result;
  }
  const storage = state.storage;
  if (msg.type === "session:log") {
    if (Buffer.byteLength(msg.content) > MAX_LOG_CHUNK_BYTES) {
      return { ok: false, error: "log chunk exceeds 32 KiB" };
    }
    const session = await loadDurableSession(state, storage, msg.sessionId);
    const attemptId = resolvedLogAttemptId(session, msg);
    if (
      attemptId !== undefined &&
      ignoreStaleAttempt(state, session, { type: "log", attemptId }, "durable")
    ) {
      emitStaleAttemptLogDrop();
      return { ok: true };
    }
    const log = logRecord(msg);
    if (sourceConnectionId) {
      const hostId = session?.hostId;
      if (!hostId || (await storage.getHostLock(hostId)) !== sourceConnectionId) {
        return { ok: false, error: "stale host connection" };
      }
      const attempts = logAttemptFence([
        attemptId !== undefined
          ? { sessionId: msg.sessionId, attemptId }
          : { sessionId: msg.sessionId },
      ]);
      if (
        !(await storage.putLogFenced(log, {
          hostId,
          connectionId: sourceConnectionId,
          ...(attempts.length > 0 ? { attempts } : {}),
        }))
      ) {
        return { ok: false, error: "stale host connection" };
      }
      emitLogDrops(msg.dropped);
      const retained = commitLogRecord(state, log);
      state.logs.set(log.sessionId, retained);
      state.onLogCommitted?.(log);
    } else {
      await appendLogDurable(state, log);
    }
    return { ok: true };
  }
  let fence: { hostId: string; connectionId: string } | undefined;
  if (sourceConnectionId) {
    const acknowledgedProtocolVersion =
      sourceProtocolVersion ?? connectionProtocolVersion(state.connections.get(sourceConnectionId));
    const loaded =
      msg.type === "host:keepalive" || msg.type === "host:status"
        ? undefined
        : msg.type === "session:terminal-hook-complete"
          ? await storage.getSession(msg.sessionId, true)
          : (state.sessions.get(msg.sessionId) ?? (await storage.getSession(msg.sessionId)));
    const hostId =
      msg.type === "host:keepalive" || msg.type === "host:status"
        ? msg.hostId
        : msg.type === "session:terminal-hook-complete"
          ? (loaded?.terminalHookHandoff?.hostId ?? loaded?.terminalHookHandoffSettled?.hostId)
          : loaded?.hostId;
    // Distinct from a lock mismatch below: this session has no host claim at
    // all, which only happens once some transition has already cleared it.
    const noHostClaim = !hostId;
    if (noHostClaim || (await storage.getHostLock(hostId)) !== sourceConnectionId) {
      if (
        (msg.type === "session:ack" ||
          msg.type === "session:command-start" ||
          msg.type === "session:status" ||
          msg.type === "session:usage") &&
        msg.attemptId
      ) {
        const session = await loadDurableSession(state, storage, msg.sessionId);
        if (session?.attemptId && session.attemptId !== msg.attemptId) {
          if (msg.type === "session:status") {
            // The row has already moved past this exact attempt entirely —
            // reassigned, or requeued to run again under a fresh attemptId —
            // and this report can never affect it again on any host, current
            // claim notwithstanding. Acknowledge so the daemon that sent it
            // (which may since have lost its host claim, or never had one for
            // this attempt at all) stops retrying a report that is moot
            // rather than resending it every keepalive for up to 24h.
            return {
              ok: true,
              sessionStatusAcknowledged: {
                sessionId: msg.sessionId,
                attemptId: msg.attemptId,
                ...(settledCheckoutFetchRetryDisposition(msg, session) !== undefined
                  ? { retryAccepted: settledCheckoutFetchRetryDisposition(msg, session) }
                  : {}),
                ...(deferredCheckoutFailureHandoffId(msg, session) !== undefined
                  ? { terminalHookHandoffId: deferredCheckoutFailureHandoffId(msg, session) }
                  : {}),
                ...(deferredCheckoutFailureHandoffExpiresAt(
                  msg,
                  session,
                  acknowledgedProtocolVersion,
                ) !== undefined
                  ? {
                      terminalHookHandoffExpiresAt: deferredCheckoutFailureHandoffExpiresAt(
                        msg,
                        session,
                        acknowledgedProtocolVersion,
                      ),
                    }
                  : {}),
              },
            };
          }
          return { ok: true };
        }
        if (msg.type === "session:status" && noHostClaim && session?.attemptId === msg.attemptId) {
          // The session's own transition (finish/requeue) already cleared its
          // host claim for this exact attempt — the fence above trips only
          // because there is no host left to match against, not because this
          // report is stale. Acknowledge it so the daemon stops retrying a
          // report the control plane already durably applied, rather than
          // resending it every keepalive for up to 24h. Requiring noHostClaim
          // (not just a matching attemptId) matters: a session that is still
          // genuinely running, just now claimed by a different/newer
          // connection after a reconnect, must NOT be acknowledged here — the
          // report was never applied, and a false ack would make the daemon
          // stop retrying a status the control plane never durably recorded.
          return {
            ok: true,
            sessionStatusAcknowledged: {
              sessionId: msg.sessionId,
              attemptId: msg.attemptId,
              ...(settledCheckoutFetchRetryDisposition(msg, session) !== undefined
                ? { retryAccepted: settledCheckoutFetchRetryDisposition(msg, session) }
                : {}),
              ...(deferredCheckoutFailureHandoffId(msg, session) !== undefined
                ? { terminalHookHandoffId: deferredCheckoutFailureHandoffId(msg, session) }
                : {}),
              ...(deferredCheckoutFailureHandoffExpiresAt(
                msg,
                session,
                acknowledgedProtocolVersion,
              ) !== undefined
                ? {
                    terminalHookHandoffExpiresAt: deferredCheckoutFailureHandoffExpiresAt(
                      msg,
                      session,
                      acknowledgedProtocolVersion,
                    ),
                  }
                : {}),
            },
          };
        }
      }
      return { ok: false, error: "stale host connection" };
    }
    fence = { hostId, connectionId: sourceConnectionId };
  }
  if (msg.type === "host:keepalive") {
    const terminalHookHandoffSessionIds: string[] = [];
    const heartbeatAccepted = await heartbeatDurable(
      state,
      msg.hostId,
      msg.at,
      fence?.connectionId,
      msg.runningSessions,
      terminalHookHandoffSessionIds,
    );
    if (!heartbeatAccepted) return { ok: false, error: "agent not connected" };
    // Re-list every still-pending handoff on each modern keepalive. Registration
    // commits the handoff before the first PostToConnection delivery, so a
    // transient delivery failure must not strand it until a replacement
    // registration. The result is bounded by TERMINAL_HOOK_HANDOFF_DELIVERY_LIMIT
    // and the daemon deduplicates an already-retained handoff.
    const handoffOptions = {
      ...(fence?.connectionId ? { connectionId: fence.connectionId } : {}),
      ...(sourceProtocolVersion !== undefined ? { protocolVersion: sourceProtocolVersion } : {}),
    };
    const handoffs = await pendingTerminalHookHandoffs(state, msg.hostId, handoffOptions);
    // A reconciliation pass can create a new handoff while an earlier one is
    // still pending. Some storage adapters return the pre-reconciliation page
    // for the broad host query, so explicitly include the newly-created IDs as
    // well and de-duplicate by handoff ID.
    if (terminalHookHandoffSessionIds.length > 0) {
      const newlyCreated = await pendingTerminalHookHandoffs(state, msg.hostId, {
        ...handoffOptions,
        sessionIds: terminalHookHandoffSessionIds,
      });
      const byId = new Map(handoffs.map((handoff) => [handoff.handoffId, handoff]));
      for (const handoff of newlyCreated) byId.set(handoff.handoffId, handoff);
      return {
        ok: true,
        ...(byId.size > 0 ? { terminalHookHandoffs: [...byId.values()] } : {}),
      };
    }
    return { ok: true, ...(handoffs.length > 0 ? { terminalHookHandoffs: handoffs } : {}) };
  }
  if (msg.type === "host:status") {
    const result = await drainHostDurable(state, msg.hostId, sourceConnectionId);
    return result.ok
      ? { ok: true, hostDraining: msg.hostId }
      : { ok: false, error: "stale host connection" };
  }
  if (msg.type === "session:terminal-hook-complete") {
    const session = await storage.getSession(msg.sessionId, true);
    const handoff = session?.terminalHookHandoff;
    if (!handoff) {
      return session?.terminalHookHandoffSettled?.handoffId === msg.handoffId &&
        session.terminalHookHandoffSettled.hostId === fence?.hostId
        ? {
            ok: true,
            sessionTerminalHookAcknowledged: {
              sessionId: msg.sessionId,
              handoffId: msg.handoffId,
            },
          }
        : { ok: false, error: "terminal hook handoff not found" };
    }
    if (handoff.handoffId !== msg.handoffId || handoff.hostId !== fence?.hostId) {
      return { ok: false, error: "terminal hook handoff not found" };
    }
    const completedResult =
      msg.result === undefined ? undefined : normalizeSessionResult(msg.result);
    if (msg.result !== undefined && completedResult === undefined) {
      return { ok: false, error: "invalid session result" };
    }
    const settled = await settleTerminalHookHandoff(state, {
      sessionId: msg.sessionId,
      handoffId: msg.handoffId,
      hostId: handoff.hostId,
      ...(fence?.connectionId ? { connectionId: fence.connectionId } : {}),
      ...(completedResult ? { result: completedResult } : {}),
    });
    return settled
      ? {
          ok: true,
          sessionTerminalHookAcknowledged: {
            sessionId: msg.sessionId,
            handoffId: msg.handoffId,
          },
        }
      : { ok: false, error: "terminal hook handoff not found" };
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
  if (msg.type === "session:command-start") {
    const session = await state.storage.getSession(msg.sessionId);
    if (!session) return { ok: false, error: "session not found" };
    const plan = planSessionTransition(
      session,
      { type: "command_start", worktreeId: msg.worktreeId, attemptId: msg.attemptId },
      plannerContext(state, "durable"),
    );
    state.sessions.set(msg.sessionId, session);
    const authorized =
      !transitionEffect(plan, "ignore") &&
      !transitionEffect(plan, "reject") &&
      (session.primaryCommandStartState === "authorized" ||
        (transitionEffect(plan, "authorize_command_start") &&
          (await state.storage.authorizePrimaryCommandStart({
            sessionId: msg.sessionId,
            worktreeId: msg.worktreeId,
            attemptId: msg.attemptId,
            ...(fence ? { fence } : {}),
          }))));
    if (!authorized) return { ok: true };
    state.sessions.set(msg.sessionId, { ...session, primaryCommandStartState: "authorized" });
    return {
      ok: true,
      sessionCommandStartAcknowledged: { sessionId: msg.sessionId, attemptId: msg.attemptId },
    };
  }
  if (msg.type === "session:status") {
    const { applied, ...result } = await applySessionStatusDurable(
      state,
      msg,
      storage,
      fence,
      sourceProtocolVersion,
    );
    // The daemon retries an unacknowledged terminal status on every keepalive; this
    // is the signal it stops. `ok: true` alone is not enough: several branches inside
    // applySessionStatusDurable return it even when their own conditional write lost a
    // race (e.g. against the running-timeout sweep) and nothing was actually committed.
    // Only a branch that marks `applied` — either because its write genuinely committed,
    // or because the session row was already durably resolved in a way this report can
    // no longer affect — may tell the daemon to stop retrying.
    return result.ok && applied
      ? {
          ...result,
          sessionStatusAcknowledged: {
            sessionId: msg.sessionId,
            attemptId: msg.attemptId,
            ...(result.retryAccepted !== undefined ? { retryAccepted: result.retryAccepted } : {}),
            ...(result.terminalHookHandoffId !== undefined
              ? { terminalHookHandoffId: result.terminalHookHandoffId }
              : {}),
            ...(result.terminalHookHandoffExpiresAt !== undefined
              ? { terminalHookHandoffExpiresAt: result.terminalHookHandoffExpiresAt }
              : {}),
          },
        }
      : result;
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
  sourceProtocolVersion?: number,
): Promise<{
  ok: boolean;
  error?: string;
  /**
   * Set only when this report was durably applied — its own write committed,
   * or the session row was already resolved in a way this report can no
   * longer affect. Left unset on every "lost the conditional write" branch so
   * the caller withholds sessionStatusAcknowledged and the daemon retries.
   */
  applied?: boolean;
  /** The durable disposition for a first checkout-fetch failure's deferred hook. */
  retryAccepted?: boolean | undefined;
  terminalHookHandoffId?: string | undefined;
  terminalHookHandoffExpiresAt?: string | undefined;
}> {
  const protocolVersion =
    sourceProtocolVersion ??
    (fence ? connectionProtocolVersion(state.connections.get(fence.connectionId)) : 0) ??
    0;
  const reportedResult = msg.result === undefined ? undefined : normalizeSessionResult(msg.result);
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
  if (
    session.status === "timed_out" &&
    isTerminalSessionStatus(msg.status) &&
    session.workspaceSlotId &&
    session.attemptId === msg.attemptId
  ) {
    const slotId = session.workspaceSlotId;
    const releasedLease = await releaseTimedOutProviderAccountLease(state, session);
    if (!releasedLease) return { ok: true };
    const released = await storage.finishSession({
      sessionId: session.id,
      worktreeId: null,
      workspaceSlotId: slotId,
      attemptId: msg.attemptId,
      status: "timed_out",
      expectedStatus: "timed_out",
      queueShard: session.queueShard,
      completedAt: session.completedAt ?? state.now(),
      ...(msg.workspaceSlotError !== undefined
        ? { workspaceSlotError: msg.workspaceSlotError }
        : {}),
    });
    if (!released) return { ok: true };
    const slot = state.workspaceSlots.get(slotId);
    if (slot?.currentSessionId === session.id) {
      state.workspaceSlots.set(slotId, {
        ...slot,
        status: msg.workspaceSlotError ? "error" : "idle",
        currentSessionId: null,
        ...(msg.workspaceSlotError ? { errorMessage: msg.workspaceSlotError } : {}),
      });
    }
    await removeReleasedRetiredWorkspaceSlotDurable(state, slotId);
    session.workspaceSlotId = null;
    delete session.workspaceSlotLease;
    persistSession(state, session);
    return { ok: true, applied: true };
  }
  if (
    session.status === "timed_out" &&
    isTerminalSessionStatus(msg.status) &&
    (session.providerAccountLease?.attemptId === msg.attemptId ||
      (!session.providerAccountLease &&
        session.timedOutHostId != null &&
        session.attemptId === msg.attemptId))
  ) {
    // storage is guaranteed non-null here (this function only runs on the
    // durable dispatch path), so releaseTimedOutProviderAccountLease's own
    // no-storage fallback is unreachable from this call site.
    const released = await releaseTimedOutProviderAccountLease(state, session, reportedResult);
    if (typeof storage.releaseTimedOutProviderAccountLease !== "function") {
      persistSession(state, session);
    }
    // A `false` here means the conditional release lost a race (e.g. another
    // report for the same attempt already released it); withhold applied so
    // the daemon retries rather than treating this lease as durably freed.
    return released ? { ok: true, applied: true } : { ok: true };
  }
  let providerAccount: SessionTransitionContext["providerAccount"];
  let loadedAccount: ReturnType<ControlPlaneState["providerAccounts"]["get"]> | null | undefined;
  const accountId = session.resolvedRoute?.providerAccountId;
  if (
    session.status === "running" &&
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
    plannerContext(state, "durable", providerAccount, protocolVersion),
  );
  const rejected = transitionEffect(plan, "reject");
  if (rejected) return { ok: false, error: rejected.error };
  if (transitionEffect(plan, "retry_archive")) {
    await retrySessionArchiveIfNeeded(state, session.id);
  }
  if (transitionEffect(plan, "ignore")) {
    // Every ignore reason (stale attempt, already-resolved status, non-terminal
    // report) means this attempt's report can never change the session row
    // again — either it no longer owns the current attempt, or the durable
    // path never retries non-terminal reports in the first place. Safe to stop
    // the daemon's retry loop.
    const retryAccepted = settledCheckoutFetchRetryDisposition(msg, session);
    return {
      ok: true,
      applied: true,
      ...(retryAccepted !== undefined ? { retryAccepted } : {}),
      ...(retryAccepted === false &&
      msg.deferTerminalHookResult === true &&
      session.terminalHookHandoff?.errorCode === "checkout_fetch_failed"
        ? { terminalHookHandoffId: session.terminalHookHandoff.handoffId }
        : {}),
      ...(retryAccepted === false &&
      protocolVersion >= TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION &&
      msg.deferTerminalHookResult === true &&
      session.terminalHookHandoff?.errorCode === "checkout_fetch_failed"
        ? { terminalHookHandoffExpiresAt: session.terminalHookHandoff.expiresAt }
        : {}),
    };
  }
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
      ...(reportedResult ? { result: reportedResult } : {}),
      fence,
      attemptId: msg.attemptId,
      concurrencyId: session.concurrencyId,
      ...providerAccountLeaseWriteOpts(session),
    });
    if (released) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
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
        ...(reportedResult ? { result: session.result ?? reportedResult } : {}),
      });
      state.pendingAcks.delete(session.id);
      await requestAssignmentAfterHostEvent(state, fence?.connectionId);
      return { ok: true, applied: true };
    }
    // released === false: the conditional write lost a race; withhold applied
    // so the daemon retries instead of treating the worktree as freed.
    return { ok: true };
  }
  if (
    session.status === "cancelled" &&
    session.workspaceSlotId &&
    transitionEffect(plan, "release_workspace")
  ) {
    const slotId = session.workspaceSlotId;
    const released = await storage.finishSession({
      ...finishSessionOptsFromPlan(session, plan, {
        attemptId: msg.attemptId,
        ...(fence ? { fence } : {}),
        ...(msg.workspaceSlotError ? { workspaceSlotError: msg.workspaceSlotError } : {}),
      }),
      expectedStatus: "cancelled",
      status: "cancelled",
      completedAt: session.completedAt ?? state.now(),
    });
    if (!released) return { ok: true };
    await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
    releaseProviderAccountLease(state, session);
    const slot = state.workspaceSlots.get(slotId);
    if (slot?.currentSessionId === session.id) {
      state.workspaceSlots.set(slotId, {
        ...slot,
        status: msg.workspaceSlotError ? "error" : "idle",
        currentSessionId: null,
        ...(msg.workspaceSlotError ? { errorMessage: msg.workspaceSlotError } : {}),
      });
    }
    await removeReleasedRetiredWorkspaceSlotDurable(state, slotId);
    const next = { ...session, workspaceSlotId: null };
    delete next.workspaceSlotLease;
    state.sessions.set(session.id, next);
    state.pendingAcks.delete(session.id);
    await requestAssignmentAfterHostEvent(state, fence?.connectionId);
    return { ok: true, applied: true };
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
      ...(reportedResult ? { result: reportedResult } : {}),
      concurrencyId: session.concurrencyId,
      ...providerAccountLeaseWriteOpts(session),
    });
    if (released) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseScheduledLeaseLocal(state, session);
      releaseProviderAccountLease(state, session);
      const { mainCheckoutLease: _, ...next } = {
        ...session,
        worktreeId: null,
        ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
        ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
        ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
        ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
        ...(reportedResult ? { result: session.result ?? reportedResult } : {}),
      };
      delete next.assignmentConnectionId;
      delete next.assignmentSentAt;
      delete next.ackReceivedAt;
      delete next.reconnectDeadlineAt;
      state.sessions.set(session.id, next);
      state.pendingAcks.delete(session.id);
      await requestAssignmentAfterHostEvent(state, fence?.connectionId);
      return { ok: true, applied: true };
    }
    // released === false: the conditional write lost a race; withhold applied
    // so the daemon retries instead of treating the lease as freed.
    return { ok: true };
  }
  if (session.status !== "running") {
    // The session row is already durably resolved to a non-running status by
    // some other transition; this report cannot change it further.
    return {
      ok: true,
      applied: true,
      ...(isFirstCheckoutFetchFailure(msg, session) ? { retryAccepted: false } : {}),
      ...(session.terminalHookHandoff &&
      msg.deferTerminalHookResult === true &&
      session.terminalHookHandoff.errorCode === "checkout_fetch_failed"
        ? { terminalHookHandoffId: session.terminalHookHandoff.handoffId }
        : {}),
      ...(session.terminalHookHandoff &&
      protocolVersion >= TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION &&
      msg.deferTerminalHookResult === true &&
      session.terminalHookHandoff.errorCode === "checkout_fetch_failed"
        ? { terminalHookHandoffExpiresAt: session.terminalHookHandoff.expiresAt }
        : {}),
    };
  }
  const cooldown = transitionEffect(plan, "cooldown");
  const requeue = transitionEffect(plan, "requeue");
  const suppress = transitionEffect(plan, "suppress_target");
  const finish = transitionEffect(plan, "finish");
  if (session.mainCheckoutLease && session.hostId && session.assignmentConnectionId) {
    if (requeue?.reason === "infrastructure") {
      const code = requeue.errorCode as "checkout_fetch_failed" | "host_lost";
      const requeued = await storage.releaseMainCheckoutSession({
        sessionId: session.id,
        hostId: session.hostId,
        repositoryId: session.repositoryId,
        connectionId: session.assignmentConnectionId,
        attemptId: msg.attemptId,
        status: "queued",
        queueShard: session.queueShard,
        reason: requeue.errorMessage ?? "infrastructure retry",
        infrastructureErrorCode: code,
        ...providerAccountLeaseWriteOpts(session),
      });
      if (!requeued) return { ok: true };
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseScheduledLeaseLocal(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, {
        ...queueReconnectSession(session, requeue.errorMessage ?? "infrastructure retry"),
        infrastructureRetryCount: (session.infrastructureRetryCount ?? 0) + 1,
        lastInfrastructureErrorCode: code,
        infrastructureRetryAttemptId: msg.attemptId,
      });
      emitInfrastructureRetry();
      state.pendingAcks.delete(session.id);
      await requestAssignmentAfterHostEvent(state, fence?.connectionId);
      return {
        ok: true,
        applied: true,
        ...(code === "checkout_fetch_failed" && isFirstCheckoutFetchFailure(msg, session)
          ? { retryAccepted: true }
          : {}),
      };
    }
    const providerAccountId = session.resolvedRoute?.providerAccountId;
    if (requeue?.reason === "missing_account" && providerAccountId) {
      state.providerAccounts.delete(providerAccountId);
      const { hostAssignmentLease: _legacyHostAssignmentLease, ...providerLeaseOpts } =
        providerAccountLeaseWriteOpts(session);
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
        ...providerLeaseOpts,
        ...(session.hostAssignmentLease
          ? { hostAssignmentLease: session.hostAssignmentLease }
          : {}),
      });
      if (!requeued) return { ok: true };
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseScheduledLeaseLocal(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, {
        ...queueReconnectSession(session, "provider account missing; requeued"),
        errorCode: "usage_limit",
      });
      state.pendingAcks.delete(session.id);
      await requestAssignmentAfterHostEvent(state, fence?.connectionId);
      return { ok: true, applied: true };
    }
    if (requeue && cooldown && providerAccountId) {
      const now = state.now();
      const { hostAssignmentLease: _legacyHostAssignmentLease, ...providerLeaseOpts } =
        providerAccountLeaseWriteOpts(session);
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
        ...providerLeaseOpts,
        ...(session.hostAssignmentLease
          ? { hostAssignmentLease: session.hostAssignmentLease }
          : {}),
      });
      if (!requeued) return { ok: true };
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      emitCooldown();
      releaseScheduledLeaseLocal(state, session);
      releaseProviderAccountLease(state, session);
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
      await requestAssignmentAfterHostEvent(state, fence?.connectionId);
      return { ok: true, applied: true };
    }
    if (suppress && requeue?.reason === "providerless") {
      const committed = await storage.releaseMainCheckoutSession({
        sessionId: session.id,
        hostId: session.hostId,
        repositoryId: session.repositoryId,
        connectionId: session.assignmentConnectionId,
        attemptId: msg.attemptId,
        status: "queued",
        queueShard: session.queueShard,
        errorCode: "usage_limit",
        reason: msg.errorMessage ?? "providerless usage limit; trying fallback",
        suppressedTargetIndex: suppress.targetIndex,
        ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
        ...(msg.cliResumeRef ? { cliResumeRef: msg.cliResumeRef } : {}),
        ...providerAccountLeaseWriteOpts(session),
      });
      if (!committed) return { ok: true };
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseScheduledLeaseLocal(state, session);
      const { mainCheckoutLease: _, ...next } = {
        ...session,
        status: "queued" as const,
        worktreeId: null,
        hostId: null,
        errorCode: "usage_limit",
        suppressedTargetIndexes: [...(session.suppressedTargetIndexes ?? []), suppress.targetIndex],
        ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
        ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
        ...(msg.cliResumeRef ? { cliResumeRef: msg.cliResumeRef } : {}),
      };
      delete next.activeHostId;
      delete next.activeHostOrder;
      delete next.assignmentConnectionId;
      delete next.assignmentSentAt;
      delete next.ackReceivedAt;
      delete next.reconnectDeadlineAt;
      delete next.startedAt;
      delete next.result;
      delete next.sessionApiKeyHash;
      state.sessions.set(session.id, next);
      state.pendingAcks.delete(session.id);
      await requestAssignmentAfterHostEvent(state, fence?.connectionId);
      return { ok: true, applied: true };
    }
    const completedAt = finish?.completedAt ?? state.now();
    const terminalStatus = finish?.status ?? msg.status;
    const terminalErrorCode = finish?.errorCode ?? msg.errorCode;
    const terminalErrorMessage = finish?.errorMessage ?? msg.errorMessage;
    const deferredHandoff =
      msg.deferTerminalHookResult === true &&
      protocolVersion >= TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION &&
      msg.status === "failed" &&
      msg.errorCode === "checkout_fetch_failed" &&
      finish !== undefined
        ? deferredCheckoutFailureHandoff(state, session, msg)
        : undefined;
    const committed = await storage.releaseMainCheckoutSession({
      sessionId: session.id,
      hostId: session.hostId,
      repositoryId: session.repositoryId,
      connectionId: session.assignmentConnectionId,
      attemptId: msg.attemptId,
      status: terminalStatus,
      queueShard: session.queueShard,
      completedAt,
      ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
      ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
      ...(msg.cliResumeRef ? { cliResumeRef: msg.cliResumeRef } : {}),
      ...(reportedResult ? { result: reportedResult } : {}),
      ...(terminalErrorMessage ? { reason: terminalErrorMessage } : {}),
      ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
      ...providerAccountLeaseWriteOpts(session),
      ...(deferredHandoff ? { terminalHookHandoff: deferredHandoff } : {}),
    });
    if (!committed) return { ok: true };
    const committedDeferredHandoff = deferredHandoff
      ? await committedDeferredCheckoutFailureHandoff(state, session.id, deferredHandoff)
      : undefined;
    if (deferredHandoff && !committedDeferredHandoff) return { ok: true };
    await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
    releaseScheduledLeaseLocal(state, session);
    releaseProviderAccountLease(state, session);
    if (
      terminalErrorCode === "checkout_fetch_failed" &&
      (session.infrastructureRetryCount ?? 0) >= 1
    ) {
      emitInfrastructureRetryExhausted();
    }
    const { mainCheckoutLease: _, ...next } = {
      ...session,
      status: terminalStatus,
      worktreeId: null,
      completedAt,
      ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
      ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
      ...(terminalErrorMessage ? { errorMessage: terminalErrorMessage } : {}),
      ...(msg.cliResumeRef ? { cliResumeRef: msg.cliResumeRef } : {}),
      ...(reportedResult ? { result: reportedResult } : {}),
      ...(committedDeferredHandoff ? { terminalHookHandoff: committedDeferredHandoff } : {}),
    };
    delete next.assignmentConnectionId;
    delete next.assignmentSentAt;
    delete next.ackReceivedAt;
    delete next.reconnectDeadlineAt;
    state.sessions.set(session.id, next);
    state.pendingAcks.delete(session.id);
    if (!committedDeferredHandoff) await archiveSessionLogs(state, session.id, undefined, true);
    await requestAssignmentAfterHostEvent(state, fence?.connectionId);
    return {
      ok: true,
      applied: true,
      ...(isFirstCheckoutFetchFailure(msg, session) || committedDeferredHandoff
        ? { retryAccepted: false }
        : {}),
      ...(committedDeferredHandoff
        ? { terminalHookHandoffId: committedDeferredHandoff.handoffId }
        : {}),
      ...(committedDeferredHandoff &&
      protocolVersion >= TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION
        ? { terminalHookHandoffExpiresAt: committedDeferredHandoff.expiresAt }
        : {}),
    };
  }
  if (cooldown && requeue && (session.worktreeId || session.workspaceSlotId)) {
    const now = state.now();
    const committed = session.workspaceSlotId
      ? await storage.requeueUsageLimitedWorkspaceSession(
          requeueUsageLimitedWorkspaceSessionOptsFromPlan(session, plan, {
            now,
            attemptId: msg.attemptId,
            ...(msg.workspaceSlotError !== undefined
              ? { workspaceSlotError: msg.workspaceSlotError }
              : {}),
          }),
        )
      : await storage.requeueUsageLimitedSession(
          requeueUsageLimitedSessionOptsFromPlan(session, plan, { now, attemptId: msg.attemptId }),
        );
    if (!committed) return { ok: true };
    await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
    emitCooldown();
    releaseProviderAccountLease(state, session);
    const wt = session.worktreeId ? state.worktrees.get(session.worktreeId) : undefined;
    if (wt) state.worktrees.set(wt.id, { ...wt, status: "idle", currentSessionId: null });
    const slot = session.workspaceSlotId
      ? state.workspaceSlots.get(session.workspaceSlotId)
      : undefined;
    if (slot) {
      const { errorMessage: _errorMessage, ...cleanSlot } = slot;
      state.workspaceSlots.set(slot.id, {
        ...cleanSlot,
        status: msg.workspaceSlotError === undefined ? "idle" : "error",
        currentSessionId: null,
        ...(msg.workspaceSlotError === undefined ? {} : { errorMessage: msg.workspaceSlotError }),
      });
      await removeReleasedRetiredWorkspaceSlotDurable(state, slot.id);
    }
    if (loadedAccount) {
      state.providerAccounts.set(cooldown.providerAccountId, {
        ...loadedAccount,
        usageLimitedUntil: cooldown.usageLimitedUntil,
        lastUsageLimitedAt: now,
        updatedAt: now,
      });
    }
    state.sessions.set(session.id, {
      ...queueReconnectSession(session, msg.errorMessage ?? "provider usage limit; requeued"),
      errorCode: "usage_limit",
    });
    state.pendingAcks.delete(session.id);
    await requestAssignmentAfterHostEvent(state, fence?.connectionId);
    return { ok: true, applied: true };
  }
  if (requeue?.reason === "infrastructure" && session.worktreeId) {
    const code = requeue.errorCode as "checkout_fetch_failed" | "host_lost";
    const committed = await storage.tryRequeueSession({
      sessionId: session.id,
      worktreeId: session.worktreeId,
      attemptId: msg.attemptId,
      queueShard: session.queueShard,
      reason: requeue.errorMessage ?? "infrastructure retry",
      ...(fence ? { fence } : {}),
      ...providerAccountLeaseWriteOpts(session),
      infrastructureErrorCode: code,
    });
    if (!committed) return { ok: true };
    await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
    releaseProviderAccountLease(state, session);
    const wt = state.worktrees.get(session.worktreeId);
    if (wt) state.worktrees.set(wt.id, { ...wt, status: "idle", currentSessionId: null });
    state.sessions.set(session.id, {
      ...queueReconnectSession(session, requeue.errorMessage ?? "infrastructure retry"),
      infrastructureRetryCount: (session.infrastructureRetryCount ?? 0) + 1,
      lastInfrastructureErrorCode: code,
      infrastructureRetryAttemptId: msg.attemptId,
    });
    emitInfrastructureRetry();
    state.pendingAcks.delete(session.id);
    await requestAssignmentAfterHostEvent(state, fence?.connectionId);
    return {
      ok: true,
      applied: true,
      ...(code === "checkout_fetch_failed" && isFirstCheckoutFetchFailure(msg, session)
        ? { retryAccepted: true }
        : {}),
    };
  }
  const shouldSuppressTarget = suppress !== undefined;
  if (shouldSuppressTarget && (session.worktreeId || session.workspaceSlotId)) {
    const committed = session.workspaceSlotId
      ? await storage.suppressProviderlessUsageLimitWorkspace({
          sessionId: session.id,
          workspaceSlotId: session.workspaceSlotId,
          attemptId: msg.attemptId,
          queueShard: session.queueShard,
          targetIndex: suppress!.targetIndex,
          ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
          ...(msg.workspaceSlotError !== undefined
            ? { workspaceSlotError: msg.workspaceSlotError }
            : {}),
          ...(session.providerAccountLease
            ? { providerAccountLease: session.providerAccountLease }
            : {}),
          ...(session.hostAssignmentLease
            ? { hostAssignmentLease: session.hostAssignmentLease }
            : {}),
        })
      : await storage.suppressProviderlessUsageLimit(
          suppressProviderlessUsageLimitOptsFromPlan(session, plan, { attemptId: msg.attemptId }),
        );
    if (!committed) return { ok: true };
    await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
    releaseProviderAccountLease(state, session);
    const worktree = session.worktreeId ? state.worktrees.get(session.worktreeId) : undefined;
    if (worktree)
      state.worktrees.set(worktree.id, { ...worktree, status: "idle", currentSessionId: null });
    const slot = session.workspaceSlotId
      ? state.workspaceSlots.get(session.workspaceSlotId)
      : undefined;
    if (slot?.currentSessionId === session.id) {
      const { errorMessage: _errorMessage, ...cleanSlot } = slot;
      state.workspaceSlots.set(slot.id, {
        ...cleanSlot,
        status: msg.workspaceSlotError === undefined ? "idle" : "error",
        currentSessionId: null,
        ...(msg.workspaceSlotError === undefined ? {} : { errorMessage: msg.workspaceSlotError }),
      });
      await removeReleasedRetiredWorkspaceSlotDurable(state, slot.id);
    }
    state.sessions.set(session.id, {
      ...session,
      status: "queued",
      worktreeId: null,
      workspaceSlotId: null,
      hostId: null,
      suppressedTargetIndexes: [...(session.suppressedTargetIndexes ?? []), suppress.targetIndex],
    });
    const queued = state.sessions.get(session.id)!;
    delete queued.activeHostId;
    delete queued.activeHostOrder;
    delete queued.assignmentConnectionId;
    delete queued.assignmentSentAt;
    delete queued.ackReceivedAt;
    delete queued.startedAt;
    delete queued.workspaceSlotLease;
    delete queued.result;
    state.pendingAcks.delete(session.id);
    await requestAssignmentAfterHostEvent(state, fence?.connectionId);
    return { ok: true, applied: true };
  }
  const deferredHandoff =
    msg.deferTerminalHookResult === true &&
    protocolVersion >= TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION &&
    msg.status === "failed" &&
    msg.errorCode === "checkout_fetch_failed" &&
    finish !== undefined
      ? deferredCheckoutFailureHandoff(state, session, msg)
      : undefined;
  const committed = await storage.finishSession({
    ...finishSessionOptsFromPlan(session, plan, {
      attemptId: msg.attemptId,
      ...(fence ? { fence } : {}),
      ...(msg.workspaceSlotError ? { workspaceSlotError: msg.workspaceSlotError } : {}),
    }),
    ...(deferredHandoff ? { terminalHookHandoff: deferredHandoff } : {}),
  });
  if (!committed) return { ok: true };
  const committedDeferredHandoff = deferredHandoff
    ? await committedDeferredCheckoutFailureHandoff(state, session.id, deferredHandoff)
    : undefined;
  if (deferredHandoff && !committedDeferredHandoff) return { ok: true };
  if (
    finish?.errorCode === "checkout_fetch_failed" &&
    (session.infrastructureRetryCount ?? 0) >= 1
  ) {
    emitInfrastructureRetryExhausted();
  }
  await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
  releaseProviderAccountLease(state, session);
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
  const workspaceSlotId = session.workspaceSlotId;
  if (workspaceSlotId) {
    const slot = state.workspaceSlots.get(workspaceSlotId);
    if (slot?.currentSessionId === session.id) {
      state.workspaceSlots.set(workspaceSlotId, {
        ...slot,
        status: msg.workspaceSlotError ? "error" : "idle",
        currentSessionId: null,
        ...(msg.workspaceSlotError ? { errorMessage: msg.workspaceSlotError } : {}),
      });
    }
    await removeReleasedRetiredWorkspaceSlotDurable(state, workspaceSlotId);
  }
  const nextStatus = shouldSuppressTarget ? "queued" : (finish?.status ?? msg.status);
  const nextSession = {
    ...session,
    status: nextStatus,
    ...(shouldSuppressTarget ? {} : { completedAt: state.now() }),
    worktreeId: null,
    workspaceSlotId: null,
    hostId: null,
    ...(msg.exitCode !== undefined ? { exitCode: msg.exitCode } : {}),
    ...((finish?.errorCode ?? msg.errorCode) !== undefined
      ? { errorCode: finish?.errorCode ?? msg.errorCode }
      : {}),
    ...((finish?.errorMessage ?? msg.errorMessage) !== undefined
      ? { errorMessage: finish?.errorMessage ?? msg.errorMessage }
      : {}),
    ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
    ...(reportedResult !== undefined && !shouldSuppressTarget ? { result: reportedResult } : {}),
    ...(committedDeferredHandoff ? { terminalHookHandoff: committedDeferredHandoff } : {}),
    ...(shouldSuppressTarget && suppress
      ? {
          suppressedTargetIndexes: [
            ...(session.suppressedTargetIndexes ?? []),
            suppress.targetIndex,
          ],
        }
      : {}),
  };
  state.sessions.set(msg.sessionId, nextSession);
  state.pendingAcks.delete(msg.sessionId);
  if (!shouldSuppressTarget && !committedDeferredHandoff) {
    await archiveSessionLogs(state, msg.sessionId, undefined, true);
    noteSlackSessionLifecycle(state, nextSession);
  }
  await requestAssignmentAfterHostEvent(state, fence?.connectionId);
  return {
    ok: true,
    applied: true,
    ...(isFirstCheckoutFetchFailure(msg, session) || committedDeferredHandoff
      ? { retryAccepted: false }
      : {}),
    ...(committedDeferredHandoff
      ? { terminalHookHandoffId: committedDeferredHandoff.handoffId }
      : {}),
    ...(committedDeferredHandoff && protocolVersion >= TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION
      ? { terminalHookHandoffExpiresAt: committedDeferredHandoff.expiresAt }
      : {}),
  };
}

function applySessionStatus(
  state: ControlPlaneState,
  msg: Extract<HostToServerMessage, { type: "session:status" }>,
): { ok: boolean; error?: string; retryAccepted?: boolean | undefined } {
  const reportedResult = msg.result === undefined ? undefined : normalizeSessionResult(msg.result);
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
  const firstCheckoutFetchFailure = isFirstCheckoutFetchFailure(msg, session);
  if (
    session.status === "timed_out" &&
    isTerminalSessionStatus(msg.status) &&
    (session.providerAccountLease?.attemptId === msg.attemptId ||
      (!session.providerAccountLease &&
        session.timedOutHostId !== undefined &&
        session.attemptId === msg.attemptId))
  ) {
    releaseProviderAccountLease(state, session);
    if (reportedResult && session.result === undefined) session.result = reportedResult;
    delete session.timedOutHostId;
    delete session.timedOutAssignmentConnectionId;
    delete session.hostAssignmentLease;
    delete session.activeHostId;
    delete session.activeHostOrder;
    persistSession(state, session);
    return { ok: true };
  }
  const plan = planSessionTransition(
    session,
    hostStatusEvent(msg),
    plannerContext(state, "local", cachedProviderAccount(state, session)),
  );
  if (transitionEffect(plan, "ignore")) return { ok: true };

  const infrastructureRetry = transitionEffect(plan, "requeue");
  if (infrastructureRetry?.reason === "infrastructure") {
    const code = infrastructureRetry.errorCode as "checkout_fetch_failed" | "host_lost";
    const released = session.mainCheckoutLease
      ? releaseScheduledLeaseLocal(state, session)
      : session.worktreeId
        ? (releaseWorktree(state, session.worktreeId), true)
        : false;
    if (!released) return { ok: true };
    releaseProviderAccountLease(state, session);
    state.sessions.set(session.id, {
      ...queueReconnectSession(session, infrastructureRetry.errorMessage ?? "infrastructure retry"),
      infrastructureRetryCount: (session.infrastructureRetryCount ?? 0) + 1,
      lastInfrastructureErrorCode: code,
      infrastructureRetryAttemptId: msg.attemptId,
    });
    emitInfrastructureRetry();
    state.pendingAcks.delete(session.id);
    const reschedule = transitionEffect(plan, "reschedule");
    if (reschedule?.kind === "scheduled") {
      void assignScheduledQueuedDurable(state).catch(() => undefined);
    } else if (reschedule) {
      void assignQueued(state);
    }
    return {
      ok: true,
      ...(code === "checkout_fetch_failed" && firstCheckoutFetchFailure
        ? { retryAccepted: true }
        : {}),
    };
  }

  const terminal = isTerminalSessionStatus(msg.status);
  const patch = transitionEffect(plan, "patch_report");

  if (session.status !== "running") {
    if (
      transitionEffect(plan, "release_lease") ||
      transitionEffect(plan, "release_worktree") ||
      transitionEffect(plan, "release_workspace")
    ) {
      releaseProviderAccountLease(state, session);
    }
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
    if (transitionEffect(plan, "release_workspace")) {
      releaseWorkspaceSlotLocal(state, session, msg.workspaceSlotError);
    }
    if (patch?.cliResumeRef !== undefined) session.cliResumeRef = patch.cliResumeRef;
    if (patch?.result !== undefined && session.result === undefined) session.result = patch.result;
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
  if (reportedResult !== undefined && session.result === undefined) {
    session.result = reportedResult;
  }

  if (terminal) {
    session.completedAt = state.now();
    state.pendingAcks.delete(msg.sessionId);
    releaseProviderAccountLease(state, session);
    if (session.mainCheckoutLease) {
      delete session.mainCheckoutLease;
      delete session.assignmentConnectionId;
      delete session.assignmentSentAt;
      delete session.ackReceivedAt;
      delete session.reconnectDeadlineAt;
    } else if (transitionEffect(plan, "release_worktree") && session.worktreeId) {
      releaseWorktree(state, session.worktreeId);
    } else if (transitionEffect(plan, "release_workspace")) {
      releaseWorkspaceSlotLocal(state, session, msg.workspaceSlotError);
    }

    const cooldown = transitionEffect(plan, "cooldown");
    const requeue = transitionEffect(plan, "requeue");
    const suppress = transitionEffect(plan, "suppress_target");
    const finish = transitionEffect(plan, "finish");
    if (cooldown) {
      emitCooldown();
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
      delete session.result;
      const reschedule = transitionEffect(plan, "reschedule");
      if (reschedule?.kind === "scheduled") {
        void assignScheduledQueuedDurable(state).catch(() => undefined);
      } else if (reschedule?.kind === "workspace") {
        void assignWorkspaceQueuedDurable(state).catch(() => undefined);
      } else if (reschedule) {
        void assignQueued(state);
      }
    } else if (finish) {
      if (
        finish.errorCode === "checkout_fetch_failed" &&
        (session.infrastructureRetryCount ?? 0) >= 1
      ) {
        emitInfrastructureRetryExhausted();
      }
      if (finish.errorCode !== undefined) session.errorCode = finish.errorCode;
      if (finish.errorMessage !== undefined) session.errorMessage = finish.errorMessage;
      session.worktreeId = null;
      session.workspaceSlotId = null;
      // A continuation reference is single-use: a resumed command must report
      // a fresh one if it wants to support another native continuation.
      if (finish.clearResumeRef) {
        delete session.cliResumeRef;
      }
      queueSessionArchive(state, session.id);
    }
  }
  persistSession(state, session);
  return {
    ok: true,
    ...(firstCheckoutFetchFailure ? { retryAccepted: false } : {}),
  };
}
