import type { SessionRecord } from "./db/types.ts";
import type { ArchiveObject, PublicSession, WebhookDelivery } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, queueWrite, toPublic } from "./control-plane-state.ts";
import { offlineAgentAndRequeue, releaseWorktree } from "./control-plane-worktrees.ts";

/**
 * Heartbeat-based stale reclaim (Phase 3): free worktrees of agents whose
 * heartbeat is older than heartbeatStaleMs — faster than full session timeout.
 * Also reclaims agents recorded in disconnectedAgents after disconnect/crash.
 * Marks ALL of the agent's worktrees offline (idle + busy) so assigns cannot
 * bind to a zombie agent.
 */
export function reclaimStaleAgents(state: ControlPlaneState, nowMs: number = Date.now()): string[] {
  const reclaimed: string[] = [];
  const candidates = new Map<string, { lastHeartbeatAt: string; connectionId?: string }>();

  for (const [agentId, connectionId] of state.agentConnection.entries()) {
    const conn = state.connections.get(connectionId);
    if (!conn) {
      state.agentConnection.delete(agentId);
      continue;
    }
    candidates.set(agentId, {
      lastHeartbeatAt: conn.lastHeartbeatAt,
      connectionId,
    });
  }
  for (const [agentId, rec] of state.disconnectedAgents.entries()) {
    if (!candidates.has(agentId)) {
      candidates.set(agentId, { lastHeartbeatAt: rec.lastHeartbeatAt });
    }
  }

  for (const [agentId, meta] of candidates) {
    const last = Date.parse(meta.lastHeartbeatAt);
    if (nowMs - last < state.heartbeatStaleMs) {
      continue;
    }
    const freed = offlineAgentAndRequeue(state, agentId, "agent heartbeat stale; requeued");
    for (const sid of freed) {
      if (!reclaimed.includes(sid)) {
        reclaimed.push(sid);
      }
    }
    if (meta.connectionId) {
      state.connections.delete(meta.connectionId);
    }
    state.agentConnection.delete(agentId);
    state.disconnectedAgents.delete(agentId);
  }
  return reclaimed;
}

export function archiveSessionLogs(
  state: ControlPlaneState,
  sessionId: string,
): ArchiveObject | null {
  const logs = [...(state.logs.get(sessionId) ?? [])];
  if (logs.length === 0) {
    const empty: ArchiveObject = {
      key: `${state.archivePrefix}${sessionId}.json`,
      body: "[]",
      contentType: "application/json",
    };
    state.archives.set(empty.key, empty);
    if (state.storage) {
      queueWrite(state, state.storage.putArchive(empty));
    }
    return empty;
  }
  const body = JSON.stringify(logs);
  const obj: ArchiveObject = {
    key: `${state.archivePrefix}${sessionId}.json`,
    body,
    contentType: "application/json",
  };
  state.archives.set(obj.key, obj);
  if (state.storage) {
    queueWrite(state, state.storage.putArchive(obj));
  }
  return obj;
}

export function getArchive(state: ControlPlaneState, sessionId: string): ArchiveObject | null {
  const key = `${state.archivePrefix}${sessionId}.json`;
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
  if (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "cancelled" ||
    session.status === "timed_out"
  ) {
    return { ok: false, error: `session already terminal: ${session.status}` };
  }
  state.pendingAcks.delete(id);
  const wasRunning = session.status === "running";
  const agentId = session.agentId;
  const worktreeId = session.worktreeId;
  session.status = "cancelled";
  session.errorMessage = "cancelled by operator";
  session.completedAt = state.now();
  if (wasRunning && agentId) {
    state.onAgentMessage?.(agentId, { type: "session:cancel", sessionId: id });
    persistSession(state, session);
    return { ok: true, session: toPublic(state, session) };
  }
  if (worktreeId) {
    releaseWorktree(state, worktreeId);
  }
  session.worktreeId = null;
  session.agentId = null;
  persistSession(state, session);
  return { ok: true, session: toPublic(state, session) };
}
