import { isTerminalSessionStatus } from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type { ArchiveObject, PublicSession, WebhookDelivery } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, toPublic } from "./control-plane-state.ts";
import { persistTerminalSessionThenReleaseConcurrencyLock } from "./control-plane-concurrency-persistence.ts";
import {
  offlineHostAndRequeue,
  offlineHostAndRequeueDurable,
  releaseWorktree,
} from "./control-plane-worktrees.ts";

/**
 * Heartbeat-based stale reclaim (Phase 3): free worktrees of agents whose
 * heartbeat is older than heartbeatStaleMs — faster than full session timeout.
 * Also reclaims agents recorded in disconnectedHosts after disconnect/crash.
 * Marks ALL of the agent's worktrees offline (idle + busy) so assigns cannot
 * bind to a zombie agent.
 */
export function reclaimStaleHosts(state: ControlPlaneState, nowMs: number = Date.now()): string[] {
  const reclaimed: string[] = [];
  const candidates = new Map<string, { lastHeartbeatAt: string; connectionId?: string }>();

  for (const [hostId, connectionId] of state.hostConnection.entries()) {
    const conn = state.connections.get(connectionId);
    if (!conn) {
      state.hostConnection.delete(hostId);
      continue;
    }
    candidates.set(hostId, {
      lastHeartbeatAt: conn.lastHeartbeatAt,
      connectionId,
    });
  }
  for (const [hostId, rec] of state.disconnectedHosts.entries()) {
    if (!candidates.has(hostId)) {
      candidates.set(hostId, { lastHeartbeatAt: rec.lastHeartbeatAt });
    }
  }

  for (const [hostId, meta] of candidates) {
    const last = Date.parse(meta.lastHeartbeatAt);
    if (nowMs - last < state.heartbeatStaleMs) {
      continue;
    }
    const freed = offlineHostAndRequeue(state, hostId, "agent heartbeat stale; requeued");
    for (const sid of freed) {
      if (!reclaimed.includes(sid)) {
        reclaimed.push(sid);
      }
    }
    if (meta.connectionId) {
      state.connections.delete(meta.connectionId);
    }
    state.hostConnection.delete(hostId);
    state.disconnectedHosts.delete(hostId);
  }
  return reclaimed;
}

/** Durable stale recovery. Each host lease is released conditionally and each
 * running session is requeued with a transaction, so two API processes can
 * safely run the sweeper at the same time. */
export async function reclaimStaleHostsDurable(
  state: ControlPlaneState,
  nowMs: number = Date.now(),
): Promise<string[]> {
  if (!state.storage) {
    return reclaimStaleHosts(state, nowMs);
  }
  const reclaimed: string[] = [];
  const candidates = new Map<string, { lastHeartbeatAt: string; connectionId?: string }>();
  for (const [hostId, connectionId] of state.hostConnection.entries()) {
    const conn = state.connections.get(connectionId);
    if (conn) {
      candidates.set(hostId, { lastHeartbeatAt: conn.lastHeartbeatAt, connectionId });
    }
  }
  for (const [hostId, rec] of state.disconnectedHosts.entries()) {
    if (!candidates.has(hostId)) {
      candidates.set(hostId, { lastHeartbeatAt: rec.lastHeartbeatAt });
    }
  }
  for (const [hostId, meta] of candidates) {
    if (nowMs - Date.parse(meta.lastHeartbeatAt) < state.heartbeatStaleMs) {
      continue;
    }
    if (!meta.connectionId) continue;
    const freed = await offlineHostAndRequeueDurable(
      state,
      hostId,
      meta.connectionId,
      "agent heartbeat stale; requeued",
    );
    for (const sid of freed) {
      if (!reclaimed.includes(sid)) reclaimed.push(sid);
    }
    const released = await state.storage.releaseHostConnection(hostId, meta.connectionId);
    if (!released) {
      state.connections.delete(meta.connectionId);
      if (state.hostConnection.get(hostId) === meta.connectionId) {
        state.hostConnection.delete(hostId);
      }
      continue;
    }
    state.connections.delete(meta.connectionId);
    state.hostConnection.delete(hostId);
    state.disconnectedHosts.delete(hostId);
  }
  return reclaimed;
}

export async function archiveSessionLogs(
  state: ControlPlaneState,
  sessionId: string,
): Promise<ArchiveObject> {
  // Wait for any queued per-chunk writes, then archive the authoritative
  // durable history rather than the bounded process cache.
  const precedingWrites = [...state.pendingPersists];
  await Promise.all(precedingWrites);
  const logs = state.storage
    ? await state.storage.listLogs(sessionId)
    : [...(state.logs.get(sessionId) ?? [])];
  const body = logs
    .map(({ timestamp, stream, content }) => JSON.stringify({ timestamp, stream, content }))
    .join("\n");
  const obj: ArchiveObject = {
    key: `${state.archivePrefix}${sessionId}/logs.jsonl`,
    body: body ? `${body}\n` : "",
    contentType: "application/x-ndjson",
  };
  if (state.archiveWriter) {
    await state.archiveWriter.putArchive(obj);
  }
  if (state.storage) await state.storage.putArchive(obj);
  state.archives.set(obj.key, obj);
  return obj;
}

export function queueSessionArchive(state: ControlPlaneState, sessionId: string): void {
  state.pendingPersists.push(archiveSessionLogs(state, sessionId));
}

export function getArchive(state: ControlPlaneState, sessionId: string): ArchiveObject | null {
  const key = `${state.archivePrefix}${sessionId}/logs.jsonl`;
  if (!state.archives.has(key)) {
    return null;
  }
  return state.archives.get(key)!;
}

export function listArchives(state: ControlPlaneState): ArchiveObject[] {
  return [...state.archives.values()];
}

export function maybeDeliverWebhook(state: ControlPlaneState, session: SessionRecord): void {
  if (!state.webhookUrl) {
    return;
  }
  const payload = JSON.stringify({
    sessionId: session.id,
    status: session.status,
    errorCode: session.errorCode ?? null,
    url: `${state.publicBaseUrl}/sessions/${session.id}`,
  });
  state.webhookDeliveries.push({
    url: state.webhookUrl,
    sessionId: session.id,
    status: session.status,
    deliveredAt: state.now(),
    payload,
  });
}

export function listWebhookDeliveries(state: ControlPlaneState): WebhookDelivery[] {
  return [...state.webhookDeliveries];
}

/** Cancel a non-terminal session; running holds worktree until late terminal. */
export function cancelSession(
  state: ControlPlaneState,
  id: string,
): { ok: true; session: PublicSession } | { ok: false; error: string } {
  const session = state.sessions.get(id);
  if (!session) {
    return { ok: false, error: "session not found" };
  }
  if (isTerminalSessionStatus(session.status)) {
    return { ok: false, error: `session already terminal: ${session.status}` };
  }
  state.pendingAcks.delete(id);
  const wasRunning = session.status === "running";
  const hostId = session.hostId;
  const worktreeId = session.worktreeId;
  session.status = "cancelled";
  session.errorMessage = "cancelled by operator";
  session.completedAt = state.now();
  if (wasRunning && hostId) {
    state.onHostMessage?.(hostId, { type: "session:cancel", sessionId: id });
    persistSession(state, session);
    return { ok: true, session: toPublic(state, session) };
  }
  if (worktreeId) {
    releaseWorktree(state, worktreeId);
  }
  session.worktreeId = null;
  session.hostId = null;
  const storage = state.storage;
  if (session.concurrencyId && storage) {
    persistTerminalSessionThenReleaseConcurrencyLock(
      state,
      session,
      session.concurrencyId,
      storage,
    );
  } else {
    persistSession(state, session);
  }
  return { ok: true, session: toPublic(state, session) };
}
